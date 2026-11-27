package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func messagingService(t *testing.T) *service {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	// A pre-hierarchy file must keep its original voice and chat identity.
	accounts := map[string]account{}
	hash := hashPassword("fixture-29!")
	for _, name := range []string{"owner", "alice", "bob", "third"} {
		accounts[name] = account{user: user{ID: "id-" + name, Name: name, Username: name}, Enabled: true, Password: hash}
	}
	if err := writeFile(path, state{Version: 1, Workspace: "小队", Accounts: accounts,
		Channels: map[string]channel{"voice-lobby": {ID: "voice-lobby", Name: "大厅", Capacity: 5}}}, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := newService(path, testGeo(), nil, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.chat.close)
	s.ownerName = "owner"
	for name, account := range accounts {
		s.sessions[digest(name)] = session{UserID: account.ID, Expires: time.Now().Add(time.Hour)}
	}
	return s
}

func messagingPost(t *testing.T, s *service, user, route string, data any, want int) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/"+route, bytes.NewReader(body))
	return messagingRequest(t, s, user, r, want)
}

func messagingRequest(t *testing.T, s *service, user string, r *http.Request, want int) *httptest.ResponseRecorder {
	t.Helper()
	r.Header.Set("Authorization", "Bearer "+user)
	r.Header.Set("X-SquadVoice-Peer", testPeer)
	w := httptest.NewRecorder()
	s.servePublic(w, r)
	if w.Code != want {
		t.Fatalf("%s: status %d, want %d (%s)", r.URL.Path, w.Code, want, w.Header().Get("X-SquadVoice-Error"))
	}
	return w
}

func TestChannelHierarchyMigrationAndScope(t *testing.T) {
	s := messagingService(t)
	lobby := s.state.Channels["voice-lobby"]
	if lobby.GroupID != defaultGroupID || s.state.Groups[defaultGroupID].Name != "小队" {
		t.Fatal("the original channel was not preserved under a default group")
	}
	messagingPost(t, s, "alice", "group/create", channelGroup{Name: "新区"}, http.StatusForbidden)
	created := messagingPost(t, s, "owner", "group/create", channelGroup{Name: "新区"}, http.StatusOK)
	var groupReply struct {
		Group string `json:"groupId"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &groupReply); err != nil || groupReply.Group == "" {
		t.Fatal("created group ID missing")
	}
	s.state.setRoomRules(lobby.ID, "id-alice", roomRules{Admin: true})
	messagingPost(t, s, "alice", "channel/create", channel{GroupID: groupReply.Group, Name: "越级频道", Capacity: 5}, http.StatusForbidden)
	created = messagingPost(t, s, "alice", "channel/create", channel{GroupID: defaultGroupID, Name: "分队", Capacity: 5}, http.StatusOK)
	var channelReply struct {
		Channel string `json:"channelId"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &channelReply); err != nil || channelReply.Channel == "" {
		t.Fatal("created child channel ID missing")
	}
	child := s.state.Channels[channelReply.Channel]
	if child.GroupID != defaultGroupID || s.channelRole(s.state.Accounts["alice"], child.ID) != roleChannel {
		t.Fatal("delegated channel creation lost its parent or scope")
	}
	child.GroupID = groupReply.Group
	messagingPost(t, s, "alice", "channel/update", child, http.StatusForbidden)
	messagingPost(t, s, "owner", "channel/update", child, http.StatusOK)
	messagingPost(t, s, "owner", "group/delete", channelGroup{ID: groupReply.Group}, http.StatusOK)
	loaded, err := loadState(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if _, kept := loaded.Channels[child.ID]; kept || loaded.Channels[lobby.ID].GroupID != defaultGroupID {
		t.Fatal("group removal did not isolate its children")
	}
}

func TestPrivateConversationPersistenceAndAccess(t *testing.T) {
	s := messagingService(t)
	conversation := directChatID("id-alice", "id-bob")
	if conversation != directChatID("id-bob", "id-alice") {
		t.Fatal("participants did not share one conversation")
	}
	history := chatRequest{Channel: conversation, Limit: 10}
	messagingPost(t, s, "third", "chat/history", history, http.StatusForbidden)
	messagingPost(t, s, "alice", "chat/history", chatRequest{Channel: "voice-lobby", Limit: 10}, http.StatusForbidden)
	cursor, err := s.chat.updates("", 0)
	if err != nil {
		t.Fatal(err)
	}
	messagingPost(t, s, "alice", "chat/send", chatRequest{Channel: conversation, Text: "会话消息", Nonce: randomToken(18)}, http.StatusOK)
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 5, 7))); err != nil {
		t.Fatal(err)
	}
	var payload bytes.Buffer
	form := multipart.NewWriter(&payload)
	if err := form.WriteField("nonce", randomToken(18)); err != nil {
		t.Fatal(err)
	}
	part, err := form.CreateFormFile("image", "sample.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(imageBytes.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/upload?channel="+url.QueryEscape(conversation), &payload)
	req.Header.Set("Content-Type", form.FormDataContentType())
	uploaded := messagingRequest(t, s, "bob", req, http.StatusOK)
	var item chatMessage
	if err := json.Unmarshal(uploaded.Body.Bytes(), &item); err != nil || item.Image != "image/png" {
		t.Fatal("private attachment was not stored")
	}
	imageRequest := chatRequest{Channel: conversation, ID: item.ID}
	messagingPost(t, s, "third", "chat/image", imageRequest, http.StatusForbidden)
	if result := messagingPost(t, s, "alice", "chat/image", imageRequest, http.StatusOK); !bytes.Equal(result.Body.Bytes(), imageBytes.Bytes()) {
		t.Fatal("downloaded attachment differs from the uploaded bytes")
	}
	for _, user := range []string{"alice", "bob", "third"} {
		reply := messagingPost(t, s, user, "chat/watch", map[string]any{"epoch": cursor.Epoch, "cursor": cursor.Cursor}, http.StatusOK)
		var events chatUpdates
		if err := json.Unmarshal(reply.Body.Bytes(), &events); err != nil {
			t.Fatal(err)
		}
		visible := slices.ContainsFunc(events.Events, func(event chatEvent) bool { return event.Channel == conversation })
		if visible != (user != "third") {
			t.Fatal("private event recipient is wrong")
		}
	}
	s.chat.close()
	reopened, err := newService(s.path, testGeo(), nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.chat.close()
	reopened.sessions[digest("bob")] = session{UserID: "id-bob", Expires: time.Now().Add(time.Hour)}
	w := messagingPost(t, reopened, "bob", "chat/history", history, http.StatusOK)
	var page chatPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Messages) != 2 || page.Messages[0].Text != "会话消息" {
		t.Fatal("private history did not survive server restart")
	}
}
