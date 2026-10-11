// Command soar-socks runs the Velta tunnel proxy standalone (desktop, or
// Termux on a phone) for testing the router without an app build:
//
//	soar-socks -link 'velta://tunnel?v=1&zone=…&key=…' -listen 127.0.0.1:18000
//
// Point Delta Chat at socks5://127.0.0.1:18000 (no auth unless -user is set).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"soartunnel/tunnel"
)

func main() {
	link := flag.String("link", "", "velta://tunnel link")
	mode := flag.String("mode", tunnel.ModeAuto, "auto, always or off")
	listen := flag.String("listen", "127.0.0.1:18000", "SOCKS5 listen address")
	user := flag.String("user", "", "SOCKS5 username (empty = no auth)")
	pass := flag.String("pass", "", "SOCKS5 password")
	every := flag.Duration("status", time.Minute, "print a status line this often (0 = never)")
	paths := flag.Bool("paths", false, "also print one line per resolver path with each status")
	flag.Parse()

	cfg, err := tunnel.ParseLink(*link)
	if err != nil {
		fmt.Fprintln(os.Stderr, "soar-socks:", err)
		os.Exit(2)
	}
	cfg.Mode, cfg.Listen, cfg.User, cfg.Pass = *mode, *listen, *user, *pass
	t, err := tunnel.Start(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "soar-socks:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "SOCKS5 on %s, mode %s, %d resolvers (%d from the link)\n", t.Addr(), cfg.Mode, len(cfg.Effective()), len(cfg.Resolvers))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	var tick <-chan time.Time
	if *every > 0 {
		tk := time.NewTicker(*every)
		defer tk.Stop()
		tick = tk.C
	}
	printed := time.Time{}
	for {
		select {
		case <-sig:
			t.Close()
			return
		case <-tick:
			s := t.Status(50)
			for _, e := range s.Events {
				if e.Time.After(printed) {
					fmt.Fprintf(os.Stderr, "%s %s\n", e.Time.Local().Format("15:04:05"), e.Msg)
					printed = e.Time
				}
			}
			line, _ := json.Marshal(map[string]any{"route": s.Route, "state": s.State, "active": s.Active, "stats": s.Stats})
			fmt.Fprintf(os.Stderr, "%s status %s session=%v\n", time.Now().Format("15:04:05"), line, s.Session)
			if *paths {
				for _, p := range s.Paths {
					fmt.Fprintf(os.Stderr, "  %-28s %-4s verified=%-5v susp=%-5v rtt=%-6v loss=%.2f win=%.1f name=%d ans=%d ok=%d\n",
						p.Resolver, p.Transport, p.Verified, p.Suspended, p.RTT.Round(time.Millisecond), p.Loss, p.Window, p.NameLen, p.AnswerBytes, p.Successes)
				}
			}
		}
	}
}
