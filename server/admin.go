package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"
)

type command struct {
	Action      string   `json:"action"`
	Username    string   `json:"username,omitempty"`
	NewUsername string   `json:"newUsername,omitempty"`
	Name        *string  `json:"name,omitempty"`
	Bio         *string  `json:"bio,omitempty"`
	Password    string   `json:"password,omitempty"`
	Channel     *channel `json:"channel,omitempty"`
}

func (s *service) serveAdmin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/admin" {
		failure(w, http.StatusNotFound, "not_found")
		return
	}
	var cmd command
	if !readBody(w, r, &cmd) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.admin(cmd)
	if err != nil {
		response(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	response(w, http.StatusOK, result)
}

func (s *service) admin(cmd command) (any, error) {
	switch cmd.Action {
	case "status":
		return map[string]any{
			"workspace": s.state.Workspace, "accounts": len(s.state.Accounts), "channels": s.channels(),
			"activeSessions": len(s.sessions), "voiceSlots": len(s.leases), "voiceCapacity": capacity,
			"regionDataset": s.geo.Month, "ipv4Ranges": len(s.geo.V4), "ipv6Ranges": len(s.geo.V6),
			"ownerConfigured": s.ownerName != "", "ownerAssigned": s.ownerName != "" && s.state.Accounts[s.ownerName].Enabled,
			"clientUpdates": s.updates != nil,
		}, nil
	case "account.list":
		type item struct {
			memberIdentity
			Enabled bool `json:"enabled"`
		}
		list := make([]item, 0, len(s.state.Accounts))
		for _, a := range s.state.Accounts {
			list = append(list, item{memberIdentity: s.identity(a), Enabled: a.Enabled})
		}
		slices.SortFunc(list, func(a, b item) int { return strings.Compare(a.Username, b.Username) })
		return list, nil
	case "workspace.rename", "channel.set", "channel.delete":
		return s.adminWorkspace(cmd)
	case "account.add", "account.edit", "account.enable", "account.disable", "account.passwd", "account.delete", "account.admin", "account.member":
		return s.adminAccount(cmd)
	default:
		return nil, errors.New("unknown administration command")
	}
}

func (s *service) adminWorkspace(cmd command) (any, error) {
	next := s.state.copy()
	var disconnect string
	switch cmd.Action {
	case "workspace.rename":
		if cmd.Name == nil || !validText(*cmd.Name, 64, false) {
			return nil, errors.New("workspace name must contain 1–64 characters")
		}
		next.Workspace = *cmd.Name
	case "channel.set":
		if cmd.Channel == nil || !validChannel(*cmd.Channel) {
			return nil, errors.New("invalid channel or capacity (1–5)")
		}
		id := cmd.Channel.ID
		if previous, ok := next.Channels[id]; ok && previous.Capacity != cmd.Channel.Capacity {
			disconnect = id
		} else if !ok && len(next.Channels) >= 30 {
			return nil, errors.New("at most 30 channels are supported")
		} else if !ok && s.chat != nil {
			// A reused room ID cannot expose chat from a failed prior cleanup.
			if err := s.chat.deleteChannel(id); err != nil {
				return nil, errors.New("could not prepare channel history")
			}
		}
		next.Channels[id] = *cmd.Channel
	case "channel.delete":
		if cmd.Channel == nil {
			return nil, errMissing
		}
		id := cmd.Channel.ID
		if _, exists := next.Channels[id]; !exists {
			return nil, errMissing
		}
		delete(next.Channels, id)
		delete(next.RoomRules, id)
		disconnect = id
	}
	if err := s.commit(next); err != nil {
		return nil, errors.New("could not save configuration")
	}
	if disconnect != "" {
		s.remove(s.cut(func(l *lease) bool { return l.Channel == disconnect }))
	}
	if cmd.Action == "channel.delete" && s.chat != nil {
		if err := s.chat.deleteChannel(disconnect); err != nil {
			return nil, errors.New("channel removed; chat cleanup will retry on startup")
		}
	}
	return map[string]any{"workspace": next.Workspace, "channels": s.channels()}, nil
}

func (s *service) adminAccount(cmd command) (any, error) {
	name := strings.ToLower(cmd.Username)
	if !accountName.MatchString(name) {
		return nil, errors.New("username must contain 3–32 ASCII letters, digits, dots, underscores or hyphens")
	}
	next := s.state.copy()
	a, exists := next.Accounts[name]
	if exists && s.globalRole(a) == roleOwner && (cmd.Action == "account.admin" || cmd.Action == "account.member" ||
		cmd.Action == "account.delete" || cmd.Action == "account.disable" || (cmd.NewUsername != "" && strings.ToLower(cmd.NewUsername) != name)) {
		return nil, errors.New("the container owner account is locked to SQUADVOICE_OWNER")
	}
	if cmd.Action == "account.add" {
		if exists {
			return nil, errors.New("account already exists")
		}
		if cmd.Name == nil {
			return nil, errors.New("display name is required")
		}
		if !validPassword(cmd.Password) {
			return nil, errors.New(passwordRequirements)
		}
		a = account{user: user{ID: "u_" + randomToken(12), Username: name}, Enabled: true, Password: hashPassword(cmd.Password)}
	} else if !exists {
		return nil, errMissing
	}
	if cmd.Name != nil {
		if !validText(*cmd.Name, 64, false) {
			return nil, errors.New("display name must contain 1–64 characters")
		}
		a.Name = *cmd.Name
	}
	if cmd.Bio != nil {
		if !validText(*cmd.Bio, 160, true) {
			return nil, errors.New("bio must contain at most 160 characters")
		}
		a.Bio = *cmd.Bio
	}
	revoke := false
	switch cmd.Action {
	case "account.admin":
		a.Admin = true
	case "account.member":
		a.Admin = false
	case "account.enable":
		a.Enabled = true
	case "account.disable":
		a.Enabled, revoke = false, true
	case "account.passwd":
		if !validPassword(cmd.Password) {
			return nil, errors.New(passwordRequirements)
		}
		a.Password, revoke = hashPassword(cmd.Password), true
	case "account.delete":
		revoke = true
		for channel := range next.RoomRules {
			next.setRoomRules(channel, a.ID, roomRules{})
		}
	case "account.edit":
		if newName := strings.ToLower(cmd.NewUsername); newName != "" && newName != name {
			if !accountName.MatchString(newName) {
				return nil, errors.New("invalid new username")
			}
			if _, exists := next.Accounts[newName]; exists {
				return nil, errors.New("new username is already in use")
			}
			a.Username, revoke = newName, true
		}
	}
	delete(next.Accounts, name)
	if cmd.Action != "account.delete" {
		next.Accounts[a.Username] = a
	}
	if err := s.commit(next); err != nil {
		return nil, errors.New("could not save account")
	}
	if revoke {
		delete(s.attempts, "user:"+a.ID)
		delete(s.attempts, "password:"+a.ID)
		s.remove(s.revoke(a.ID))
	}
	identity := s.identity(a)
	return map[string]any{"username": a.Username, "enabled": a.Enabled && cmd.Action != "account.delete", "admin": identity.Admin, "role": identity.Role, "action": cmd.Action}, nil
}

const usage = `Usage:
  squadvoice admin status
  squadvoice admin account list
  squadvoice admin account add USER "Display name"
  squadvoice admin account edit USER username|name|bio VALUE
  squadvoice admin account enable|disable|passwd|delete USER
  squadvoice admin account admin|member USER
  squadvoice admin workspace rename "Workspace name"
  squadvoice admin channel set ID "Channel name" [CAPACITY [DESCRIPTION]]
  squadvoice admin channel delete ID

Passwords are entered on a hidden terminal prompt. For automation, pipe one
password line to admin --password-stdin account add|passwd; never use arguments
or environment variables to pass a password.
`

func parseAdmin(args []string, stdin bool) (command, error) {
	bad := errors.New(usage)
	if len(args) == 1 && args[0] == "status" {
		return command{Action: "status"}, nil
	}
	if len(args) < 2 {
		return command{}, bad
	}
	cmd := command{Action: args[0] + "." + args[1]}
	switch cmd.Action {
	case "account.list":
		if len(args) != 2 {
			return cmd, bad
		}
	case "account.add", "account.passwd":
		if (cmd.Action == "account.add" && len(args) != 4) || (cmd.Action == "account.passwd" && len(args) != 3) {
			return cmd, bad
		}
		cmd.Username = args[2]
		if len(args) == 4 {
			cmd.Name = &args[3]
		}
		var err error
		cmd.Password, err = readPassword(stdin)
		if err != nil {
			return cmd, err
		}
	case "account.edit":
		if len(args) != 5 {
			return cmd, bad
		}
		cmd.Username = args[2]
		switch args[3] {
		case "username":
			cmd.NewUsername = args[4]
		case "name":
			cmd.Name = &args[4]
		case "bio":
			cmd.Bio = &args[4]
		default:
			return cmd, bad
		}
	case "account.enable", "account.disable", "account.delete", "account.admin", "account.member":
		if len(args) != 3 {
			return cmd, bad
		}
		cmd.Username = args[2]
	case "workspace.rename":
		if len(args) != 3 {
			return cmd, bad
		}
		cmd.Name = &args[2]
	case "channel.set":
		if len(args) < 4 || len(args) > 6 {
			return cmd, bad
		}
		ch := channel{ID: args[2], Name: args[3], Capacity: capacity}
		if len(args) >= 5 {
			var err error
			ch.Capacity, err = strconv.Atoi(args[4])
			if err != nil {
				return cmd, bad
			}
		}
		if len(args) == 6 {
			ch.Description = args[5]
		}
		cmd.Channel = &ch
	case "channel.delete":
		if len(args) != 3 {
			return cmd, bad
		}
		cmd.Channel = &channel{ID: args[2]}
	default:
		return cmd, bad
	}
	return cmd, nil
}

func readPassword(stdin bool) (string, error) {
	if stdin {
		value, err := bufio.NewReader(io.LimitReader(os.Stdin, 1024)).ReadString('\n')
		if err != nil && err != io.EOF {
			return "", err
		}
		return strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r"), nil
	}
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", errors.New("use a terminal for hidden password entry")
	}
	fmt.Fprint(os.Stderr, "Password: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	defer clear(first)
	fmt.Fprint(os.Stderr, "Repeat password: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	defer clear(second)
	if err != nil || !bytes.Equal(first, second) {
		return "", errors.New("passwords do not match")
	}
	return string(first), nil
}

func adminCLI(args []string) error {
	flags := flag.NewFlagSet("admin", flag.ContinueOnError)
	socket := flags.String("socket", adminSocket, "private administration socket")
	stdin := flags.Bool("password-stdin", false, "read password from stdin")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cmd, err := parseAdmin(flags.Args(), *stdin)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	defer clear(payload)
	client := &http.Client{
		Timeout: 25 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", *socket)
		}},
	}
	resp, err := client.Post("http://squadvoice/admin", "application/json", bytes.NewReader(payload))
	if err != nil {
		return errors.New("could not connect to the private administration socket")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var answer struct{ Error string }
		if json.NewDecoder(resp.Body).Decode(&answer) == nil && answer.Error != "" {
			return errors.New(answer.Error)
		}
		return errors.New("administration request failed")
	}
	var value any
	if err := json.NewDecoder(resp.Body).Decode(&value); err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	out.SetIndent("", "  ")
	return out.Encode(value)
}
