# Velta Tunnel Helper (test tool)

A small Android app that runs Velta's DNS-tunnel router on its own and offers
it to every app on the phone as a SOCKS5 proxy on **`127.0.0.1:42000`**, with
no username or password. It is for testing the tunnel with other clients:
stock Delta Chat, a Velta build without the tunnel, `curl` in Termux.

Routing is the same as in Velta (docs/agents/dns-tunnel.md "Routing"):
connections go direct while the probe hosts answer, and through the tunnel
while the allowlist is on (probe hosts fail and allowlisted sites answer).
A direct connection that fails also retries through the tunnel. The mode can be
pinned to "Always tunnel" or "Never tunnel".

## Use

1. Install the APK (CI artifact, see below) and open it.
2. Paste the `velta://tunnel?v=1&zone=…&key=…` link. It is kept only in the
   app's private storage, never in the repo or the APK.
3. Enter the **probe hosts**: hosts that are NOT on the allowlist, usually your
   relay (`relay.example.org`, or `host:port`). If you leave the field empty,
   the router learns probe hosts from the traffic, as it does in Velta. That
   works only while a mail app is the only user: a browser opening an
   allowlisted site would make it look as if the network were open.
4. Tap **Start**, allow notifications, and tap **Allow running in background**
   (the battery-optimization exemption). The proxy runs as a foreground
   service with a "Stop" action in its notification.
5. In the client: SOCKS5, host `127.0.0.1`, port `42000`, no auth. For Delta
   Chat: Settings → Advanced → Proxy → `socks5://127.0.0.1:42000`.

"Apply" (shown while running) restarts the tunnel with edited fields; a mode
change applies at once. **Copy report** puts the status JSON on the clipboard
with the tunnel zone removed.

## Limits

- The tunnel server only lets traffic out to the relays (an egress firewall
  on the server), so this is for mail clients, not a VPN for browsing. It is
  also slow (DNS tunnel: a few KB/s).
- Any app on the phone can use the port: Android does not separate loopback
  traffic by app.
- CI signs with a fresh debug key on every run, so installing a build from
  another run needs an uninstall first, and that deletes the saved link.

## Build

CI: the "Build tunnel helper APK" workflow (manual dispatch, and on pull
requests that touch this folder or `velta-app/soar-tunnel`); the APK is the
`velta-tunnel-helper` artifact.

Locally (Android SDK + NDK 27, Go from `velta-app/soar-tunnel/go.mod`):

```bash
cd velta-app/soar-tunnel
NDK="$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64"
CGO_ENABLED=1 GOOS=android GOARCH=arm64 CC="$NDK/bin/aarch64-linux-android24-clang" \
  go build -trimpath -buildmode=c-shared -ldflags="-s -w -extldflags=-Wl,-z,max-page-size=16384" \
  -o ../../velta-tunnel-helper/app/src/main/soarLibs/arm64-v8a/libsoarhelper.so ./cmd/libsoarhelper
cd ../../velta-tunnel-helper && ./gradlew assembleRelease
```

## Code

| File | What |
|---|---|
| `velta-app/soar-tunnel/cmd/libsoarhelper` | Go → `libsoarhelper.so`: the `tunnel` package exported as JNI methods of `org.velta.tunnelhelper.Native` (UTF-8 byte arrays in and out, JSON results) |
| `TunnelService.kt` | Foreground service: wake lock, start/restart with the network's DNS servers and the SIM operator, retry every 15 s, notification |
| `MainActivity.kt` | Link, probe hosts, mode, start/stop, live status |
| `StatusText.kt` | Status JSON → text, report without the zone |
| `NetInfo.kt` | Network DNS servers and SIM MCC+MNC (same as the main app's) |
