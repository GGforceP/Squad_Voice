package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

type voiceMember struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Mic   bool      `json:"mic"`
	Music bool      `json:"music"`
	Role  role      `json:"role,omitempty"`
	Rules roomRules `json:"rules"`
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
		group.members[voice.Identity] = voiceMember{Name: user.Name, Role: s.channelRole(user, voice.Channel), Rules: s.rules(voice.Channel, user.ID)}
	}
	workspace, channels := s.state.Workspace, s.channels()
	managed, rank := s.managedChannels(member), s.globalRole(member)
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
				user.Name, user.Role, user.Rules = metadata.Name, metadata.Role, metadata.Rules
				visible = append(visible, user)
			}
		}
		presence[channelID] = visible
	}
	response(w, http.StatusOK, map[string]any{
		"name": workspace, "admin": rank != roleMember, "role": rank, "managedChannels": managed, "channels": channels,
		"presence": presence, "presenceUnavailable": unavailable,
	})
}

func (s *service) channelCommand(w http.ResponseWriter, r *http.Request, member account) {
	var value channel
	if !readBody(w, r, &value) {
		return
	}
	action := "channel.set"
	switch r.URL.Path {
	case "/api/v1/channel/delete":
		action = "channel.delete"
	case "/api/v1/channel/create":
		if s.globalRole(member) == roleMember {
			failure(w, http.StatusForbidden, "admin_required")
			return
		}
		value.ID = "voice-" + strings.ToLower(randomToken(9))
	default:
		if _, exists := s.state.Channels[value.ID]; !exists {
			failure(w, http.StatusNotFound, "channel_not_found")
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
	result, err := s.adminWorkspace(command{Action: action, Channel: &value})
	switch {
	case errors.Is(err, errMissing):
		failure(w, http.StatusNotFound, "channel_not_found")
	case err != nil:
		failure(w, http.StatusBadRequest, "channel_update_failed")
	default:
		response(w, http.StatusOK, result)
	}
}
