package main

import (
	"bytes"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	_ "golang.org/x/image/webp"
)

var clientNonce = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)

const maxChatText = 2000

type chatRequest struct {
	Channel string `json:"channelId"`
	Before  uint64 `json:"before"`
	After   uint64 `json:"after"`
	ID      uint64 `json:"id"`
	Limit   int    `json:"limit"`
	Known   string `json:"known"`
	Text    string `json:"text"`
	Nonce   string `json:"nonce"`
}

func (s *service) chatWatch(w http.ResponseWriter, r *http.Request, key tokenKey) {
	var req struct {
		Epoch  string `json:"epoch"`
		Cursor uint64 `json:"cursor"`
	}
	if !readBody(w, r, &req) {
		return
	}
	s.mu.Lock()
	_, _, ok := s.authenticated(key)
	s.mu.Unlock()
	if !ok {
		failure(w, http.StatusUnauthorized, "session_expired")
		return
	}
	if s.chat == nil {
		failure(w, http.StatusServiceUnavailable, "chat_unavailable")
		return
	}
	signal := s.chat.eventSignal()
	out, err := s.chat.updates(req.Epoch, req.Cursor)
	if err == nil && !out.Reset && len(out.Events) == 0 {
		select {
		case <-signal:
		case <-time.After(7 * time.Second):
		case <-r.Context().Done():
			return
		}
		out, err = s.chat.updates(req.Epoch, req.Cursor)
	}
	s.mu.Lock()
	_, recipient, ok := s.authenticated(key)
	// Public channel invalidation remains global, but every event about a
	// private conversation is visible only to its two participants.
	var channel string
	for _, lease := range s.leases {
		if lease.Session == key && lease.Cancel != nil {
			channel = lease.Channel
			break
		}
	}
	s.mu.Unlock()
	if !ok {
		failure(w, http.StatusUnauthorized, "session_expired")
		return
	}
	if err != nil {
		failure(w, http.StatusInternalServerError, "chat_unavailable")
		return
	}
	out.Events = slices.DeleteFunc(out.Events, func(event chatEvent) bool {
		if strings.HasPrefix(event.Channel, directPrefix) {
			a, b, valid := directParticipants(event.Channel)
			return !valid || recipient.ID != a && recipient.ID != b
		}
		return event.Op == "message" && event.Channel != channel
	})
	response(w, http.StatusOK, out)
}

type roomAccess struct {
	account account
	lease   *lease
	active  []voiceMember
}

func (s *service) connectedRoom(w http.ResponseWriter, r *http.Request, key tokenKey, channel string, fresh bool) (roomAccess, bool) {
	s.mu.Lock()
	_, _, authorized := s.authenticated(key)
	_, roomExists := s.state.Channels[channel]
	var identity, room string
	for _, l := range s.leases {
		if l.Session == key && l.Channel == channel && l.Cancel != nil {
			identity, room = l.Identity, l.Room
			break
		}
	}
	s.mu.Unlock()
	switch {
	case !authorized:
		failure(w, http.StatusUnauthorized, "session_expired")
		return roomAccess{}, false
	case !roomExists:
		failure(w, http.StatusNotFound, "channel_not_found")
		return roomAccess{}, false
	case identity != "":
		var active []voiceMember
		var err error
		if fresh {
			active, err = s.media.participants(r.Context(), room)
		} else {
			active, err = s.presence.list(r.Context(), s.media, room)
		}
		if err != nil {
			failure(w, http.StatusBadGateway, "media_unavailable")
			return roomAccess{}, false
		}
		for _, user := range active {
			if user.ID == identity {
				// The caller holds the service lock after this second check.
				s.mu.Lock()
				_, fresh, ok := s.authenticated(key)
				l := s.leases[identity]
				if ok && l != nil && l.Cancel != nil && l.Session == key && l.Channel == channel {
					return roomAccess{account: fresh, lease: l, active: active}, true
				}
				s.mu.Unlock()
				break
			}
		}
	}
	failure(w, http.StatusForbidden, "join_voice_for_chat")
	return roomAccess{}, false
}

func (s *service) serveChat(w http.ResponseWriter, r *http.Request, key tokenKey) {
	if s.chat == nil {
		failure(w, http.StatusServiceUnavailable, "chat_unavailable")
		return
	}
	var req chatRequest
	var photo []byte
	var mime string
	if r.URL.Path == "/api/v1/chat/upload" {
		req.Channel = r.URL.Query().Get("channel")
		member, ok := s.chatAccount(w, r, key, req.Channel)
		if !ok {
			return
		}
		if s.rules(req.Channel, member.ID).Chat != 0 {
			s.mu.Unlock()
			failure(w, http.StatusForbidden, "chat_restricted")
			return
		}
		s.mu.Unlock()
		select {
		case s.uploads <- struct{}{}:
			defer func() { <-s.uploads }()
		default:
			failure(w, http.StatusTooManyRequests, "upload_busy")
			return
		}
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(100 * time.Second))
		photo, mime, req, ok = readUpload(w, r, req.Channel)
		if !ok {
			return
		}
	} else if !readBody(w, r, &req) {
		return
	}
	member, ok := s.chatAccount(w, r, key, req.Channel)
	if !ok {
		return
	}
	defer s.mu.Unlock()
	switch r.URL.Path {
	case "/api/v1/chat/history":
		if req.Limit < 1 || req.Limit > 30 || req.After != 0 && req.Before != 0 {
			failure(w, http.StatusBadRequest, "invalid_request")
			return
		}
		page, err := s.chat.page(req.Channel, req.Before, req.After, req.Limit, req.Known)
		if err != nil {
			failure(w, http.StatusInternalServerError, "chat_unavailable")
			return
		}
		response(w, http.StatusOK, page)
	case "/api/v1/chat/send", "/api/v1/chat/upload":
		if s.rules(req.Channel, member.ID).Chat != 0 {
			failure(w, http.StatusForbidden, "chat_restricted")
			return
		}
		text := strings.TrimSpace(req.Text)
		if (text == "" && len(photo) == 0) || !clientNonce.MatchString(req.Nonce) ||
			len(utf16.Encode([]rune(text))) > maxChatText || strings.ContainsFunc(text, func(r rune) bool {
			return unicode.IsControl(r) && r != '\n' && r != '\t'
		}) {
			failure(w, http.StatusBadRequest, "invalid_message")
			return
		}
		item, err := s.chat.append(chatMessage{Channel: req.Channel, Author: member.Name, AuthorID: member.ID,
			Text: text, Image: mime, ImageSize: len(photo), Time: time.Now().UTC(), Nonce: req.Nonce}, photo)
		switch {
		case errors.Is(err, errImageQuota):
			failure(w, http.StatusRequestEntityTooLarge, "media_quota")
		case err != nil:
			failure(w, http.StatusInternalServerError, "chat_unavailable")
		default:
			response(w, http.StatusOK, item)
		}
	case "/api/v1/chat/delete":
		if !channelID.MatchString(req.Channel) || s.channelRole(member, req.Channel) == roleMember {
			failure(w, http.StatusForbidden, "admin_required")
			return
		}
		err := s.chat.deleteMessage(req.Channel, req.ID)
		if errors.Is(err, errMissing) {
			failure(w, http.StatusNotFound, "message_not_found")
			return
		}
		if err != nil {
			failure(w, http.StatusInternalServerError, "chat_unavailable")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "/api/v1/chat/image":
		file, item, err := s.chat.image(req.Channel, req.ID)
		// Streaming a large image must not hold the service lock.
		s.mu.Unlock()
		defer s.mu.Lock()
		if err != nil {
			if errors.Is(err, errMissing) || os.IsNotExist(err) {
				failure(w, http.StatusNotFound, "image_not_found")
			} else {
				failure(w, http.StatusInternalServerError, "chat_unavailable")
			}
			return
		}
		defer file.Close()
		if req.Known == "cached" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", item.Image)
		w.Header().Set("Content-Length", strconv.Itoa(item.ImageSize))
		w.Header().Set("Content-Disposition", "inline")
		_, _ = io.CopyN(w, file, int64(item.ImageSize))
	default:
		failure(w, http.StatusNotFound, "not_found")
	}
}

func readUpload(w http.ResponseWriter, r *http.Request, channel string) ([]byte, string, chatRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImage+32*1024)
	req := chatRequest{Channel: channel}
	reader, err := r.MultipartReader()
	if err != nil {
		failure(w, http.StatusBadRequest, "invalid_request")
		return nil, "", req, false
	}
	var photo []byte
	fields := make(map[string]bool, 3)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			failure(w, http.StatusRequestEntityTooLarge, "image_too_large")
			return nil, "", req, false
		}
		name := part.FormName()
		if fields[name] || name != "image" && name != "text" && name != "nonce" {
			failure(w, http.StatusBadRequest, "invalid_request")
			return nil, "", req, false
		}
		fields[name] = true
		limit := int64(8192)
		if name == "image" {
			limit = maxImage
		}
		content, err := io.ReadAll(io.LimitReader(part, limit+1))
		if err != nil || int64(len(content)) > limit {
			failure(w, http.StatusRequestEntityTooLarge, "image_too_large")
			return nil, "", req, false
		}
		if err := part.Close(); err != nil {
			failure(w, http.StatusBadRequest, "invalid_request")
			return nil, "", req, false
		}
		switch name {
		case "text":
			req.Text = string(content)
		case "nonce":
			req.Nonce = string(content)
		case "image":
			photo = content
		}
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(photo))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 8192 || cfg.Height > 8192 ||
		int64(cfg.Width)*int64(cfg.Height) > 40_000_000 {
		failure(w, http.StatusBadRequest, "invalid_image")
		return nil, "", req, false
	}
	return photo, "image/" + format, req, true
}
