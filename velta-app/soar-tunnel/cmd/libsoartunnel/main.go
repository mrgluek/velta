// Command libsoartunnel builds the C ABI the Velta shell loads on Android
// (go build -buildmode=c-shared). Every call returns a JSON string the caller
// must release with VeltaTunnelFree; errors come back as {"error": "..."}.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"sync"
	"unsafe"

	"soartunnel/tunnel"
)

var (
	mu  sync.Mutex
	cur *tunnel.Tunnel
)

func result(v any) *C.char {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"error":"marshal failed"}`)
	}
	return C.CString(string(b))
}

func fail(err error) *C.char { return result(map[string]string{"error": err.Error()}) }

// VeltaTunnelParseLink validates a velta://tunnel link and returns its config
// with fresh random SOCKS5 credentials, ready to store and start.
//
//export VeltaTunnelParseLink
func VeltaTunnelParseLink(link *C.char) *C.char {
	cfg, err := tunnel.ParseLink(C.GoString(link))
	if err != nil {
		return fail(err)
	}
	cfg.User, cfg.Pass = tunnel.RandomCredentials()
	n, _ := cfg.Normalize()
	return result(struct {
		tunnel.Config
		// For the confirmation text: the list the tunnel will use before
		// the network's and operator's resolvers are added.
		EffectiveResolvers int `json:"effective_resolvers"`
	}{cfg, len(n.Effective())})
}

// VeltaTunnelStart (re)starts the proxy from a config JSON and returns
// {"addr": "127.0.0.1:<port>"}.
//
//export VeltaTunnelStart
func VeltaTunnelStart(cfgJSON *C.char) *C.char {
	var cfg tunnel.Config
	if err := json.Unmarshal([]byte(C.GoString(cfgJSON)), &cfg); err != nil {
		return fail(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if cur != nil {
		cur.Close()
		cur = nil
	}
	t, err := tunnel.Start(cfg)
	if err != nil {
		return fail(err)
	}
	cur = t
	return result(map[string]string{"addr": t.Addr()})
}

// VeltaTunnelStop stops the proxy if it runs.
//
//export VeltaTunnelStop
func VeltaTunnelStop() {
	mu.Lock()
	defer mu.Unlock()
	if cur != nil {
		cur.Close()
		cur = nil
	}
}

// VeltaTunnelStatus returns the status snapshot with up to `events` events,
// or {"running": false}.
//
//export VeltaTunnelStatus
func VeltaTunnelStatus(events C.int) *C.char {
	mu.Lock()
	defer mu.Unlock()
	if cur == nil {
		return result(map[string]bool{"running": false})
	}
	return result(struct {
		Running bool `json:"running"`
		tunnel.Status
	}{true, cur.Status(int(events))})
}

// VeltaTunnelSetMode switches auto / always / off.
//
//export VeltaTunnelSetMode
func VeltaTunnelSetMode(mode *C.char) *C.char {
	mu.Lock()
	defer mu.Unlock()
	if cur == nil {
		return fail(errNotRunning{})
	}
	if err := cur.SetMode(C.GoString(mode)); err != nil {
		return fail(err)
	}
	return result(map[string]bool{"ok": true})
}

// VeltaTunnelNetworkChanged triggers an immediate re-check.
//
//export VeltaTunnelNetworkChanged
func VeltaTunnelNetworkChanged() {
	mu.Lock()
	defer mu.Unlock()
	if cur != nil {
		cur.NetworkChanged()
	}
}

// VeltaTunnelFree releases a string returned by this library.
//
//export VeltaTunnelFree
func VeltaTunnelFree(p *C.char) { C.free(unsafe.Pointer(p)) }

type errNotRunning struct{}

func (errNotRunning) Error() string { return "tunnel is not running" }

func main() {}
