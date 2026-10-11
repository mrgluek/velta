# Optional DNS tunnel (fork build) — agent notes

A fork-only feature: Velta Tunnel (`applicationId org.velta.tunnel`, installs
next to upstream Velta) can reach the relays over a
[soar](https://github.com/getlantern/soar) DNS tunnel when the mobile network
only lets allowlisted sites through. Android only.

## Pieces

| Where | What |
|---|---|
| `velta-app/soar-tunnel/tunnel` | Go: link parsing, SOCKS5 server (user/pass), DIRECT/TUNNEL router, allowlist monitor, event ring |
| `velta-app/soar-tunnel/cmd/libsoartunnel` | C ABI (`-buildmode=c-shared`) the shell dlopens |
| `velta-app/soar-tunnel/cmd/soar-socks` | Same router as a CLI, for Termux/desktop testing without an app build |
| `velta-app/src-tauri/src/tunnel.rs` | Loads the library, stores `tunnel.json` in app-local data, sets `proxy_url` on every profile, Tauri commands |
| `app/js/tunnel.js` | Deep link confirm, drawer row + settings sheet, diagnostics share |
| `.github/workflows/build-android.yml` | Builds `libsoartunnel.so` into `gen/android/app/src/main/soarLibs` (gradle `jniLibs.srcDir`) |

## Configuration never lives in the repo

The tunnel zone and server key arrive in a link, accepted by the user:

```
velta://tunnel?v=1&zone=<tunnel-zone>&key=<base64 ed25519 pubkey>[&r=<ip:port,…>][&c=<host:port,…>]
```

`r` overrides the resolver list (IP literals only; port 853 = DNS-over-TLS),
`c` the allowlist canaries. Defaults are public resolvers (MSK-IX, Yandex
basic/Safe/Family incl. IPv6 and DoT, Google) and canaries `ya.ru`,
`max.ru`, `gosuslugi.ru`. Like `dcbackup:`, a tunnel link can come from any
page, so it is applied only after `confirmModal`. Without a link nothing
starts and the app is upstream Velta. The shell never logs the link.

Public-repo hygiene (§6.6) applies to the tunnel server too: never commit its
zone, key, IP or hostnames; docs and tests use `t.example.org`.

## Routing

The core always talks to `socks5://velta-tunnel:<random>@127.0.0.1:<port>`;
the router decides per connection:

- **auto** (default): DIRECT while a relay answers; a failed direct dial
  falls back to the tunnel for that connection. The monitor probes the
  relays the core used and the canaries over real TLS (a TCP connect proves
  nothing behind fake-IP VPNs or SYN-passing allowlists). All relays failing
  while any canary answers twice in a row = blocked → TUNNEL; a relay
  answering directly three times = back to DIRECT; nothing answering =
  offline, no change. A route switch closes the old route's connections so
  the core reconnects at once.
- **always** / **off**: fixed route.

Switching `proxy_enabled` in the core instead was rejected: it restarts the
IO scheduler on every flip and can't fall back per connection.

`tunnel.rs` writes `proxy_url` only when a profile has none or has ours
(prefix `socks5://velta-tunnel:`); a proxy the user set wins. A 60 s loop
re-applies it so profiles added later pick it up. Removing the tunnel clears
only our value.

## soar tuning

soar is pre-release (protocol may change; server and client must be
upgraded together; `go.mod` pins a commit). Its 101-char starting name
length never grew on Yandex paths and capped upload near 1.5 KB/s; the
library sets `SafeQName 253`, `MaxPathWindow 64`. soar's own server refuses
loopback/private destinations; restrict its egress to the relays with an
owner-match firewall chain on the server.

## Phone gotchas

- Android Private DNS (strict, e.g. NextDNS) intercepts apps' raw UDP 53:
  every resolver path then arrives from the Private DNS provider with ~512 B
  answers. The tunnel still works, slowly; turning Private DNS off restores
  the direct resolver paths.
- A static (`CGO_ENABLED=0`) Go binary on Android can't resolve hostnames;
  the c-shared library uses cgo and the system resolver, and resolvers are
  IP literals anyway.
