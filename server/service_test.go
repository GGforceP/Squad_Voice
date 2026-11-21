package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testPeer = "192.0.2.10"
const outsidePeer = "198.51.100.20"
const testPeerV6 = "2001:db8::10"

func testGeo() geoData {
	return geoData{Source: geoSource, Month: "2024-01", Country: "GB",
		V4: []ipRange{{netip.MustParseAddr(testPeer), netip.MustParseAddr(testPeer)}},
		V6: []ipRange{{netip.MustParseAddr(testPeerV6), netip.MustParseAddr(testPeerV6)}},
	}
}

func TestCountryData(t *testing.T) {
	csv := strings.Join([]string{
		testPeer + "," + testPeer + ",GB",
		testPeerV6 + "," + testPeerV6 + ",GB",
		outsidePeer + "," + outsidePeer + ",US",
		"2001:db8:1::1,2001:db8:1::9,US",
	}, "\n")
	g, err := geoImport(strings.NewReader(csv), "2024-01", "gb")
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{
		testPeer: true, "::ffff:" + testPeer: true, testPeerV6: true,
		outsidePeer: false, "2001:db8:1::1": false, "127.0.0.1": false,
	}
	for ip, allowed := range cases {
		if g.allows(netip.MustParseAddr(ip)) != allowed {
			t.Errorf("unexpected decision for %s", ip)
		}
	}
}

func TestPasswordRules(t *testing.T) {
	cases := []struct {
		label, password string
		valid           bool
	}{
		{"eight characters", "1234567.", false},
		{"one category", "123456789", false},
		{"spaces are not symbols", "12345678 ", false},
		{"digits and punctuation", "12345678.", true},
		{"upper and lower", "ABCDEFGHa", true},
		{"unicode letters and digits", "ÉÉÉÉÉÉÉÉ９", true},
		{"maximum length", strings.Repeat("a", 127) + "!", true},
		{"over maximum", strings.Repeat("a", 128) + "!", false},
		{"line break", "abcdefgh1\n", false},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			if validPassword(tc.password) != tc.valid {
				t.Errorf("validPassword returned the wrong result")
			}
		})
	}
}

func TestMemberLifecycle(t *testing.T) {
	var created, removed atomic.Int32
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/CreateRoom":
			created.Add(1)
		case "/twirp/livekit.RoomService/RemoveParticipant":
			removed.Add(1)
		case "/rtc/validate":
		default:
			t.Errorf("unexpected upstream request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer lk.Close()
	path := filepath.Join(t.TempDir(), "state.json")
	s, err := newService(path, testGeo(), newMedia(lk.URL, randomToken(12), randomToken(48)), "wss://voice.example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.chat.close)
	admin := func(cmd command) {
		t.Helper()
		body, _ := json.Marshal(cmd)
		r := httptest.NewRequest(http.MethodPost, "/admin", bytes.NewReader(body))
		w := httptest.NewRecorder()
		s.serveAdmin(w, r)
		if w.Code != 200 {
			t.Fatalf("%s returned %d: %s", cmd.Action, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "passwordHash") || strings.Contains(w.Body.String(), "argon2id") {
			t.Fatal("account listing contains password data")
		}
	}
	req := func(method, path, token, peer string, body any, status int) map[string]any {
		t.Helper()
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("X-SquadVoice-Peer", peer)
		r.Header.Set("X-Forwarded-For", testPeer)
		r.Header.Set("Forwarded", "for="+testPeer)
		w := httptest.NewRecorder()
		s.servePublic(w, r)
		if w.Code != status {
			t.Fatalf("%s returned %d; expected %d (%s)", strings.Split(path, "?")[0], w.Code, status, w.Body.String())
		}
		var result map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		return result
	}

	req("POST", "/api/v1/voice/join", "", testPeer, nil, 401)
	req("POST", "/api/v1/login", "", outsidePeer, nil, 403)
	req("GET", "/rtc", "", "203.0.113.23", nil, 403)
	req("POST", "/admin", "", testPeer, nil, 401)
	names, tokens, tickets := make([]string, 6), make([]string, 6), make([]string, 5)
	password := "abcdefgh1"
	login := func(name, pass string, status int) map[string]any {
		t.Helper()
		return req("POST", "/api/v1/login", "", testPeer, map[string]string{"username": name, "password": pass}, status)
	}
	join := func(token string, status int) map[string]any {
		t.Helper()
		return req("POST", "/api/v1/voice/join", token, testPeer, map[string]string{"channelId": "voice-lobby"}, status)
	}
	label := "Member"
	for i := range names {
		names[i] = fmt.Sprintf("test-%d", i)
		admin(command{Action: "account.add", Username: names[i], Name: &label, Password: password})
		tokens[i] = login(names[i], password, 200)["sessionToken"].(string)
	}
	login(names[0], "wrong", 401)
	admin(command{Action: "account.list"})
	admin(command{Action: "channel.set", Channel: &channel{ID: "second", Name: "Second", Capacity: 3}})
	for i := range tickets {
		tickets[i] = join(tokens[i], 200)["accessToken"].(string)
	}
	join(tokens[5], 409)
	req("POST", "/api/v1/voice/join", tokens[5], testPeer, map[string]string{"channelId": "second"}, 409)
	if created.Load() != 5 {
		t.Fatalf("expected 5 room assignments, got %d", created.Load())
	}
	signal := "/rtc/validate?access_token=" + tickets[0]
	req("GET", signal, "", outsidePeer, nil, 403)
	req("GET", signal, "", testPeer, nil, 200)
	req("POST", "/api/v1/account/profile", tokens[0], testPeer, map[string]any{"name": "Updated", "role": "owner"}, 400)
	req("POST", "/api/v1/account/profile", tokens[0], testPeer, map[string]string{"name": "Updated", "bio": "Hello"}, 200)
	admin(command{Action: "account.disable", Username: names[0]})
	if removed.Load() != 1 {
		t.Fatal("disable did not remove the participant from LiveKit")
	}
	req("GET", signal, "", testPeer, nil, 401)
	req("POST", "/api/v1/account/me", tokens[0], testPeer, nil, 401)
	login(names[0], password, 401)
	join(tokens[5], 200)
	admin(command{Action: "account.enable", Username: names[0]})
	admin(command{Action: "account.edit", Username: names[0], NewUsername: "new-name"})
	admin(command{Action: "account.delete", Username: names[1]})
	login(names[1], password, 401)
	selfToken := login("new-name", password, 200)["sessionToken"].(string)
	next := "12345678."
	req("POST", "/api/v1/account/password", selfToken, testPeer, map[string]string{"currentPassword": "wrong", "newPassword": next}, 400)
	req("POST", "/api/v1/account/password", selfToken, testPeer, map[string]string{"currentPassword": password, "newPassword": next}, 204)
	req("POST", "/api/v1/account/me", selfToken, testPeer, nil, 401)
	login("new-name", password, 401)
	user := login("new-name", next, 200)["user"].(map[string]any)
	if user["name"] != "Updated" || user["bio"] != "Hello" {
		t.Fatal("personal profile was not retained")
	}
	admin(command{Action: "channel.delete", Channel: &channel{ID: "second"}})
	state, err := loadState(path)
	if err != nil || state.Accounts["new-name"].Password == next || !checkPassword(state.Accounts["new-name"].Password, next) {
		t.Fatal("account state did not survive reload with a hashed password")
	}
}

// The desktop harness starts this test executable instead of the old JS broker.
// Its loopback transport and test peer header are never compiled into the service.
func TestDesktopBroker(t *testing.T) {
	input := os.Getenv("SQUADVOICE_TEST_DESKTOP_BROKER")
	if input == "" {
		t.Skip("launched by desktop-qa.mjs")
	}
	var config struct {
		LiveKit, Key, Secret             string
		Owner, Updates, UpdatesPublicKey string
		ChatFixtures                     bool
		Accounts                         []struct {
			Username, Name, Password string
			Admin                    bool
		}
	}
	if err := decode(strings.NewReader(input), &config); err != nil {
		t.Fatal("invalid desktop fixture")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := listener.Addr().String()
	dir, err := os.MkdirTemp(os.Getenv("SQUADVOICE_TEST_TEMP"), "backend-desktop-")
	if err != nil {
		t.Fatal(err)
	}
	stateFile := filepath.Join(dir, "state.json")
	defer os.Remove(dir)
	defer os.Remove(stateFile)
	s, err := newService(stateFile, testGeo(), newMedia(config.LiveKit, config.Key, config.Secret), "ws://"+origin)
	if err != nil {
		t.Fatal(err)
	}
	defer s.chat.close()
	for _, a := range config.Accounts {
		if _, err := s.admin(command{Action: "account.add", Username: a.Username, Name: &a.Name, Password: a.Password}); err != nil {
			t.Fatal(err)
		}
		if a.Admin {
			if _, err := s.admin(command{Action: "account.admin", Username: a.Username}); err != nil {
				t.Fatal(err)
			}
		}
	}
	s.ownerName = config.Owner
	if config.Updates != "" {
		s.updates, err = openReleaseSource(config.Updates, config.UpdatesPublicKey)
		if err != nil {
			t.Fatal(err)
		}
		defer s.updates.root.Close()
	}
	if config.ChatFixtures {
		for i := 1; i <= 14; i++ {
			if _, err := s.chat.append(chatMessage{Channel: "voice-lobby", Author: "历史样本", AuthorID: "qa-history",
				Nonce: randomToken(18), Text: fmt.Sprintf("历史消息 %02d", i), Time: time.Now().UTC()}, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	// On EOF, close the fixture and discard its temporary account state.
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("X-SquadVoice-Peer", testPeer)
		s.servePublic(w, r)
	})}
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		s.mu.Lock()
		s.remove(s.cut(func(*lease) bool { return true }))
		s.mu.Unlock()
		_ = server.Close()
		close(done)
	}()
	fmt.Println("SV_TEST_READY=http://" + origin)
	err = server.Serve(listener)
	<-done
	if err != http.ErrServerClosed {
		t.Fatal(err)
	}
}
