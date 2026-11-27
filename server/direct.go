package main

import (
	"encoding/base64"
	"net/http"
	"strings"
)

const directPrefix = "dm."

func directChatID(first, second string) string {
	if first > second {
		first, second = second, first
	}
	return directPrefix + base64.RawURLEncoding.EncodeToString([]byte(first)) + "." +
		base64.RawURLEncoding.EncodeToString([]byte(second))
}

func directParticipants(conversation string) (first, second string, ok bool) {
	encoded, direct := strings.CutPrefix(conversation, directPrefix)
	if !direct || len(encoded) > 500 {
		return "", "", false
	}
	left, right, paired := strings.Cut(encoded, ".")
	if !paired {
		return "", "", false
	}
	a, errA := base64.RawURLEncoding.Strict().DecodeString(left)
	b, errB := base64.RawURLEncoding.Strict().DecodeString(right)
	first, second = string(a), string(b)
	return first, second, errA == nil && errB == nil && first != "" && first < second &&
		directChatID(first, second) == conversation
}

// On success the caller holds the service lock, as with connectedRoom.
func (s *service) chatAccount(w http.ResponseWriter, r *http.Request, key tokenKey, conversation string) (account, bool) {
	if !strings.HasPrefix(conversation, directPrefix) {
		access, ok := s.connectedRoom(w, r, key, conversation, false)
		return access.account, ok
	}
	s.mu.Lock()
	_, member, authorized := s.authenticated(key)
	if !authorized {
		s.mu.Unlock()
		failure(w, http.StatusUnauthorized, "session_expired")
		return account{}, false
	}
	a, b, valid := directParticipants(conversation)
	if valid && (member.ID == a || member.ID == b) {
		peer := b
		if member.ID == b {
			peer = a
		}
		if _, other := s.accountByID(peer); other.Enabled {
			return member, true
		}
	}
	s.mu.Unlock()
	failure(w, http.StatusForbidden, "conversation_unavailable")
	return account{}, false
}
