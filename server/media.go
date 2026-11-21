package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const mediaTokenTTL = 90 * time.Second

// LiveKit's documented video grant also carries audio permissions.
type mediaGrant struct {
	Room                 string   `json:"room,omitempty"`
	RoomJoin             bool     `json:"roomJoin,omitempty"`
	RoomCreate           bool     `json:"roomCreate,omitempty"`
	RoomAdmin            bool     `json:"roomAdmin,omitempty"`
	CanSubscribe         *bool    `json:"canSubscribe,omitempty"`
	CanPublish           *bool    `json:"canPublish,omitempty"`
	CanPublishData       *bool    `json:"canPublishData,omitempty"`
	CanUpdateOwnMetadata *bool    `json:"canUpdateOwnMetadata,omitempty"`
	CanPublishSources    []string `json:"canPublishSources,omitempty"`
}

type mediaClaims struct {
	jwt.RegisteredClaims
	Name  string     `json:"name,omitempty"`
	Video mediaGrant `json:"video"`
}

type media struct {
	key, secret string
	origin      *url.URL
	http        *http.Client
	proxy       *httputil.ReverseProxy
}

func newMedia(origin, key, secret string) *media {
	upstream, err := url.Parse(origin)
	if err != nil {
		panic("invalid internal media address")
	}
	m := &media{key: key, secret: secret, origin: upstream, http: &http.Client{
		Timeout:       3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{MaxIdleConnsPerHost: 5, IdleConnTimeout: 30 * time.Second},
	}}
	m.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(m.origin)
			r.Out.Header.Del("X-SquadVoice-Peer")
		},
		Transport: m.http.Transport,
		ErrorLog:  log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			failure(w, http.StatusBadGateway, "media_unavailable")
		},
	}
	return m
}

func (m *media) ticket(identity, name, room string, rules roomRules) (string, error) {
	allow, deny, subscribe := true, false, rules.Listen == 0
	return m.sign(identity, name, mediaTokenTTL, mediaGrant{
		Room: room, RoomJoin: true, CanSubscribe: &subscribe, CanPublish: &allow,
		CanPublishSources: rules.publishSources(), CanPublishData: &deny,
		CanUpdateOwnMetadata: &deny,
	})
}

func (m *media) restrict(l *lease, rules roomRules) error {
	return m.rpc(context.Background(), "UpdateParticipant", mediaGrant{Room: l.Room, RoomAdmin: true}, map[string]any{
		"room": l.Room, "identity": l.Identity,
		"permission": map[string]any{
			"can_subscribe": rules.Listen == 0, "can_publish": true, "can_publish_data": false,
			"can_publish_sources": rules.publishSources(), "can_update_metadata": false,
		},
	})
}

func (m *media) sign(identity, name string, ttl time.Duration, grant mediaGrant) (string, error) {
	now := time.Now()
	claims := mediaClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: m.key, Subject: identity, ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			NotBefore: jwt.NewNumericDate(now),
		},
		Name: name, Video: grant,
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(m.secret))
}

func (m *media) verify(token string) (identity, room string, ok bool) {
	if len(token) > 8192 {
		return "", "", false
	}
	var claims mediaClaims
	_, err := jwt.ParseWithClaims(token, &claims, func(*jwt.Token) (any, error) {
		return []byte(m.secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(m.key), jwt.WithExpirationRequired())
	if err != nil || !claims.Video.RoomJoin || claims.Subject == "" {
		return "", "", false
	}
	return claims.Subject, claims.Video.Room, true
}

func (m *media) rpc(ctx context.Context, method string, grant mediaGrant, data any) error {
	return m.call(ctx, method, grant, data, nil)
}

func (m *media) call(ctx context.Context, method string, grant mediaGrant, data, result any) error {
	token, err := m.sign("", "", 15*time.Second, grant)
	if err != nil {
		return err
	}
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}
	target := m.origin.JoinPath("twirp", "livekit.RoomService", method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.http.Do(req)
	if err != nil {
		return errors.New("LiveKit control connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound && method == "RemoveParticipant" {
		return nil
	}
	if resp.StatusCode == http.StatusNotFound && method == "ListParticipants" {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return errors.New("LiveKit rejected " + method)
	}
	limited := io.LimitReader(resp.Body, 65536)
	if result != nil {
		return json.NewDecoder(limited).Decode(result)
	}
	_, err = io.Copy(io.Discard, limited)
	return err
}

func (m *media) create(ctx context.Context, name string, max int) error {
	return m.rpc(ctx, "CreateRoom", mediaGrant{RoomCreate: true}, map[string]any{
		"name": name, "max_participants": max, "empty_timeout": 30, "departure_timeout": 15,
	})
}

func (m *media) remove(l *lease) {
	err := m.rpc(context.Background(), "RemoveParticipant", mediaGrant{Room: l.Room, RoomAdmin: true},
		map[string]string{"room": l.Room, "identity": l.Identity})
	if err != nil {
		log.Print("LiveKit participant removal failed; signaling has been closed")
	}
}

func bearer(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(value, "Bearer ")
}
