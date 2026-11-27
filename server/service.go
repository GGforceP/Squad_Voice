package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const sessionTTL = 12 * time.Hour
const reconnectGrace = 40 * time.Second

type session struct {
	UserID  string
	Expires time.Time
}

type lease struct {
	Identity string
	UserID   string
	Session  tokenKey
	Channel  string
	Room     string
	Until    time.Time
	Cancel   context.CancelFunc
}

type attempt struct {
	Count int
	Until time.Time
}

type service struct {
	mu        sync.Mutex
	path      string
	state     state
	geo       geoData
	media     *media
	voiceURL  string
	sessions  map[tokenKey]session
	leases    map[string]*lease
	attempts  map[string]attempt
	hashSlots chan struct{}
	dummyHash string
	chat      *chatStore
	presence  presenceCache
	uploads   chan struct{}
	ownerName string
	updates   *releaseSource
}

func newService(path string, g geoData, m *media, voiceURL string) (*service, error) {
	return newServiceWithQuota(path, g, m, voiceURL, defaultCache)
}

func newServiceWithQuota(path string, g geoData, m *media, voiceURL string, quota uint64) (*service, error) {
	s, err := loadState(path)
	if err != nil {
		return nil, err
	}
	chat, err := openChat(filepath.Join(filepath.Dir(path), "mediacache"), quota, s)
	if err != nil {
		return nil, err
	}
	return &service{
		path: path, state: s, geo: g, media: m, voiceURL: voiceURL, dummyHash: hashPassword(randomToken(24)),
		sessions: make(map[tokenKey]session), leases: make(map[string]*lease), attempts: make(map[string]attempt),
		hashSlots: make(chan struct{}, 2), chat: chat, uploads: make(chan struct{}, 2),
	}, nil
}

func (s *service) commit(next state) error {
	if err := writeFile(s.path, next, 0600); err != nil {
		return err
	}
	s.state = next
	return nil
}

func (s *service) attempt(key string, max int, now time.Time) bool {
	a := s.attempts[key]
	if now.After(a.Until) {
		if len(s.attempts) >= 4096 {
			return false
		}
		a = attempt{Until: now.Add(10 * time.Minute)}
	}
	if a.Count >= max {
		return false
	}
	a.Count++
	s.attempts[key] = a
	return true
}

func (s *service) servePublic(w http.ResponseWriter, r *http.Request) {
	// Only the TLS proxy can reach this Unix socket. It replaces this header
	// with the TCP peer's address on every request.
	var ip netip.Addr
	if values := r.Header.Values("X-SquadVoice-Peer"); len(values) == 1 {
		ip, _ = netip.ParseAddr(values[0])
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !s.geo.allows(ip) {
		failure(w, http.StatusForbidden, "region_not_allowed")
		return
	}
	if r.Method == http.MethodGet && (r.URL.Path == "/rtc" || r.URL.Path == "/rtc/validate" || r.URL.Path == "/rtc/v1") {
		s.signal(w, r)
		return
	}
	if r.Method != http.MethodPost {
		failure(w, http.StatusNotFound, "not_found")
		return
	}
	if r.URL.Path == "/api/v1/login" {
		s.login(w, r, ip.Unmap())
		return
	}
	key := digest(bearer(r))
	switch r.URL.Path {
	case "/api/v1/workspace":
		s.workspace(w, r, key)
		return
	case "/api/v1/chat/watch":
		s.chatWatch(w, r, key)
		return
	case "/api/v1/chat/history", "/api/v1/chat/send", "/api/v1/chat/upload", "/api/v1/chat/delete", "/api/v1/chat/image":
		s.serveChat(w, r, key)
		return
	case "/api/v1/member/control":
		s.memberControl(w, r, key)
		return
	case "/api/v1/client/update", "/api/v1/client/download":
		s.clientRelease(w, r, key)
		return
	}
	s.mu.Lock()
	current, member, ok := s.authenticated(key)
	if !ok {
		s.mu.Unlock()
		failure(w, http.StatusUnauthorized, "session_expired")
		return
	}
	defer s.mu.Unlock()
	switch r.URL.Path {
	case "/api/v1/group/create", "/api/v1/group/update", "/api/v1/group/delete":
		s.groupCommand(w, r, member)
	case "/api/v1/channel/create", "/api/v1/channel/update", "/api/v1/channel/delete":
		s.channelCommand(w, r, member)
	case "/api/v1/account/me":
		response(w, http.StatusOK, s.identity(member))
	case "/api/v1/account/profile":
		s.profile(w, r, current)
	case "/api/v1/account/password":
		s.password(w, r, current)
	case "/api/v1/voice/join":
		s.join(w, r, key, current)
	case "/api/v1/voice/leave":
		var body struct {
			Lease string `json:"leaseId"`
		}
		if !readBody(w, r, &body) {
			return
		}
		s.remove(s.cut(func(l *lease) bool { return l.Session == key && l.Identity == body.Lease }))
		w.WriteHeader(http.StatusNoContent)
	case "/api/v1/logout":
		delete(s.sessions, key)
		s.remove(s.cut(func(l *lease) bool { return l.Session == key }))
		w.WriteHeader(http.StatusNoContent)
	default:
		failure(w, http.StatusNotFound, "not_found")
	}
}

func (s *service) login(w http.ResponseWriter, r *http.Request, ip netip.Addr) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readBody(w, r, &body) {
		return
	}
	name := strings.ToLower(strings.TrimSpace(body.Username))
	if !accountName.MatchString(name) || len(body.Password) > 512 {
		failure(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	now := time.Now()
	s.mu.Lock()
	a, known := s.state.Accounts[name]
	ok := s.attempt("ip:"+ip.String(), 30, now)
	if ok && known {
		ok = s.attempt("user:"+a.ID, 10, now)
	}
	s.mu.Unlock()
	if !ok {
		failure(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	select {
	case s.hashSlots <- struct{}{}:
	case <-r.Context().Done():
		return
	}
	hash := s.dummyHash
	if known {
		hash = a.Password
	}
	valid := checkPassword(hash, body.Password)
	<-s.hashSlots
	s.mu.Lock()
	defer s.mu.Unlock()
	fresh, exists := s.state.Accounts[name]
	if !valid || !known || !exists || !fresh.Enabled || fresh.ID != a.ID || fresh.Password != a.Password {
		failure(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	delete(s.attempts, "user:"+a.ID)
	token := randomToken(32)
	// Keep one desktop login per account; replacing it also closes old voice.
	s.remove(s.revoke(fresh.ID))
	s.sessions[digest(token)] = session{UserID: fresh.ID, Expires: now.Add(sessionTTL)}
	response(w, http.StatusOK, map[string]any{
		"sessionToken": token,
		"user":         s.identity(fresh),
		"workspace":    map[string]any{"name": s.state.Workspace, "channels": s.channels()},
	})
}

func (s *service) accountByID(id string) (string, account) {
	for name, a := range s.state.Accounts {
		if a.ID == id {
			return name, a
		}
	}
	return "", account{}
}

func (s *service) channels() []channel {
	items := make([]channel, 0, len(s.state.Channels))
	for _, ch := range s.state.Channels {
		items = append(items, ch)
	}
	slices.SortFunc(items, func(a, b channel) int { return strings.Compare(a.ID, b.ID) })
	return items
}

func (s *service) profile(w http.ResponseWriter, r *http.Request, current session) {
	var body struct {
		Name string `json:"name"`
		Bio  string `json:"bio"`
	}
	if !readBody(w, r, &body) {
		return
	}
	body.Name, body.Bio = strings.TrimSpace(body.Name), strings.TrimSpace(body.Bio)
	if !validText(body.Name, 64, false) || !validText(body.Bio, 160, true) {
		failure(w, http.StatusBadRequest, "invalid_profile")
		return
	}
	name, a := s.accountByID(current.UserID)
	a.Name, a.Bio = body.Name, body.Bio
	next := s.state.copy()
	next.Accounts[name] = a
	if s.commit(next) != nil {
		failure(w, http.StatusInternalServerError, "storage_unavailable")
		return
	}
	response(w, http.StatusOK, s.identity(a))
}

func (s *service) password(w http.ResponseWriter, r *http.Request, current session) {
	var body struct {
		Current string `json:"currentPassword"`
		New     string `json:"newPassword"`
	}
	if !readBody(w, r, &body) {
		return
	}
	if !validPassword(body.New) || len(body.Current) > 512 || body.New == body.Current {
		failure(w, http.StatusBadRequest, "invalid_new_password")
		return
	}
	name, a := s.accountByID(current.UserID)
	if !s.attempt("password:"+a.ID, 5, time.Now()) {
		failure(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if !checkPassword(a.Password, body.Current) {
		failure(w, http.StatusBadRequest, "incorrect_current_password")
		return
	}
	a.Password = hashPassword(body.New)
	next := s.state.copy()
	next.Accounts[name] = a
	if s.commit(next) != nil {
		failure(w, http.StatusInternalServerError, "storage_unavailable")
		return
	}
	delete(s.attempts, "password:"+a.ID)
	s.remove(s.revoke(a.ID))
	w.WriteHeader(http.StatusNoContent)
}

func (s *service) join(w http.ResponseWriter, r *http.Request, key tokenKey, current session) {
	var body struct {
		Channel string `json:"channelId"`
	}
	if !readBody(w, r, &body) {
		return
	}
	ch, ok := s.state.Channels[body.Channel]
	if !ok {
		failure(w, http.StatusForbidden, "channel_not_allowed")
		return
	}
	now := time.Now()
	s.expire(now)
	total, occupants := 0, 0
	for _, l := range s.leases {
		if l.UserID != current.UserID {
			total++
			if l.Channel == ch.ID {
				occupants++
			}
		}
	}
	if total >= capacity || occupants >= ch.Capacity {
		failure(w, http.StatusConflict, "room_full")
		return
	}
	room := fmt.Sprintf("%s-%d", ch.ID, ch.Capacity)
	if s.media.create(r.Context(), room, ch.Capacity) != nil {
		failure(w, http.StatusBadGateway, "media_unavailable")
		return
	}
	_, a := s.accountByID(current.UserID)
	l := &lease{
		Identity: a.ID + "_" + randomToken(12), UserID: a.ID, Session: key,
		Channel: ch.ID, Room: room, Until: time.Now().Add(mediaTokenTTL),
	}
	rules := s.rules(ch.ID, a.ID)
	ticket, err := s.media.ticket(l.Identity, a.Name, room, rules)
	if err != nil {
		failure(w, http.StatusBadGateway, "media_unavailable")
		return
	}
	s.remove(s.cut(func(l *lease) bool { return l.UserID == current.UserID }))
	s.leases[l.Identity] = l
	response(w, http.StatusOK, map[string]any{"serverUrl": s.voiceURL, "accessToken": ticket, "leaseId": l.Identity, "rules": rules})
}

func (s *service) signal(w http.ResponseWriter, r *http.Request) {
	token := bearer(r)
	if token == "" {
		token = r.URL.Query().Get("access_token")
	}
	id, room, ok := s.media.verify(token)
	if !ok {
		failure(w, http.StatusUnauthorized, "voice_ticket_invalid")
		return
	}
	s.mu.Lock()
	l, found := s.leases[id]
	now := time.Now()
	if !found || l.Room != room || (l.Cancel == nil && !now.Before(l.Until)) ||
		!now.Before(s.sessions[l.Session].Expires) {
		s.mu.Unlock()
		failure(w, http.StatusUnauthorized, "voice_ticket_expired")
		return
	}
	_, account := s.accountByID(l.UserID)
	// LiveKit refreshes connected participants' tokens. Rewrite every new
	// upstream handshake so an earlier grant cannot override current room rules.
	fresh, err := s.media.ticket(id, account.Name, room, s.rules(l.Channel, l.UserID))
	if err != nil {
		s.mu.Unlock()
		failure(w, http.StatusBadGateway, "media_unavailable")
		return
	}
	r = r.Clone(r.Context())
	query := r.URL.Query()
	query.Set("access_token", fresh)
	r.URL.RawQuery = query.Encode()
	r.Header.Set("Authorization", "Bearer "+fresh)
	if r.URL.Path == "/rtc/validate" {
		s.mu.Unlock()
		s.media.proxy.ServeHTTP(w, r)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.mu.Unlock()
		failure(w, http.StatusBadRequest, "websocket_required")
		return
	}
	if l.Cancel != nil {
		s.mu.Unlock()
		failure(w, http.StatusConflict, "voice_connected")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	l.Cancel = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		l.Cancel = nil
		l.Until = time.Now().Add(reconnectGrace)
		s.mu.Unlock()
	}()
	s.media.proxy.ServeHTTP(w, r.WithContext(ctx))
}

func (s *service) cut(match func(*lease) bool) []*lease {
	var removed []*lease
	for id, l := range s.leases {
		if !match(l) {
			continue
		}
		delete(s.leases, id)
		if l.Cancel != nil {
			l.Cancel()
		}
		removed = append(removed, l)
	}
	return removed
}

func (s *service) revoke(userID string) []*lease {
	for key, value := range s.sessions {
		if value.UserID == userID {
			delete(s.sessions, key)
		}
	}
	return s.cut(func(l *lease) bool { return l.UserID == userID })
}

func (s *service) remove(removed []*lease) {
	// Identity is unique to a ticket, so removal can never kick a newer login.
	for _, l := range removed {
		s.media.remove(l)
	}
}

func (s *service) expire(now time.Time) {
	for key, value := range s.sessions {
		if !now.Before(value.Expires) {
			delete(s.sessions, key)
		}
	}
	for key, a := range s.attempts {
		if !now.Before(a.Until) {
			delete(s.attempts, key)
		}
	}
	s.remove(s.cut(func(l *lease) bool {
		_, ok := s.sessions[l.Session]
		return !ok || (l.Cancel == nil && !now.Before(l.Until))
	}))
}

func readBody(w http.ResponseWriter, r *http.Request, dest any) bool {
	if err := decode(http.MaxBytesReader(w, r.Body, 8192), dest); err != nil {
		failure(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	return true
}

func response(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func failure(w http.ResponseWriter, status int, code string) {
	w.Header().Set("X-SquadVoice-Error", code)
	response(w, status, map[string]string{"code": code})
}
