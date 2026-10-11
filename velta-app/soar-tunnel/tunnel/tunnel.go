package tunnel

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"runtime/debug"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/getlantern/soar"
)

// Route is where new connections go.
type Route int

const (
	RouteDirect Route = iota
	RouteTunnel
)

func (r Route) String() string {
	if r == RouteTunnel {
		return "tunnel"
	}
	return "direct"
}

// soar tuning measured on Yandex/NSDI paths (2026-10): soar's default
// 101-char starting name length never grew there and capped upload at
// ~1.5 KB/s; full-length names and a wider per-path window gave ~4x.
const (
	soarSafeQName  = 253
	soarPathWindow = 64
)

// Timeouts and the monitor's hysteresis.
const (
	handshakeTimeout   = 30 * time.Second
	directDialTimeout  = 8 * time.Second
	tunnelDialTimeout  = 60 * time.Second
	probeTimeout       = 6 * time.Second
	minProbeGap        = 10 * time.Second
	blockedAfter       = 2 // consecutive "relays fail, canary ok" probes before switching to the tunnel
	recoveredAfter     = 3 // consecutive "a relay answers directly" probes before switching back
	maxProbedRelays    = 4
	suspiciousLifetime = 20 * time.Second
	suspiciousBytes    = 512
)

type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Tunnel is a running local proxy.
type Tunnel struct {
	cfg    Config
	ln     net.Listener
	client *soar.Client
	log    *eventLog
	ctx    context.Context
	cancel context.CancelFunc
	kick   chan struct{}
	wg     sync.WaitGroup

	// Swappable for tests.
	dialDirect dialFunc
	dialTunnel dialFunc
	probeTLS   func(ctx context.Context, hostport, sni string) error

	mu         sync.Mutex
	mode       string
	route      Route
	routeSince time.Time
	conns      map[*tracked]struct{}
	relays     map[string]time.Time // relay host -> last seen in a CONNECT
	failStreak int
	okStreak   int
	state      string
	lastProbe  time.Time
	lastResult probeResult
	stats      [2]routeStats
}

type tracked struct {
	route  Route
	local  net.Conn
	remote net.Conn
}

type routeStats struct {
	Conns int64 `json:"conns"`
	Fails int64 `json:"fails"`
	Up    int64 `json:"up"`
	Down  int64 `json:"down"`
}

type probeResult struct {
	Relays   int  `json:"relays"`
	RelayOK  int  `json:"relay_ok"`
	CanaryOK bool `json:"canary_ok"`
}

// Start validates cfg, creates the soar client and starts serving SOCKS5.
func Start(cfg Config) (*Tunnel, error) {
	cfg, err := cfg.Normalize()
	if err != nil {
		return nil, err
	}
	key, _ := base64.StdEncoding.DecodeString(cfg.Key)
	t := &Tunnel{
		cfg:    cfg,
		log:    newEventLog(500),
		kick:   make(chan struct{}, 1),
		mode:   cfg.Mode,
		conns:  map[*tracked]struct{}{},
		relays: map[string]time.Time{},
		state:  "unknown",
	}
	t.ctx, t.cancel = context.WithCancel(context.Background())
	client, err := soar.NewClient(soar.Config{
		Zone:          cfg.Zone,
		ServerKey:     ed25519.PublicKey(key),
		Resolvers:     cfg.Effective(),
		TCP:           "auto",
		SafeQName:     soarSafeQName,
		MaxPathWindow: soarPathWindow,
		DialTCP:       dialResolver,
		Logger:        slog.New(&logHandler{log: t.log}),
	})
	if err != nil {
		return nil, err
	}
	t.client = client
	d := &net.Dialer{Timeout: directDialTimeout}
	t.dialDirect = d.DialContext
	t.dialTunnel = client.DialContext
	t.probeTLS = probeTLS

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		client.Close()
		return nil, err
	}
	t.ln = ln
	t.setRouteLocked(initialRoute(cfg.Mode), "start")
	t.log.add("started: mode=%s resolvers=%d (network %d, operator %s +%d) soar=%s", cfg.Mode, len(cfg.Effective()),
		len(cfg.SystemResolvers), cfg.Operator, len(OperatorResolvers[cfg.Operator]), soarVersion())
	t.wg.Add(2)
	go t.serve()
	go t.monitor()
	return t, nil
}

func initialRoute(mode string) Route {
	if mode == ModeAlways {
		return RouteTunnel
	}
	return RouteDirect
}

// Addr is the SOCKS5 listen address.
func (t *Tunnel) Addr() string { return t.ln.Addr().String() }

// Close stops serving and drops every connection.
func (t *Tunnel) Close() {
	t.cancel()
	t.ln.Close()
	t.mu.Lock()
	var all []*tracked
	for c := range t.conns {
		all = append(all, c)
	}
	t.mu.Unlock()
	for _, c := range all {
		c.local.Close()
		c.remote.Close()
	}
	if t.client != nil {
		t.client.Close()
	}
	t.wg.Wait()
}

// SetMode switches between auto, always and off.
func (t *Tunnel) SetMode(mode string) error {
	switch mode {
	case ModeAuto, ModeAlways, ModeOff:
	default:
		return errors.New("unknown mode " + mode)
	}
	t.mu.Lock()
	t.mode = mode
	t.failStreak, t.okStreak = 0, 0
	switch mode {
	case ModeAlways:
		t.setRouteLocked(RouteTunnel, "mode always")
	case ModeOff:
		t.setRouteLocked(RouteDirect, "mode off")
	}
	t.mu.Unlock()
	t.log.add("mode set to %s", mode)
	t.kickProbe()
	return nil
}

// NetworkChanged asks for an immediate re-check (Wi-Fi <-> mobile, airplane mode).
func (t *Tunnel) NetworkChanged() {
	t.mu.Lock()
	t.failStreak, t.okStreak = 0, 0
	t.mu.Unlock()
	t.log.add("network changed")
	t.kickProbe()
}

func (t *Tunnel) kickProbe() {
	select {
	case t.kick <- struct{}{}:
	default:
	}
}

// setRouteLocked changes the route and closes the connections on the old
// one, so the core reconnects over the new route at once. Caller holds t.mu.
func (t *Tunnel) setRouteLocked(r Route, reason string) {
	if r == t.route && !t.routeSince.IsZero() {
		return
	}
	old := t.route
	t.route = r
	t.routeSince = time.Now()
	if reason != "start" {
		t.log.add("route %s -> %s (%s)", old, r, reason)
	}
	for c := range t.conns {
		if c.route != r {
			// Close only wakes the pipes; their cleanup takes t.mu after we release it.
			c.local.Close()
			c.remote.Close()
		}
	}
}

func (t *Tunnel) serve() {
	defer t.wg.Done()
	for {
		c, err := t.ln.Accept()
		if err != nil {
			if t.ctx.Err() != nil {
				return
			}
			t.log.add("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go t.handle(c)
	}
}

func (t *Tunnel) handle(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(handshakeTimeout))
	addr, err := socksHandshake(c, t.cfg.User, t.cfg.Pass)
	if err != nil {
		t.log.add("socks: %v", err)
		return
	}
	if host, _, err := net.SplitHostPort(addr); err == nil && net.ParseIP(host) == nil {
		t.mu.Lock()
		t.relays[host] = time.Now()
		t.mu.Unlock()
	}

	remote, route, err := t.dial(addr)
	if err != nil {
		t.mu.Lock()
		t.stats[route].Fails++
		t.mu.Unlock()
		t.log.add("%s dial %s failed: %v", route, addr, err)
		socksReply(c, repHostUnreachable)
		return
	}
	defer remote.Close()
	if err := socksReply(c, repSucceeded); err != nil {
		return
	}
	c.SetDeadline(time.Time{})

	tr := &tracked{route: route, local: c, remote: remote}
	t.mu.Lock()
	t.conns[tr] = struct{}{}
	t.stats[route].Conns++
	t.mu.Unlock()

	start := time.Now()
	var up, down atomic.Int64
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); up.Store(pipe(remote, c)) }()
	go func() { defer wg.Done(); down.Store(pipe(c, remote)) }()
	wg.Wait()

	t.mu.Lock()
	delete(t.conns, tr)
	t.stats[route].Up += up.Load()
	t.stats[route].Down += down.Load()
	t.mu.Unlock()
	// A direct connection that died young with almost nothing received is
	// what a TLS-cutting allowlist looks like from here: check now instead
	// of at the next scheduled probe.
	if route == RouteDirect && time.Since(start) < suspiciousLifetime && down.Load() < suspiciousBytes {
		t.kickProbe()
	}
}

// dial opens addr on the current route. In auto mode a failed direct dial
// falls back to the tunnel for this connection and triggers a probe.
func (t *Tunnel) dial(addr string) (net.Conn, Route, error) {
	t.mu.Lock()
	route, mode := t.route, t.mode
	t.mu.Unlock()
	if route == RouteDirect {
		ctx, cancel := context.WithTimeout(t.ctx, directDialTimeout)
		c, err := t.dialDirect(ctx, "tcp", addr)
		cancel()
		if err == nil {
			return c, RouteDirect, nil
		}
		t.kickProbe()
		if mode != ModeAuto {
			return nil, RouteDirect, err // counted by the caller
		}
		t.mu.Lock()
		t.stats[RouteDirect].Fails++
		t.mu.Unlock()
		t.log.add("direct dial %s failed (%v); trying the tunnel", addr, err)
	}
	ctx, cancel := context.WithTimeout(t.ctx, tunnelDialTimeout)
	defer cancel()
	c, err := t.dialTunnel(ctx, "tcp", addr)
	return c, RouteTunnel, err
}

// pipe copies src to dst, then half-closes dst so the peer sees EOF.
func pipe(dst, src net.Conn) int64 {
	n, _ := io.Copy(dst, src)
	if cw, ok := dst.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	} else {
		dst.Close()
	}
	return n
}

func (t *Tunnel) monitor() {
	defer t.wg.Done()
	for {
		select {
		case <-t.ctx.Done():
			return
		case <-t.kick:
		case <-time.After(t.nextProbeIn()):
		}
		t.mu.Lock()
		mode, since := t.mode, time.Since(t.lastProbe)
		t.mu.Unlock()
		if mode != ModeAuto {
			continue
		}
		if since < minProbeGap {
			select {
			case <-t.ctx.Done():
				return
			case <-time.After(minProbeGap - since):
			}
		}
		t.applyProbe(t.probe())
	}
}

func (t *Tunnel) nextProbeIn() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case t.mode != ModeAuto:
		return time.Hour
	case t.state == "offline":
		return 30 * time.Second
	case t.route == RouteTunnel:
		return time.Minute
	case t.failStreak > 0:
		return 15 * time.Second
	case t.state == "unknown":
		return time.Minute
	default:
		return 5 * time.Minute
	}
}

// probe checks the most recently used relays and the canaries over real TLS:
// a bare TCP connect proves nothing behind a fake-IP VPN or an allowlist
// that lets SYNs through and cuts TLS.
func (t *Tunnel) probe() probeResult {
	t.mu.Lock()
	hosts := make([]string, 0, len(t.relays))
	for h := range t.relays {
		hosts = append(hosts, h)
	}
	sort.Slice(hosts, func(i, j int) bool { return t.relays[hosts[i]].After(t.relays[hosts[j]]) })
	t.mu.Unlock()
	if len(hosts) > maxProbedRelays {
		hosts = hosts[:maxProbedRelays]
	}
	res := probeResult{Relays: len(hosts)}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, h := range hosts {
		wg.Add(1)
		go func(h string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(t.ctx, probeTimeout)
			defer cancel()
			if t.probeTLS(ctx, net.JoinHostPort(h, "443"), h) == nil {
				mu.Lock()
				res.RelayOK++
				mu.Unlock()
			}
		}(h)
	}
	// Any canary answering is enough: one allowlisted site may be down.
	for _, c := range t.cfg.Canaries {
		wg.Add(1)
		go func(c string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(t.ctx, probeTimeout)
			defer cancel()
			host, _, _ := net.SplitHostPort(c)
			if t.probeTLS(ctx, c, host) == nil {
				mu.Lock()
				res.CanaryOK = true
				mu.Unlock()
			}
		}(c)
	}
	wg.Wait()
	return res
}

func (t *Tunnel) applyProbe(res probeResult) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastProbe = time.Now()
	t.lastResult = res
	route, fail, ok, state := decide(t.route, res, t.failStreak, t.okStreak)
	if state != t.state {
		t.log.add("state %s -> %s (relays %d/%d ok, canary ok=%v)", t.state, state, res.RelayOK, res.Relays, res.CanaryOK)
	}
	t.failStreak, t.okStreak, t.state = fail, ok, state
	if t.mode == ModeAuto {
		t.setRouteLocked(route, state)
	}
}

// decide is the monitor's state machine, kept pure for tests.
//   - any relay answering directly means the network is normal (one dead
//     relay is that relay's problem, not an allowlist);
//   - every relay failing while the canary answers means "blocked";
//   - everything failing means "offline": change nothing.
func decide(route Route, res probeResult, failStreak, okStreak int) (Route, int, int, string) {
	switch {
	case res.Relays == 0:
		return route, failStreak, okStreak, "unknown"
	case res.RelayOK > 0:
		okStreak++
		if route == RouteTunnel && okStreak >= recoveredAfter {
			route = RouteDirect
		}
		return route, 0, okStreak, "direct"
	case res.CanaryOK:
		failStreak++
		if route == RouteDirect && failStreak >= blockedAfter {
			route = RouteTunnel
		}
		return route, failStreak, 0, "blocked"
	default:
		return route, failStreak, 0, "offline"
	}
}

func probeTLS(ctx context.Context, hostport, sni string) error {
	d := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: probeTimeout},
		Config:    &tls.Config{ServerName: sni, MinVersion: tls.VersionTLS12},
	}
	c, err := d.DialContext(ctx, "tcp", hostport)
	if err != nil {
		return err
	}
	return c.Close()
}

// dialResolver opens soar's TCP paths: TLS for port 853 (DNS-over-TLS uses
// the same 2-byte length framing as soar's TCP/53 paths), plain TCP otherwise.
func dialResolver(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	d := &net.Dialer{Timeout: 5 * time.Second}
	if port != "853" {
		return d.DialContext(ctx, network, addr)
	}
	td := &tls.Dialer{NetDialer: d, Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
	return td.DialContext(ctx, network, addr)
}

// Status is the diagnostics snapshot shown in the app and sent in reports.
type Status struct {
	Zone       string                `json:"zone"`
	Mode       string                `json:"mode"`
	Route      string                `json:"route"`
	RouteSince time.Time             `json:"route_since"`
	State      string                `json:"state"`
	Resolvers  int                   `json:"resolvers"`
	Network    []string              `json:"network_resolvers"`
	Operator   string                `json:"operator"`
	Relays     []string              `json:"relays"`
	LastProbe  time.Time             `json:"last_probe"`
	LastResult probeResult           `json:"last_result"`
	Active     map[string]int        `json:"active"`
	Stats      map[string]routeStats `json:"stats"`
	Soar       string                `json:"soar"`
	Events     []Event               `json:"events"`
}

// Status returns a snapshot with the last n events.
func (t *Tunnel) Status(n int) Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := Status{
		Zone:       t.cfg.Zone,
		Mode:       t.mode,
		Route:      t.route.String(),
		RouteSince: t.routeSince.UTC(),
		State:      t.state,
		Resolvers:  len(t.cfg.Effective()),
		Network:    t.cfg.SystemResolvers,
		Operator:   t.cfg.Operator,
		LastProbe:  t.lastProbe.UTC(),
		LastResult: t.lastResult,
		Active:     map[string]int{"direct": 0, "tunnel": 0},
		Stats:      map[string]routeStats{"direct": t.stats[RouteDirect], "tunnel": t.stats[RouteTunnel]},
		Soar:       soarVersion(),
	}
	for h := range t.relays {
		s.Relays = append(s.Relays, h)
	}
	sort.Strings(s.Relays)
	for c := range t.conns {
		s.Active[c.route.String()]++
	}
	s.Events = t.log.last(n)
	return s
}

func soarVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/getlantern/soar" {
				return d.Version
			}
		}
	}
	return "unknown"
}

// RandomCredentials returns a fresh SOCKS5 username/password pair.
func RandomCredentials() (string, string) {
	b := make([]byte, 16)
	rand.Read(b)
	return "velta-tunnel", hex.EncodeToString(b)
}

// logHandler forwards soar's warnings and errors into the event log.
type logHandler struct {
	log   *eventLog
	attrs []slog.Attr
}

func (h *logHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelInfo }

func (h *logHandler) Handle(_ context.Context, r slog.Record) error {
	msg := "soar: " + r.Message
	r.Attrs(func(a slog.Attr) bool {
		msg += " " + a.String()
		return true
	})
	for _, a := range h.attrs {
		msg += " " + a.String()
	}
	h.log.add("%s", msg)
	return nil
}

func (h *logHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return &logHandler{log: h.log, attrs: append(append([]slog.Attr(nil), h.attrs...), as...)}
}

func (h *logHandler) WithGroup(string) slog.Handler { return h }
