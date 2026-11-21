package main

import (
	"bufio"
	"compress/gzip"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

type ipRange struct {
	First netip.Addr `json:"first"`
	Last  netip.Addr `json:"last"`
}

type geoData struct {
	Source  string    `json:"source"`
	Month   string    `json:"month"`
	Country string    `json:"country,omitempty"`
	V4      []ipRange `json:"ipv4"`
	V6      []ipRange `json:"ipv6"`
}

const geoSource = "DB-IP Country Lite (https://db-ip.com/db/lite.php), CC BY 4.0"

var carrierNAT = netip.MustParsePrefix("100.64.0.0/10")
var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

func publicAddress(ip netip.Addr) bool {
	return ip.Zone() == "" && ip.IsGlobalUnicast() && !ip.IsPrivate() && !carrierNAT.Contains(ip)
}

func geoImport(r io.Reader, month, country string) (geoData, error) {
	g := geoData{Source: geoSource, Month: month, Country: strings.ToUpper(strings.TrimSpace(country))}
	if !countryCode.MatchString(g.Country) {
		return g, errors.New("choose a two-letter country code")
	}
	in := csv.NewReader(r)
	in.FieldsPerRecord = 3
	for {
		rec, err := in.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return g, err
		}
		if rec[2] != g.Country {
			continue
		}
		first, err1 := netip.ParseAddr(rec[0])
		last, err2 := netip.ParseAddr(rec[1])
		if err1 != nil || err2 != nil {
			return g, errors.New("invalid address in country range")
		}
		item := ipRange{first.Unmap(), last.Unmap()}
		if item.First.Is4() {
			g.V4 = append(g.V4, item)
		} else {
			g.V6 = append(g.V6, item)
		}
	}
	for _, entries := range [][]ipRange{g.V4, g.V6} {
		slices.SortFunc(entries, func(a, b ipRange) int { return a.First.Compare(b.First) })
	}
	return g, g.validate()
}

func (g geoData) validate() error {
	if _, err := time.Parse("2006-01", g.Month); err != nil || g.Source != geoSource || len(g.V4) == 0 || len(g.V6) == 0 {
		return errors.New("missing DB-IP country data")
	}
	if g.Country != "" && !countryCode.MatchString(g.Country) {
		return errors.New("invalid country code in DB-IP data")
	}
	for _, entries := range [][]ipRange{g.V4, g.V6} {
		for i, entry := range entries {
			if !publicAddress(entry.First) || !publicAddress(entry.Last) ||
				entry.First.BitLen() != entry.Last.BitLen() || entry.First.BitLen() != entries[0].First.BitLen() ||
				entry.First.Compare(entry.Last) > 0 || (i > 0 && entries[i-1].Last.Compare(entry.First) >= 0) {
				return errors.New("invalid or overlapping country ranges")
			}
		}
	}
	if !g.V4[0].First.Is4() || !g.V6[0].First.Is6() || g.V6[0].First.Is4In6() {
		return errors.New("country data IP family mismatch")
	}
	return nil
}

func loadGeo(path string) (geoData, error) {
	var g geoData
	if err := readFile(path, &g); err != nil {
		return g, err
	}
	return g, g.validate()
}

func (g geoData) allows(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !publicAddress(ip) {
		return false
	}
	entries := g.V6
	if ip.Is4() {
		entries = g.V4
	}
	i := sort.Search(len(entries), func(i int) bool { return entries[i].Last.Compare(ip) >= 0 })
	return i < len(entries) && entries[i].First.Compare(ip) <= 0
}

func importGeoFile(input, month, country, output string) error {
	f, err := os.Open(input)
	if err != nil {
		return err
	}
	defer f.Close()
	var reader io.Reader = f
	if strings.HasSuffix(input, ".gz") {
		z, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer z.Close()
		reader = z
	}
	g, err := geoImport(reader, month, country)
	if err != nil {
		return err
	}
	if err := writeFile(output, g, 0644); err != nil {
		return err
	}
	fmt.Printf("DB-IP %s %s: %d IPv4 ranges, %d IPv6 ranges\n", g.Country, g.Month, len(g.V4), len(g.V6))
	return nil
}

func (g geoData) nft(w io.Writer) error {
	out := bufio.NewWriter(w)
	fmt.Fprintln(out, "table inet squadvoice {")
	for _, set := range []struct {
		name, addrType string
		entries        []ipRange
	}{{"allowed4", "ipv4_addr", g.V4}, {"allowed6", "ipv6_addr", g.V6}} {
		fmt.Fprintf(out, "  set %s { type %s; flags interval; auto-merge; elements = {\n", set.name, set.addrType)
		for i, ip := range set.entries {
			if i > 0 {
				fmt.Fprintln(out, ",")
			}
			fmt.Fprintf(out, "    %s", ip.First)
			if ip.First != ip.Last {
				fmt.Fprintf(out, "-%s", ip.Last)
			}
		}
		fmt.Fprintln(out, "\n  }; }")
	}
	fmt.Fprintln(out, `  chain input {
    type filter hook input priority filter; policy accept;
    iifname "lo" accept
    tcp dport 7880 counter drop
    tcp dport 7881 ip saddr @allowed4 accept
    tcp dport 7881 ip6 saddr @allowed6 accept
    tcp dport 7881 counter drop
    udp dport 7882 ip saddr @allowed4 accept
    udp dport 7882 ip6 saddr @allowed6 accept
    udp dport 7882 counter drop
  }
}`)
	return out.Flush()
}
