package main

import (
	"maps"
	"net/http"
	"slices"
	"time"
)

type role string

const (
	roleOwner     role = "owner"
	roleRecursive role = "recursive"
	roleChannel   role = "channel"
	roleMember    role = "member"
	roomLock           = time.Minute
)

// Nonzero deadlines mean the restriction stays in effect. Passing a
// deadline permits the member to release it, rather than releasing it for them.
type roomRules struct {
	Admin  bool  `json:"channelAdmin,omitempty"`
	Listen int64 `json:"listenUntil,omitempty"`
	Mic    int64 `json:"micUntil,omitempty"`
	Chat   int64 `json:"chatUntil,omitempty"`
}

func (r roomRules) publishSources() []string {
	if r.Mic != 0 {
		return []string{"screen_share_audio"}
	}
	return []string{"microphone", "screen_share_audio"}
}

func (s *service) globalRole(a account) role {
	if s.ownerName != "" && a.Username == s.ownerName {
		return roleOwner
	}
	if a.Admin {
		return roleRecursive
	}
	return roleMember
}

type memberIdentity struct {
	user
	Role role `json:"role"`
}

func (s *service) identity(a account) memberIdentity {
	rank := s.globalRole(a)
	identity := a.user
	identity.Admin = rank != roleMember
	return memberIdentity{user: identity, Role: rank}
}

func (s *service) rules(channel, user string) roomRules { return s.state.RoomRules[channel][user] }

func (s *service) channelRole(a account, channel string) role {
	rank := s.globalRole(a)
	if rank == roleMember && s.rules(channel, a.ID).Admin {
		return roleChannel
	}
	return rank
}

func (s *service) managedChannels(a account) []string {
	result := []string{}
	for id := range s.state.Channels {
		if s.channelRole(a, id) != roleMember {
			result = append(result, id)
		}
	}
	slices.Sort(result)
	return result
}

func (s *state) setRoomRules(channel, id string, rules roomRules) {
	users := maps.Clone(s.RoomRules[channel])
	if rules == (roomRules{}) {
		delete(users, id)
	} else {
		if users == nil {
			users = make(map[string]roomRules)
		}
		users[id] = rules
	}
	if len(users) == 0 {
		delete(s.RoomRules, channel)
	} else {
		if s.RoomRules == nil {
			s.RoomRules = make(map[string]map[string]roomRules)
		}
		s.RoomRules[channel] = users
	}
}

func canControl(actor, target role) bool {
	switch actor {
	case roleOwner, roleRecursive:
		return target != roleOwner
	case roleChannel:
		return target == roleMember || target == roleChannel
	default:
		return false
	}
}

func (s *service) memberControl(w http.ResponseWriter, r *http.Request, key tokenKey) {
	var req struct {
		Channel string `json:"channelId"`
		Target  string `json:"targetId"`
		Action  string `json:"action"`
		Enabled *bool  `json:"enabled"`
	}
	if !readBody(w, r, &req) {
		return
	}
	if req.Enabled == nil {
		failure(w, http.StatusBadRequest, "invalid_request")
		return
	}
	access, ok := s.connectedRoom(w, r, key, req.Channel, true)
	if !ok {
		return
	}
	defer s.mu.Unlock()
	if req.Target == "" && !*req.Enabled {
		req.Target = access.lease.Identity
	}
	target := s.leases[req.Target]
	if target == nil || target.Channel != req.Channel || target.Cancel == nil ||
		!slices.ContainsFunc(access.active, func(row voiceMember) bool { return row.ID == req.Target }) {
		failure(w, http.StatusNotFound, "member_not_in_room")
		return
	}
	name, account := s.accountByID(target.UserID)
	actor := s.channelRole(access.account, req.Channel)
	targetRank := s.channelRole(account, req.Channel)
	self := target.UserID == access.account.ID
	if self && *req.Enabled || !self && !canControl(actor, targetRank) {
		failure(w, http.StatusForbidden, "admin_required")
		return
	}
	rules := s.rules(req.Channel, account.ID)
	previous := rules
	var until *int64
	var permissionChanged bool
	switch req.Action {
	case "listen":
		until, permissionChanged = &rules.Listen, true
	case "mic":
		until, permissionChanged = &rules.Mic, true
	case "chat":
		until = &rules.Chat
	case "channel-admin":
		if self || targetRank == roleRecursive || targetRank == roleOwner {
			failure(w, http.StatusForbidden, "admin_required")
			return
		}
		rules.Admin = *req.Enabled
	case "recursive-admin":
		if self || actor != roleOwner && actor != roleRecursive {
			failure(w, http.StatusForbidden, "admin_required")
			return
		}
		account.Admin = *req.Enabled
	default:
		failure(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if until != nil {
		now := time.Now()
		if *req.Enabled {
			*until = now.Add(roomLock).UnixMilli()
		} else if self && now.UnixMilli() < *until {
			failure(w, http.StatusConflict, "restriction_locked")
			return
		} else {
			*until = 0
		}
	}
	next := s.state.copy()
	next.Accounts[name] = account
	next.setRoomRules(req.Channel, account.ID, rules)
	if err := s.commit(next); err != nil {
		failure(w, http.StatusInternalServerError, "storage_unavailable")
		return
	}
	if permissionChanged && rules != previous && s.media.restrict(target, rules) != nil {
		// Make the member obtain a new grant if the live update could not apply.
		s.remove(s.cut(func(l *lease) bool { return l == target }))
	}
	response(w, http.StatusOK, map[string]any{"role": s.channelRole(account, req.Channel), "rules": rules})
}
