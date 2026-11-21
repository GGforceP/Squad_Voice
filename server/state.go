package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const capacity = 5

var accountName = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{2,31}$`)
var channelID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,47}$`)
var errMissing = errors.New("entry does not exist")

type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Name     string `json:"name"`
	Bio      string `json:"bio"`
	Admin    bool   `json:"admin,omitempty"`
}

type account struct {
	user
	Enabled  bool   `json:"enabled"`
	Password string `json:"passwordHash"`
}

type channel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Capacity    int    `json:"capacity"`
}

type state struct {
	Version   int                             `json:"version"`
	Workspace string                          `json:"workspace"`
	Accounts  map[string]account              `json:"accounts"`
	Channels  map[string]channel              `json:"channels"`
	RoomRules map[string]map[string]roomRules `json:"roomRules,omitempty"`
}

func loadState(path string) (state, error) {
	var s state
	err := readFile(path, &s)
	if errors.Is(err, os.ErrNotExist) {
		s = state{
			Version: 1, Workspace: "Squad Voice",
			Accounts: map[string]account{},
			Channels: map[string]channel{
				"voice-lobby": {ID: "voice-lobby", Name: "开黑大厅", Description: "语音与伴奏", Capacity: capacity},
			},
		}
		return s, writeFile(path, s, 0600)
	}
	if err != nil {
		return s, err
	}
	if s.Version != 1 || s.Accounts == nil || s.Channels == nil || !validText(s.Workspace, 64, false) {
		return s, errors.New("invalid account state")
	}
	ids := make(map[string]bool)
	for name, a := range s.Accounts {
		if a.Username != name || !accountName.MatchString(name) || a.ID == "" || ids[a.ID] ||
			!validText(a.Name, 64, false) || !validText(a.Bio, 160, true) || !validHash(a.Password) {
			return s, errors.New("invalid account in state")
		}
		ids[a.ID] = true
	}
	for id, ch := range s.Channels {
		if ch.ID != id || !validChannel(ch) {
			return s, errors.New("invalid channel in state")
		}
	}
	for channel, users := range s.RoomRules {
		if _, ok := s.Channels[channel]; !ok {
			return s, errors.New("unknown channel in room rules")
		}
		for id, rules := range users {
			if !ids[id] || rules.Listen < 0 || rules.Mic < 0 || rules.Chat < 0 {
				return s, errors.New("invalid member in room rules")
			}
		}
	}
	return s, nil
}

func (s state) copy() state {
	s.Accounts = maps.Clone(s.Accounts)
	s.Channels = maps.Clone(s.Channels)
	s.RoomRules = maps.Clone(s.RoomRules)
	return s
}

func validChannel(ch channel) bool {
	return channelID.MatchString(ch.ID) && validText(ch.Name, 64, false) &&
		validText(ch.Description, 180, true) && ch.Capacity >= 1 && ch.Capacity <= capacity
}

func validText(value string, max int, empty bool) bool {
	if !utf8.ValidString(value) || len(utf16.Encode([]rune(value))) > max || (!empty && strings.TrimSpace(value) == "") {
		return false
	}
	return !strings.ContainsFunc(value, func(r rune) bool {
		return unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
	})
}

const passwordRequirements = "password must have 9 to 128 characters and use at least two of uppercase letters, lowercase letters, digits and symbols"

func validPassword(password string) bool {
	count := utf8.RuneCountInString(password)
	if !utf8.ValidString(password) || count < 9 || count > 128 ||
		strings.ContainsAny(password, "\r\n\x00") {
		return false
	}
	var upper, lower, digit, symbol bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsLower(r):
			lower = true
		case unicode.IsDigit(r):
			digit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			symbol = true
		}
	}
	classes := 0
	for _, used := range []bool{upper, lower, digit, symbol} {
		if used {
			classes++
		}
	}
	return classes >= 2
}

func randomToken(size int) string {
	value := make([]byte, size)
	rand.Read(value)
	return base64.RawURLEncoding.EncodeToString(value)
}

func hashPassword(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	hash := argon2.IDKey([]byte(password), salt, 3, 32*1024, 1, 32)
	return "argon2id$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(hash)
}

func hashParts(encoded string) ([]byte, []byte) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 3 || parts[0] != "argon2id" {
		return nil, nil
	}
	salt, saltErr := base64.RawStdEncoding.DecodeString(parts[1])
	hash, hashErr := base64.RawStdEncoding.DecodeString(parts[2])
	if saltErr != nil || hashErr != nil || len(salt) != 16 || len(hash) != 32 {
		return nil, nil
	}
	return salt, hash
}

func validHash(encoded string) bool {
	salt, _ := hashParts(encoded)
	return salt != nil
}

func checkPassword(encoded, password string) bool {
	salt, hash := hashParts(encoded)
	if salt == nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 3, 32*1024, 1, 32)
	return subtle.ConstantTimeCompare(hash, got) == 1
}

type tokenKey = [sha256.Size]byte

func digest(token string) tokenKey { return sha256.Sum256([]byte(token)) }

func decode(r io.Reader, out any) error {
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("expected one JSON document")
	}
	return nil
}

func readFile(path string, out any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := decode(f, out); err != nil {
		return fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return nil
}

func writeFile(path string, value any, mode os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".squadvoice-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	if runtime.GOOS == "linux" {
		// The rename has committed. A directory fsync improves crash durability.
		if d, err := os.Open(dir); err == nil {
			_ = d.Sync()
			_ = d.Close()
		}
	}
	return nil
}
