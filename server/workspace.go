package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

type voiceMember struct {
	ID     string    `json:"id"`
	UserID string    `json:"userId,omitempty"`
	Name   string    `json:"name"`
	Mic    bool      `json:"mic"`
	Music  bool      `json:"music"`
	Role   role      `json:"role,omitempty"`
	Rules  roomRules `json:"rules"`
}

type directoryMember struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Role            role     `json:"role"`
	Online          bool     `json:"online"`
	ManagedChannels []string `json:"managedChannels,omitempty"`
	Conversation    string   `json:"conversationId,omitempty"`
}

type presenceEntry struct {
	members []voiceMember
	until   time.Time
}

type presenceCache struct {
	mu    sync.Mutex
	rooms map[string]presenceEntry
}

func (p *presenceCache) list(ctx context.Context, m *media, room string) ([]voiceMember, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rooms == nil {
		p.rooms = make(map[string]presenceEntry)
	}
	now := time.Now()
	for name, entry := range p.rooms {
		if now.Sub(entry.until) > time.Minute {
			delete(p.rooms, name)
		}
	}
	if entry := p.rooms[room]; now.Before(entry.until) {
		return entry.members, nil
	}
	members, err := m.participants(ctx, room)
	if err == nil {
		p.rooms[room] = presenceEntry{members: members, until: now.Add(1200 * time.Millisecond)}
	}
	return members, err
}

func (m *media) participants(ctx context.Context, room string) ([]voiceMember, error) {
	reply := struct {
		Participants []struct {
			Identity string
			Name     string
			State    json.RawMessage
			Tracks   []struct {
				Source json.RawMessage
				Muted  bool
			}
		}
	}{}
	err := m.call(ctx, "ListParticipants", mediaGrant{Room: room, RoomAdmin: true}, map[string]string{"room": room}, &reply)
	if err != nil {
		return nil, err
	}
	members := make([]voiceMember, 0, len(reply.Participants))
	for _, participant := range reply.Participants {
		if string(participant.State) != `"ACTIVE"` && string(participant.State) != "2" {
			continue
		}
		user := voiceMember{ID: participant.Identity, Name: participant.Name}
		for _, track := range participant.Tracks {
			if track.Muted {
				continue
			}
			switch string(track.Source) {
			case `"MICROPHONE"`, "2":
				user.Mic = true
			case `"SCREEN_SHARE_AUDIO"`, "4":
				user.Music = true
			}
		}
		members = append(members, user)
	}
	return members, nil
}

func (s *service) authenticated(key tokenKey) (session, account, bool) {
	current, exists := s.sessions[key]
	if !exists || !time.Now().Before(current.Expires) {
		return session{}, account{}, false
	}
	_, member := s.accountByID(current.UserID)
	return current, member, member.Enabled
}

func (s *service) workspace(w http.ResponseWriter, r *http.Request, key tokenKey) {
	type activeRoom struct {
		room    string
		members map[string]voiceMember
	}
	s.mu.Lock()
	_, member, authorized := s.authenticated(key)
	if !authorized {
		s.mu.Unlock()
		failure(w, http.StatusUnauthorized, "session_expired")
		return
	}
	rooms := make(map[string]activeRoom)
	for _, voice := range s.leases {
		if voice.Cancel == nil {
			continue
		}
		group, exists := rooms[voice.Channel]
		if !exists {
			group = activeRoom{room: voice.Room, members: make(map[string]voiceMember)}
			rooms[voice.Channel] = group
		}
		_, user := s.accountByID(voice.UserID)
		group.members[voice.Identity] = voiceMember{UserID: user.ID, Name: user.Name, Role: s.channelRole(user, voice.Channel), Rules: s.rules(voice.Channel, user.ID)}
	}
	workspace, channels, groups := s.state.Workspace, s.channels(), s.groups()
	managed, rank := s.managedChannels(member), s.globalRole(member)
	directory := s.directory(member)
	s.mu.Unlock()

	presence := make(map[string][]voiceMember, len(rooms))
	unavailable := []string{}
	for channelID, group := range rooms {
		active, err := s.presence.list(r.Context(), s.media, group.room)
		if err != nil {
			unavailable = append(unavailable, channelID)
			continue
		}
		visible := make([]voiceMember, 0, len(active))
		for _, user := range active {
			if metadata, exists := group.members[user.ID]; exists {
				user.UserID, user.Name, user.Role, user.Rules = metadata.UserID, metadata.Name, metadata.Role, metadata.Rules
				visible = append(visible, user)
			}
		}
		presence[channelID] = visible
	}
	response(w, http.StatusOK, map[string]any{
		"name": workspace, "admin": rank != roleMember, "role": rank, "managedChannels": managed, "channels": channels,
		"groups": groups, "people": directory,
		"presence": presence, "presenceUnavailable": unavailable,
	})
}

func (s *service) groups() []channelGroup {
	groups := make([]channelGroup, 0, len(s.state.Groups))
	for _, group := range s.state.Groups {
		groups = append(groups, group)
	}
	slices.SortFunc(groups, func(a, b channelGroup) int { return strings.Compare(a.ID, b.ID) })
	return groups
}

// Called under the service lock with an authenticated directory reader.
func (s *service) directory(reader account) []directoryMember {
	online := make(map[string]bool, len(s.sessions))
	now := time.Now()
	for _, session := range s.sessions {
		if now.Before(session.Expires) {
			online[session.UserID] = true
		}
	}
	people := make([]directoryMember, 0, len(s.state.Accounts))
	for _, member := range s.state.Accounts {
		if !member.Enabled {
			continue
		}
		person := directoryMember{ID: member.ID, Name: member.Name, Role: s.globalRole(member), Online: online[member.ID]}
		if person.Role == roleMember {
			person.ManagedChannels = s.managedChannels(member)
		}
		if person.ID != reader.ID {
			person.Conversation = directChatID(reader.ID, person.ID)
		}
		people = append(people, person)
	}
	slices.SortFunc(people, func(a, b directoryMember) int {
		if order := strings.Compare(a.Name, b.Name); order != 0 {
			return order
		}
		return strings.Compare(a.ID, b.ID)
	})
	return people
}

func (s *service) groupCommand(w http.ResponseWriter, r *http.Request, member account) {
	if s.globalRole(member) == roleMember {
		failure(w, http.StatusForbidden, "admin_required")
		return
	}
	var value channelGroup
	if !readBody(w, r, &value) {
		return
	}
	value.Name = strings.TrimSpace(value.Name)
	action := "group.set"
	switch r.URL.Path {
	case "/api/v1/group/create":
		value.ID = "group-" + strings.ToLower(randomToken(9))
		if _, exists := s.state.Groups[value.ID]; exists {
			failure(w, http.StatusConflict, "group_update_failed")
			return
		}
	case "/api/v1/group/delete":
		action = "group.delete"
		fallthrough
	default:
		if _, exists := s.state.Groups[value.ID]; !exists {
			failure(w, http.StatusNotFound, "group_not_found")
			return
		}
	}
	result, err := s.adminWorkspace(command{Action: action, Group: &value})
	if err != nil {
		failure(w, http.StatusBadRequest, "group_update_failed")
		return
	}
	response(w, http.StatusOK, result)
}

func (s *service) channelCommand(w http.ResponseWriter, r *http.Request, member account) {
	var value channel
	if !readBody(w, r, &value) {
		return
	}
	action := "channel.set"
	var grant string
	global := s.globalRole(member) != roleMember
	switch r.URL.Path {
	case "/api/v1/channel/delete":
		action = "channel.delete"
	case "/api/v1/channel/create":
		if !global {
			if !slices.ContainsFunc(s.channels(), func(room channel) bool {
				return room.GroupID == value.GroupID && s.rules(room.ID, member.ID).Admin
			}) {
				failure(w, http.StatusForbidden, "admin_required")
				return
			}
			grant = member.ID
		}
		value.ID = "voice-" + strings.ToLower(randomToken(9))
		if _, exists := s.state.Channels[value.ID]; exists {
			failure(w, http.StatusConflict, "channel_update_failed")
			return
		}
	default:
		previous, exists := s.state.Channels[value.ID]
		if !exists {
			failure(w, http.StatusNotFound, "channel_not_found")
			return
		}
		if !global && value.GroupID != "" && value.GroupID != previous.GroupID {
			failure(w, http.StatusForbidden, "admin_required")
			return
		}
	}
	if r.URL.Path != "/api/v1/channel/create" && s.channelRole(member, value.ID) == roleMember {
		failure(w, http.StatusForbidden, "admin_required")
		return
	}
	if action != "channel.delete" {
		value.Name = strings.TrimSpace(value.Name)
		value.Description = strings.TrimSpace(value.Description)
	}
	result, err := s.adminWorkspace(command{Action: action, Channel: &value, grantChannelAdmin: grant})
	switch {
	case errors.Is(err, errMissing):
		failure(w, http.StatusNotFound, "channel_not_found")
	case err != nil:
		failure(w, http.StatusBadRequest, "channel_update_failed")
	default:
		response(w, http.StatusOK, result)
	}
}
