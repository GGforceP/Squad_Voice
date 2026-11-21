package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestModerationRolesAndLock(t *testing.T) {
	var upstream mediaGrant
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "ListParticipants"):
			_, _ = io.WriteString(w, `{"participants":[{"identity":"owner-voice","state":"ACTIVE"},{"identity":"guest-voice","state":"ACTIVE"},{"identity":"other-voice","state":"ACTIVE"}]}`)
		case strings.HasSuffix(r.URL.Path, "UpdateParticipant"):
			w.WriteHeader(http.StatusOK)
		case r.URL.Path == "/rtc/validate":
			claims := new(mediaClaims)
			_, _, err := jwt.NewParser().ParseUnverified(r.URL.Query().Get("access_token"), claims)
			if err == nil {
				upstream = claims.Video
			}
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mediaServer.Close()
	s, err := newService(filepath.Join(t.TempDir(), "state.json"), testGeo(), newMedia(mediaServer.URL, randomToken(12), randomToken(48)), "ws://test.invalid")
	if err != nil {
		t.Fatal(err)
	}
	defer s.chat.close()
	const channel = "voice-lobby"
	s.ownerName = "owner"
	for _, who := range []string{"owner", "guest", "other"} {
		s.state.Accounts[who] = account{user: user{ID: who, Username: who, Name: who}, Enabled: true, Password: s.dummyHash}
		s.sessions[digest(who)] = session{UserID: who, Expires: time.Now().Add(time.Hour)}
	}
	request := func(who, method, path, body string, expected int) string {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-SquadVoice-Peer", testPeer)
		r.Header.Set("Authorization", "Bearer "+who)
		w := httptest.NewRecorder()
		s.servePublic(w, r)
		if w.Code != expected {
			t.Fatalf("%s %s: got %d, expected %d: %s", who, path, w.Code, expected, w.Body)
		}
		return w.Body.String()
	}
	control := func(who, target, action string, enabled bool, expected int) string {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"channelId": channel, "targetId": target, "action": action, "enabled": enabled})
		return request(who, "POST", "/api/v1/member/control", string(body), expected)
	}
	control("owner", "guest-voice", "mic", true, http.StatusForbidden)
	for _, who := range []string{"owner", "guest", "other"} {
		id := who + "-voice"
		s.leases[id] = &lease{Identity: id, Channel: channel, Room: "voice-lobby-5", UserID: who, Session: digest(who), Cancel: func() {}}
	}
	control("guest", "other-voice", "mic", true, http.StatusForbidden)
	control("owner", "guest-voice", "channel-admin", true, http.StatusOK)
	if rank := s.channelRole(s.state.Accounts["guest"], "another-channel"); rank != roleMember {
		t.Fatal("channel role leaked")
	}
	control("guest", "owner-voice", "mic", true, http.StatusForbidden)
	control("guest", "other-voice", "recursive-admin", true, http.StatusForbidden)
	control("owner", "guest-voice", "recursive-admin", true, http.StatusOK)
	control("guest", "other-voice", "recursive-admin", true, http.StatusOK)
	control("guest", "owner-voice", "recursive-admin", false, http.StatusForbidden)
	if _, err := s.adminAccount(command{Action: "account.member", Username: "owner"}); err == nil {
		t.Fatal("owner demotion accepted")
	}
	if _, err := s.adminAccount(command{Action: "account.edit", Username: "owner", NewUsername: "changed"}); err == nil {
		t.Fatal("owner rename accepted")
	}

	stale, err := s.media.ticket("guest-voice", "guest", "voice-lobby-5", roomRules{})
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"listen", "mic", "chat"} {
		control("owner", "guest-voice", action, true, http.StatusOK)
		if reply := control("guest", "", action, false, http.StatusConflict); !strings.Contains(reply, "restriction_locked") {
			t.Fatal(reply)
		}
	}
	request("guest", "POST", "/api/v1/chat/send", `{"channelId":"voice-lobby","text":"blocked","nonce":"cannot-send-message"}`, http.StatusForbidden)
	request("guest", "POST", "/api/v1/chat/upload?channel=voice-lobby", "", http.StatusForbidden)
	request(stale, "GET", "/rtc/validate", "", http.StatusOK)
	if upstream.CanSubscribe == nil || *upstream.CanSubscribe || slices.Contains(upstream.CanPublishSources, "microphone") {
		t.Fatal("old media token kept unrestricted permissions")
	}
	loaded, err := loadState(s.path)
	if err != nil || loaded.RoomRules[channel]["guest"].Chat <= time.Now().Add(57*time.Second).UnixMilli() {
		t.Fatal("60-second restriction not persisted")
	}
	control("owner", "guest-voice", "chat", false, http.StatusOK)
	if s.rules(channel, "guest").Chat != 0 {
		t.Fatal("administrator did not release the chat lock")
	}
	aged := s.rules(channel, "guest")
	aged.Mic = time.Now().Add(-time.Second).UnixMilli()
	s.state.setRoomRules(channel, "guest", aged)
	control("guest", "", "mic", false, http.StatusOK)
	if s.rules(channel, "guest").Mic != 0 || s.rules(channel, "guest").Listen == 0 {
		t.Fatal("unlock did not respect restriction scope")
	}
}
