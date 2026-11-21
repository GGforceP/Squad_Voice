package main

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
)

const installerLimit = 32 * 1024 * 1024

var releaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$`)
var releaseHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

type releaseSource struct {
	root *os.Root
	key  *rsa.PublicKey
}

type releaseEnvelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type release struct {
	Platform string `json:"platform"`
	Version  string `json:"version"`
	File     string `json:"file"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	Required bool   `json:"required"`
}

func openReleaseSource(path, publicKeyPath string) (*releaseSource, error) {
	var encoded struct {
		Modulus string `json:"modulus"`
	}
	if err := readFile(publicKeyPath, &encoded); err != nil {
		return nil, errors.New("invalid release publisher key")
	}
	modulus, err := base64.StdEncoding.DecodeString(encoded.Modulus)
	if err != nil || len(modulus) != 384 {
		return nil, errors.New("invalid release publisher key")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &releaseSource{root: root, key: &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: 65537}}, nil
}

func (s *releaseSource) latest() (releaseEnvelope, release, error) {
	var envelope releaseEnvelope
	var info release
	manifest, err := s.root.Open("release.json")
	if err != nil {
		return envelope, info, err
	}
	defer manifest.Close()
	stat, err := manifest.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 8192 {
		return envelope, info, errors.New("invalid release file")
	}
	if err := decode(io.LimitReader(manifest, 8192), &envelope); err != nil {
		return envelope, info, err
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	signature, sigErr := base64.StdEncoding.DecodeString(envelope.Signature)
	hash := sha256.Sum256(payload)
	if err != nil || sigErr != nil || rsa.VerifyPKCS1v15(s.key, crypto.SHA256, hash[:], signature) != nil ||
		decode(bytes.NewReader(payload), &info) != nil || info.Platform != "win-x64" || !releaseVersion.MatchString(info.Version) ||
		info.File != "SquadVoice-"+info.Version+"-x64.exe" || !releaseHash.MatchString(info.SHA256) || info.Size < 1 || info.Size > installerLimit {
		return envelope, info, errors.New("invalid signed release")
	}
	return envelope, info, nil
}

func (s *service) clientRelease(w http.ResponseWriter, r *http.Request, key tokenKey) {
	s.mu.Lock()
	_, _, authorized := s.authenticated(key)
	s.mu.Unlock()
	if !authorized {
		failure(w, http.StatusUnauthorized, "session_expired")
		return
	}
	if s.updates == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var req struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	if !readBody(w, r, &req) {
		return
	}
	envelope, info, err := s.updates.latest()
	if errors.Is(err, os.ErrNotExist) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		failure(w, http.StatusServiceUnavailable, "update_unavailable")
		return
	}
	if r.URL.Path == "/api/v1/client/download" && (req.Version != info.Version || req.SHA256 != info.SHA256) {
		failure(w, http.StatusConflict, "update_changed")
		return
	}
	packageFile, err := s.updates.root.Open(info.File)
	if err != nil {
		failure(w, http.StatusServiceUnavailable, "update_unavailable")
		return
	}
	defer packageFile.Close()
	stat, err := packageFile.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() != info.Size {
		failure(w, http.StatusServiceUnavailable, "update_unavailable")
		return
	}
	if r.URL.Path == "/api/v1/client/update" {
		response(w, http.StatusOK, envelope)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="`+info.File+`"`)
	_, _ = io.CopyN(w, packageFile, info.Size)
}
