package tunnel

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var testKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))

func TestParseLink(t *testing.T) {
	urlKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xfb}, 32)) // has '-'/'_'
	cfg, err := ParseLink("velta://tunnel?v=1&zone=T.Example.ORG.&key=" + urlKey + "&r=1.2.3.4:53,1.2.3.4:53,%5B2001:db8::1%5D:853,9.9.9.9&c=example.com:443,example.net")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Zone != "t.example.org" {
		t.Errorf("zone %q", cfg.Zone)
	}
	if want := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xfb}, 32)); cfg.Key != want {
		t.Errorf("key not normalized: %q", cfg.Key)
	}
	if got := strings.Join(cfg.Resolvers, ","); got != "1.2.3.4:53,[2001:db8::1]:853,9.9.9.9:53" {
		t.Errorf("resolvers %q", got)
	}
	if strings.Join(cfg.Canaries, ",") != "example.com:443,example.net:443" || cfg.Mode != ModeAuto || cfg.Listen != "127.0.0.1:0" {
		t.Errorf("defaults: %+v", cfg)
	}

	cfg, err = ParseLink("velta://tunnel?zone=t.example.org&key=" + testKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Resolvers) != 0 || cfg.Canaries != nil {
		t.Errorf("a link without r/c must not freeze today's defaults: %+v", cfg)
	}
	if n, _ := cfg.Normalize(); len(n.Effective()) != len(DefaultResolvers) || len(n.Canaries) != len(DefaultCanaries) {
		t.Errorf("defaults not applied at start: %+v", n)
	}

	for _, bad := range []string{
		"https://tunnel?zone=t.example.org&key=" + testKey,
		"velta://chat?zone=t.example.org&key=" + testKey,
		"velta://tunnel?v=2&zone=t.example.org&key=" + testKey,
		"velta://tunnel?zone=example&key=" + testKey,
		"velta://tunnel?zone=bad_label.example.org&key=" + testKey,
		"velta://tunnel?zone=t.example.org&key=c2hvcnQ=",
		"velta://tunnel?zone=t.example.org&key=" + testKey + "&r=dns.example.org:53",
		"velta://tunnel?zone=t.example.org&key=" + testKey + "&r=1.2.3.4:0",
	} {
		if _, err := ParseLink(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestDecide(t *testing.T) {
	blocked := probeResult{Relays: 2, CanaryOK: true}
	ok := probeResult{Relays: 2, RelayOK: 1, CanaryOK: true}
	offline := probeResult{Relays: 2}

	r, f, _, s := decide(RouteDirect, blocked, 0, 0)
	if r != RouteDirect || f != 1 || s != "blocked" {
		t.Fatalf("one blocked probe must not switch yet: %v %d %s", r, f, s)
	}
	r, f, _, _ = decide(r, blocked, f, 0)
	if r != RouteTunnel {
		t.Fatalf("second blocked probe must switch to the tunnel")
	}
	r, f, _, s = decide(r, offline, f, 0)
	if r != RouteTunnel || s != "offline" {
		t.Fatalf("offline must not change the route: %v %s", r, s)
	}
	k := 0
	for i := 1; i <= recoveredAfter; i++ {
		r, f, k, _ = decide(r, ok, f, k)
		if i < recoveredAfter && r != RouteTunnel {
			t.Fatalf("switched back after %d ok probes", i)
		}
	}
	if r != RouteDirect || f != 0 {
		t.Fatalf("must return to direct after %d ok probes", recoveredAfter)
	}
	if r2, _, _, s := decide(RouteDirect, probeResult{}, 0, 0); r2 != RouteDirect || s != "unknown" {
		t.Fatalf("no known relays must change nothing")
	}
}

// newTestTunnel builds a Tunnel without a soar client, with fake dialers.
func newTestTunnel(t *testing.T, mode string, direct, tun dialFunc) *Tunnel {
	t.Helper()
	cfg, err := Config{Zone: "t.example.org", Key: testKey, Mode: mode, User: "u", Pass: "p"}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	tt := &Tunnel{cfg: cfg, log: newEventLog(100), kick: make(chan struct{}, 1), mode: mode,
		conns: map[*tracked]struct{}{}, relays: map[string]time.Time{}, state: "unknown",
		dialDirect: direct, dialTunnel: tun,
		probeTLS: func(context.Context, string, string) error { return errors.New("no probes in tests") }}
	tt.ctx, tt.cancel = context.WithCancel(context.Background())
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tt.ln = ln
	tt.setRouteLocked(initialRoute(mode), "start")
	tt.wg.Add(1)
	go tt.serve()
	t.Cleanup(tt.Close)
	return tt
}

// echoDialer returns one end of a pipe whose far end echoes with a prefix.
func echoDialer(prefix string, calls *atomic.Int32) dialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		calls.Add(1)
		a, b := net.Pipe()
		go func() {
			defer b.Close()
			buf := make([]byte, 64)
			n, _ := b.Read(buf)
			b.Write(append([]byte(prefix), buf[:n]...))
		}()
		return a, nil
	}
}

func failDialer(calls *atomic.Int32) dialFunc {
	return func(context.Context, string, string) (net.Conn, error) {
		calls.Add(1)
		return nil, errors.New("blocked")
	}
}

// socksConnect performs a client-side SOCKS5 handshake with user/pass auth.
func socksConnect(t *testing.T, addr, user, pass, target string) (net.Conn, byte) {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	c.Write([]byte{5, 1, 2})
	r := make([]byte, 2)
	io.ReadFull(c, r)
	if r[1] != 2 {
		t.Fatalf("server chose method %d", r[1])
	}
	c.Write(append(append(append([]byte{1, byte(len(user))}, user...), byte(len(pass))), pass...))
	io.ReadFull(c, r)
	if r[1] != 0 {
		return c, 0xff
	}
	host, port, _ := net.SplitHostPort(target)
	req := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
	var p int
	for _, ch := range port {
		p = p*10 + int(ch-'0')
	}
	req = append(req, byte(p>>8), byte(p))
	c.Write(req)
	rep := make([]byte, 10)
	if _, err := io.ReadFull(c, rep); err != nil {
		t.Fatal(err)
	}
	return c, rep[1]
}

func roundTrip(t *testing.T, c net.Conn) string {
	t.Helper()
	c.Write([]byte("hi"))
	b, _ := io.ReadAll(c)
	return string(b)
}

func TestAuthRequired(t *testing.T) {
	var d atomic.Int32
	tt := newTestTunnel(t, ModeAuto, echoDialer("D:", &d), echoDialer("T:", &d))
	c, code := socksConnect(t, tt.Addr(), "u", "wrong", "relay.example.org:993")
	defer c.Close()
	if code != 0xff || d.Load() != 0 {
		t.Fatalf("bad password must be refused before dialing (code %d, dials %d)", code, d.Load())
	}
}

func TestDirectThenFallback(t *testing.T) {
	var direct, tun atomic.Int32
	var blocked atomic.Bool // the dialer is read from server goroutines: flip a flag, not the field
	works, fails := echoDialer("D:", &direct), failDialer(&direct)
	switchable := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if blocked.Load() {
			return fails(ctx, network, addr)
		}
		return works(ctx, network, addr)
	}
	tt := newTestTunnel(t, ModeAuto, switchable, echoDialer("T:", &tun))
	c, code := socksConnect(t, tt.Addr(), "u", "p", "relay.example.org:993")
	if code != repSucceeded {
		t.Fatalf("connect failed: %d", code)
	}
	if got := roundTrip(t, c); got != "D:hi" {
		t.Fatalf("direct route: got %q", got)
	}
	c.Close()

	blocked.Store(true)
	c, code = socksConnect(t, tt.Addr(), "u", "p", "relay.example.org:993")
	if code != repSucceeded {
		t.Fatalf("fallback connect failed: %d", code)
	}
	if got := roundTrip(t, c); got != "T:hi" {
		t.Fatalf("auto mode must fall back to the tunnel: got %q", got)
	}
	c.Close()
	if s := tt.Status(10); len(s.Relays) != 1 || s.Relays[0] != "relay.example.org" {
		t.Fatalf("relay host not learned: %v", s.Relays)
	}
}

func TestOffModeNeverTunnels(t *testing.T) {
	var direct, tun atomic.Int32
	tt := newTestTunnel(t, ModeOff, failDialer(&direct), echoDialer("T:", &tun))
	c, code := socksConnect(t, tt.Addr(), "u", "p", "relay.example.org:993")
	defer c.Close()
	if code != repHostUnreachable || tun.Load() != 0 {
		t.Fatalf("off mode must not use the tunnel (code %d, tunnel dials %d)", code, tun.Load())
	}
}

func TestRouteSwitchClosesOldConnections(t *testing.T) {
	var direct, tun atomic.Int32
	hold := func(ctx context.Context, network, addr string) (net.Conn, error) {
		direct.Add(1)
		a, b := net.Pipe()
		go func() { io.Copy(io.Discard, b) }() // never answers: a long-lived connection
		return a, nil
	}
	tt := newTestTunnel(t, ModeAuto, hold, echoDialer("T:", &tun))
	c, code := socksConnect(t, tt.Addr(), "u", "p", "relay.example.org:993")
	if code != repSucceeded {
		t.Fatalf("connect failed: %d", code)
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if err := tt.SetMode(ModeAlways); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("direct connection must be closed when the route switches to the tunnel")
	}
	c.Close()
	c, _ = socksConnect(t, tt.Addr(), "u", "p", "relay.example.org:993")
	defer c.Close()
	if got := roundTrip(t, c); got != "T:hi" {
		t.Fatalf("new connection must use the tunnel: got %q", got)
	}
}

func TestEventLogRing(t *testing.T) {
	l := newEventLog(3)
	for i := 0; i < 5; i++ {
		l.add("e%d", i)
	}
	ev := l.last(10)
	if len(ev) != 3 || ev[0].Msg != "e2" || ev[2].Msg != "e4" {
		t.Fatalf("ring order: %+v", ev)
	}
}

func TestAnyCanaryMeansBlocked(t *testing.T) {
	var n atomic.Int32
	tt := newTestTunnel(t, ModeAuto, echoDialer("D:", &n), echoDialer("T:", &n))
	tt.mu.Lock()
	tt.relays["relay.example.org"] = time.Now()
	tt.mu.Unlock()
	// Relays fail, only the last default canary answers.
	last := DefaultCanaries[len(DefaultCanaries)-1]
	tt.probeTLS = func(_ context.Context, hostport, _ string) error {
		if hostport == last {
			return nil
		}
		return errors.New("refused")
	}
	if res := tt.probe(); res.Relays != 1 || res.RelayOK != 0 || !res.CanaryOK {
		t.Fatalf("one canary answering must count: %+v", res)
	}
	tt.probeTLS = func(context.Context, string, string) error { return errors.New("refused") }
	if res := tt.probe(); res.CanaryOK {
		t.Fatalf("no canary answering must read as offline: %+v", res)
	}
}

func TestEffectiveOrder(t *testing.T) {
	cfg, err := Config{
		Zone: "t.example.org", Key: testKey,
		Resolvers:       []string{"77.88.8.8:53", "10.0.0.1:53"},
		SystemResolvers: []string{"10.0.0.1:53", "fe80::1%wlan0", "garbage", "2001:db8::53"},
		Operator:        "25001",
	}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	eff := cfg.Effective()
	if eff[0] != "10.0.0.1:53" || eff[1] != "[2001:db8::53]:53" {
		t.Fatalf("network resolvers must come first: %v", eff)
	}
	if eff[2] != OperatorResolvers["25001"][0] {
		t.Fatalf("operator resolvers must follow: %v", eff)
	}
	// link extras (77.88.8.8 is also a default: listed once), then defaults
	if eff[2+len(OperatorResolvers["25001"])] != "77.88.8.8:53" {
		t.Fatalf("link resolvers must follow the operator's: %v", eff)
	}
	seen := map[string]bool{}
	for _, r := range eff {
		if seen[r] {
			t.Fatalf("duplicate %s in %v", r, eff)
		}
		seen[r] = true
	}
	if len(eff) != 2+len(OperatorResolvers["25001"])+len(DefaultResolvers) {
		t.Fatalf("network + operator + defaults (link entries overlap them): %d %v", len(eff), eff)
	}
	other, _ := Config{Zone: "t.example.org", Key: testKey, Operator: "99999"}.Normalize()
	if len(other.Effective()) != len(DefaultResolvers) {
		t.Fatalf("unknown operator adds nothing")
	}
}

func TestBytesCountedWhileOpen(t *testing.T) {
	var n atomic.Int32
	// Echo forever: the connection stays open like IMAP IDLE.
	echo := func(ctx context.Context, network, addr string) (net.Conn, error) {
		n.Add(1)
		a, b := net.Pipe()
		go func() { io.Copy(b, b) }()
		return a, nil
	}
	tt := newTestTunnel(t, ModeAlways, echo, echo)
	c, code := socksConnect(t, tt.Addr(), "u", "p", "relay.example.org:993")
	if code != repSucceeded {
		t.Fatalf("connect failed: %d", code)
	}
	defer c.Close()
	c.Write([]byte("hello"))
	io.ReadFull(c, make([]byte, 5))
	st := tt.Status(0).Stats["tunnel"]
	if st.Up != 5 || st.Down != 5 || st.Conns != 1 {
		t.Fatalf("live counters on an open connection: %+v", st)
	}
}
