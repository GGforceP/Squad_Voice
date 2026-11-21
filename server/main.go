package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	adminSocket  = "/tmp/squadvoice/admin.sock"
	publicSocket = "/run/squadvoice/api.sock"
	configDir    = "/config"
)

var hostName = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	config := flags.String("config", configDir, "directory containing geo.json and keys.json")
	data := flags.String("data", "/data", "account state directory")
	adminPath := flags.String("admin-socket", adminSocket, "private administration socket")
	publicPath := flags.String("public-socket", publicSocket, "socket shared with TLS proxy")
	if err := flags.Parse(args); err != nil {
		return err
	}
	host := os.Getenv("SQUADVOICE_HOST")
	if !hostName.MatchString(host) || len(host) > 253 || !strings.Contains(host, ".") {
		return errors.New("SQUADVOICE_HOST must be the public IPv4 address or DNS name, without scheme or port")
	}
	g, err := loadGeo(filepath.Join(*config, "geo.json"))
	if err != nil {
		return err
	}
	key, secret, err := loadKeys(filepath.Join(*config, "keys.json"))
	if err != nil {
		return err
	}
	quota, err := cacheQuota(os.Getenv("cachesize"))
	if err != nil {
		return err
	}
	svc, err := newServiceWithQuota(filepath.Join(*data, "state.json"), g, newMedia("http://127.0.0.1:7880", key, secret),
		(&url.URL{Scheme: "wss", Host: host}).String(), quota)
	if err != nil {
		return err
	}
	defer svc.chat.close()
	svc.ownerName = strings.ToLower(strings.TrimSpace(os.Getenv("SQUADVOICE_OWNER")))
	if svc.ownerName != "" && !accountName.MatchString(svc.ownerName) {
		return errors.New("SQUADVOICE_OWNER must be an account login name")
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ClientUdtCHK"))) {
	case "", "false":
	case "true":
		svc.updates, err = openReleaseSource("/Client-Installer", filepath.Join(*config, "update-key.json"))
		if err != nil {
			return fmt.Errorf("opening the client installer mount: %w", err)
		}
		defer svc.updates.root.Close()
	default:
		return errors.New("ClientUdtCHK must be true or false")
	}
	if err := os.MkdirAll(filepath.Dir(*adminPath), 0700); err != nil {
		return err
	}
	inside, err := unixListener(*adminPath, 0600)
	if err != nil {
		return err
	}
	defer inside.Close()
	edge, err := unixListener(*publicPath, 0660)
	if err != nil {
		return err
	}
	defer edge.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	servers := []*http.Server{
		{Handler: http.HandlerFunc(svc.serveAdmin), ReadTimeout: 6 * time.Second, WriteTimeout: 25 * time.Second},
		{Handler: http.HandlerFunc(svc.servePublic), ReadHeaderTimeout: 4 * time.Second, ReadTimeout: 8 * time.Second,
			IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16384},
	}
	failed := make(chan error, 2)
	go func() { failed <- servers[0].Serve(inside) }()
	go func() { failed <- servers[1].Serve(edge) }()
	go func() {
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				svc.mu.Lock()
				svc.expire(time.Now())
				svc.mu.Unlock()
			case <-ctx.Done():
				return
			}
		}
	}()
	log.Printf("Squad Voice ready with DB-IP country data from %s", g.Month)
	select {
	case err = <-failed:
	case <-ctx.Done():
	}
	svc.mu.Lock()
	svc.remove(svc.cut(func(*lease) bool { return true }))
	svc.mu.Unlock()
	shutdown, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	for _, server := range servers {
		_ = server.Shutdown(shutdown)
	}
	return err
}

func unixListener(path string, mode os.FileMode) (*net.UnixListener, error) {
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("socket path is occupied by another file")
		}
		if conn, err := net.DialTimeout("unix", path, time.Second); err == nil {
			conn.Close()
			return nil, errors.New("socket already has an active server")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, mode); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func loadKeys(path string) (string, string, error) {
	var keys map[string]string
	if err := readFile(path, &keys); err != nil {
		return "", "", errors.New("could not read the private media key file")
	}
	for key, secret := range keys {
		if len(keys) == 1 && len(key) >= 12 && len(secret) >= 43 {
			return key, secret, nil
		}
	}
	return "", "", errors.New("invalid private media key file")
}

func keyInit(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: squadvoice key-init PATH")
	}
	if _, err := os.Lstat(args[0]); !errors.Is(err, os.ErrNotExist) {
		_, _, err = loadKeys(args[0])
		return err
	}
	// Exclusive creation prevents an accidental concurrent key rotation.
	file, err := os.OpenFile(args[0], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := fmt.Fprintf(file, "{%q:%q}\n", "sv_"+randomToken(12), randomToken(48)); err != nil {
		return err
	}
	return file.Sync()
}

func geoCLI(args []string) error {
	if len(args) == 5 && args[0] == "import" {
		return importGeoFile(args[1], args[2], args[3], args[4])
	}
	if len(args) < 2 {
		return errors.New("usage: squadvoice geo import INPUT YYYY-MM COUNTRY OUTPUT | nft GEO | check GEO IP...")
	}
	g, err := loadGeo(args[1])
	if err != nil {
		return err
	}
	switch args[0] {
	case "nft":
		return g.nft(os.Stdout)
	case "check":
		for _, value := range args[2:] {
			ip, err := netip.ParseAddr(value)
			if err != nil {
				return errors.New("invalid IP address")
			}
			fmt.Printf("%s allowed=%t\n", value, g.allows(ip))
		}
		return nil
	default:
		return errors.New("unknown geo command")
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: squadvoice serve | admin | key-init | geo")
	}
	switch args[0] {
	case "serve":
		return serve(args[1:])
	case "admin":
		return adminCLI(args[1:])
	case "key-init":
		return keyInit(args[1:])
	case "geo":
		return geoCLI(args[1:])
	case "livekit-config":
		ip, err := netip.ParseAddr(os.Getenv("SQUADVOICE_PUBLIC_IPV4"))
		if err != nil || !ip.Is4() || !publicAddress(ip) {
			return errors.New("SQUADVOICE_PUBLIC_IPV4 must be a public IPv4 address")
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{
			"port": 7880, "bind_addresses": []string{"127.0.0.1"},
			"rtc":  map[string]any{"node_ip": ip, "use_external_ip": false, "tcp_port": 7881, "udp_port": 7882},
			"room": map[string]bool{"auto_create": false},
			"turn": map[string]bool{"enabled": false},
		})
	case "media-health":
		conn, err := net.DialTimeout("tcp4", "127.0.0.1:7880", time.Second)
		if err != nil {
			return errors.New("LiveKit is still starting")
		}
		return conn.Close()
	default:
		return errors.New("unknown command")
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
