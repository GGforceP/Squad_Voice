package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestChatPersistenceAndRetention(t *testing.T) {
	room := map[string]channel{"voice-lobby": {ID: "voice-lobby", Name: "Lobby", Capacity: 5}}
	dir := filepath.Join(t.TempDir(), "mediacache")
	store, err := openChat(dir, 10, room)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { store.close() }()
	item := chatMessage{Channel: "voice-lobby", Author: "Member", AuthorID: "member", Time: time.Now().UTC()}
	send := func(nonce, text, mime string, image []byte) chatMessage {
		t.Helper()
		item.Nonce, item.Text, item.Image, item.ImageSize = nonce, text, mime, len(image)
		result, err := store.append(item, image)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	one := send("one", "first", "image/png", []byte("111111"))
	two := send("two", "second", "image/png", []byte("222222"))
	three := send("three", "third", "", nil)
	if again := send("three", "third retry", "", nil); again.ID != three.ID {
		t.Fatal("a retried send created a duplicate")
	}
	if _, err := os.Stat(store.imagePath(one.ID)); !os.IsNotExist(err) {
		t.Fatal("earliest image was not removed")
	}
	f, _, err := store.image(two.Channel, two.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(f)
	f.Close()
	if err != nil || !bytes.Equal(data, []byte("222222")) {
		t.Fatal("new image mismatch")
	}

	recent, err := store.page(item.Channel, 0, 0, 2, "")
	if err != nil || !recent.More || len(recent.Messages) != 2 || recent.Messages[0].ID != two.ID {
		t.Fatalf("unexpected recent page: %v, %v", recent, err)
	}
	same, err := store.page(item.Channel, 0, 0, 2, recent.Tag)
	if err != nil || !same.Unchanged || len(same.Messages) != 0 {
		t.Fatal("identical history should validate without resending messages")
	}
	older, err := store.page(item.Channel, two.ID, 0, 2, "")
	if err != nil || older.More || len(older.Messages) != 1 || !older.Messages[0].ImageGone || older.Messages[0].Text != "first" {
		t.Fatal("older page or retained caption mismatch")
	}
	cursor, err := store.updates("", 0)
	if err != nil || !cursor.Reset || cursor.Cursor == 0 {
		t.Fatal("initial sync")
	}
	signal := store.eventSignal()
	if err := store.deleteMessage(item.Channel, two.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-signal:
	default:
		t.Fatal("message deletion did not wake connected clients")
	}
	originalEpoch := store.epoch
	store.close()
	store, err = openChat(dir, 10, room)
	if err != nil {
		t.Fatal(err)
	}
	if store.epoch != originalEpoch {
		t.Fatal("database identity changed across restart")
	}
	events, err := store.updates(cursor.Epoch, cursor.Cursor)
	if err != nil || events.Reset || len(events.Events) != 1 || events.Events[0].Op != "delete" || events.Events[0].ID != two.ID {
		t.Fatal("offline clients did not receive the durable deletion")
	}
	if _, _, err := store.image(item.Channel, two.ID); !errors.Is(err, errMissing) {
		t.Fatal("deleted image still accessible")
	}
	if err := store.deleteChannel(item.Channel); err != nil {
		t.Fatal(err)
	}
	page, err := store.page(item.Channel, 0, 0, 2, "")
	if err != nil || len(page.Messages) != 0 {
		t.Fatal("channel history survived deletion")
	}
}

func TestCacheQuota(t *testing.T) {
	for _, pair := range []struct {
		value string
		bytes uint64
	}{{"", defaultCache}, {"2048", 2 * 1024 * 1024 * 1024}, {"0", 0}} {
		if size, err := cacheQuota(pair.value); err != nil || size != pair.bytes {
			t.Fatalf("wrong cache quota for %q", pair.value)
		}
	}
	if _, err := cacheQuota("-1"); err == nil {
		t.Fatal("negative quota accepted")
	}
}

func TestChatRequiresActiveVoiceAndChecksRole(t *testing.T) {
	lk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/twirp/livekit.RoomService/ListParticipants" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, `{"participants":[{"identity":"confirmed","name":"Member","state":"ACTIVE","tracks":[{"source":"MICROPHONE"},{"source":"SCREEN_SHARE_AUDIO","muted":false}]}]}`)
	}))
	defer lk.Close()
	s, err := newService(filepath.Join(t.TempDir(), "state.json"), testGeo(), newMedia(lk.URL, randomToken(12), randomToken(48)), "wss://voice.example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	defer s.chat.close()
	s.state.Accounts["member"] = account{user: user{ID: "member", Name: "Member"}, Enabled: true}
	key := digest("test-session")
	s.sessions[key] = session{UserID: "member", Expires: time.Now().Add(time.Hour)}
	post := func(path, body string, want int) string {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/v1/"+path, bytes.NewBufferString(body))
		r.Header.Set("Authorization", "Bearer test-session")
		r.Header.Set("X-SquadVoice-Peer", testPeer)
		w := httptest.NewRecorder()
		s.servePublic(w, r)
		if w.Code != want {
			t.Fatalf("%s returned %d, want %d: %s", path, w.Code, want, w.Body)
		}
		return w.Body.String()
	}
	post("chat/history", `{"channelId":"voice-lobby","limit":3}`, http.StatusForbidden)
	post("chat/image", `{"channelId":"voice-lobby","id":1}`, http.StatusForbidden)
	post("channel/create", `{"name":"Test","capacity":4}`, http.StatusForbidden)
	s.leases["pending"] = &lease{Identity: "pending", UserID: "member", Session: key, Channel: "voice-lobby", Room: "voice-lobby-5", Cancel: func() {}}
	post("chat/history", `{"channelId":"voice-lobby","limit":3}`, http.StatusForbidden)
	delete(s.leases, "pending")
	s.leases["confirmed"] = &lease{Identity: "confirmed", UserID: "member", Session: key, Channel: "voice-lobby", Room: "voice-lobby-5", Cancel: func() {}}
	view := post("workspace", "{}", http.StatusOK)
	if !bytes.Contains([]byte(view), []byte(`"music":true`)) || !bytes.Contains([]byte(view), []byte(`"mic":true`)) {
		t.Fatal("media track states not present")
	}
	post("chat/send", `{"channelId":"voice-lobby","text":"大家好 🎮","nonce":"nonce-for-one-test"}`, http.StatusOK)
	post("chat/delete", `{"channelId":"voice-lobby","id":1}`, http.StatusForbidden)
	beforeDelete, err := s.chat.updates("", 0)
	if err != nil {
		t.Fatal(err)
	}
	a := s.state.Accounts["member"]
	a.Admin = true
	s.state.Accounts["member"] = a
	post("chat/delete", `{"channelId":"voice-lobby","id":1}`, http.StatusNoContent)
	post("channel/create", `{"name":"Test","capacity":4}`, http.StatusOK)
	delete(s.leases, "confirmed")
	request, err := json.Marshal(map[string]any{"epoch": beforeDelete.Epoch, "cursor": beforeDelete.Cursor})
	if err != nil {
		t.Fatal(err)
	}
	invalidations := post("chat/watch", string(request), http.StatusOK)
	if !bytes.Contains([]byte(invalidations), []byte(`"op":"delete"`)) || bytes.Contains([]byte(invalidations), []byte("大家好")) {
		t.Fatal("a returning client without voice membership did not receive the cache invalidation alone")
	}
	post("chat/history", `{"channelId":"voice-lobby","limit":3}`, http.StatusForbidden)
}
