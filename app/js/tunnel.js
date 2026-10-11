// Optional DNS tunnel (Android fork build): UI side of
// velta-app/src-tauri/src/tunnel.rs + velta-app/soar-tunnel.
//
// The tunnel exists only after the user accepts a velta://tunnel?… link; the
// server zone and key are never part of this code. Until then nothing here
// shows up and the app behaves exactly as upstream Velta.
//
// Shell commands: tunnel_preview, tunnel_install, tunnel_remove,
// tunnel_status, tunnel_set_mode, tunnel_network_changed, share_text.

const MODES = [
  ["auto", "Automatic", "Direct while the relays answer; through the tunnel when only allowlisted sites work."],
  ["always", "Always", "Every connection goes through the tunnel. Slower; use it if Automatic misjudges the network."],
  ["off", "Off", "Never use the tunnel. Mail connects directly, as without it."],
];

let cached = { installed: false, available: false };

function shellInvoke() {
  const t = globalThis.window?.__TAURI__;
  return t?.core?.invoke || t?.invoke || null;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function errMsg(e) {
  return e?.message || String(e);
}

/** Returns the link if rawUrl is a velta://tunnel setup link, else null. */
export function extractTunnelLink(rawUrl) {
  const s = String(rawUrl || "").trim();
  return /^velta:\/\/tunnel(?:[?#/]|$)/i.test(s) ? s : null;
}

/** Last known status (sync, for drawer rendering). */
export function tunnelInstalled() {
  return !!cached.installed;
}

export function tunnelStatus() {
  return cached;
}

export async function refreshTunnelStatus(events = 0, invoke = shellInvoke()) {
  if (!invoke) return (cached = { installed: false, available: false });
  try {
    cached = await invoke("tunnel_status", { events });
  } catch (e) {
    cached = { installed: false, available: false, error: errMsg(e) };
  }
  return cached;
}

/** One-line state for the drawer and the settings sheet. */
export function describeTunnel(s) {
  if (!s?.installed) return { headline: "Not set up", detail: "" };
  if (s.available === false || s.running === false) {
    return { headline: "Not running", detail: s.error || "The tunnel library did not start." };
  }
  if (s.mode === "off") return { headline: "Off", detail: "Mail connects directly." };
  if (s.route === "tunnel") {
    const why = s.mode === "always" ? "set to Always" : "relays are blocked on this network";
    return { headline: "Through the tunnel", detail: `Mail goes through the DNS tunnel (${why}).` };
  }
  switch (s.state) {
    case "blocked":
      return { headline: "Checking", detail: "The relays did not answer directly; checking again before switching to the tunnel." };
    case "offline":
      return { headline: "No network", detail: "Neither the relays nor the allowlisted sites answer." };
    case "unknown":
      return { headline: "Direct", detail: "Mail connects directly. The network is checked once the relays are in use." };
    default:
      return { headline: "Direct", detail: "The relays answer directly; the tunnel is idle." };
  }
}

function kb(n) {
  return `${Math.round((n || 0) / 1024)} KB`;
}

/** One line per resolver path, working ones first (most answers first):
 * which resolvers carry the tunnel on this network. Durations arrive in ns. */
export function pathLines(paths) {
  if (!Array.isArray(paths) || !paths.length) return ["paths: none (tunnel not started)"];
  const rows = [...paths].sort((a, b) =>
    (b.verified - a.verified) || ((b.successes || 0) - (a.successes || 0)));
  const ok = rows.filter(p => p.verified).length;
  return [
    `paths: ${ok}/${rows.length} verified`,
    ...rows.map(p => {
      const state = p.dead ? "dead" : p.suspended ? "suspended" : p.verified ? "ok" : "unverified";
      const rtt = p.rtt ? `${Math.round(p.rtt / 1e6)}ms` : "-";
      return `  ${p.resolver} ${p.transport} ${state} rtt=${rtt} loss=${(p.loss || 0).toFixed(2)} answers=${p.successes || 0} name=${p.name_len} ans=${p.answer_max}`;
    }),
  ];
}

/** Plain-text diagnostics for sharing: routing state and events, never message content. */
export function tunnelReport(s, { app = "", now = new Date() } = {}) {
  const lines = [
    `Velta DNS tunnel report ${now.toISOString()}`,
    app ? `app: ${app}` : null,
    `soar: ${s.soar || "?"}`,
    `zone: ${s.zone || "?"}  resolvers: ${s.resolvers ?? "?"}`,
    `mode: ${s.mode}  route: ${s.route}  state: ${s.state}  since: ${s.route_since || "?"}`,
    `last probe: ${s.last_probe || "never"}  relays ok ${s.last_result?.relay_ok ?? 0}/${s.last_result?.relays ?? 0}  canary ok: ${!!s.last_result?.canary_ok}`,
    `relays: ${(s.relays || []).join(", ") || "none yet"}`,
    `network: ${s.network?.transport || "?"}  operator: ${s.network?.sim_operator || s.operator || "?"} ${s.network?.operator_name || ""}  private dns: ${s.network?.private_dns ? s.network.private_dns_name || "on" : "off"}`,
    `network resolvers: ${(s.network_resolvers || []).join(", ") || "none"}`,
  ];
  for (const r of ["direct", "tunnel"]) {
    const st = s.stats?.[r] || {};
    lines.push(`${r}: active ${s.active?.[r] ?? 0}, conns ${st.conns ?? 0}, fails ${st.fails ?? 0}, up ${kb(st.up)}, down ${kb(st.down)}`);
  }
  lines.push("", ...pathLines(s.paths), "", "events:");
  for (const e of s.events || []) lines.push(`${e.t} ${e.msg}`);
  return lines.filter(l => l !== null).join("\n");
}

/**
 * A velta://tunnel link was opened (deep link, QR, paste). Links can come from
 * any web page or app, so nothing changes without the user's confirmation.
 */
export async function acceptTunnelLink(link, { confirmModal, toast, errToast, onChange, invoke = shellInvoke() }) {
  if (!invoke) {
    toast("DNS tunnel links work in the Velta Tunnel Android app", 5000);
    return false;
  }
  let preview;
  try {
    preview = await invoke("tunnel_preview", { link });
  } catch (e) {
    errToast("This tunnel link can't be used: " + errMsg(e), 6000);
    return false;
  }
  const ok = await confirmModal(
    "DNS tunnel",
    `Use the DNS tunnel at ${preview.zone} when the relays are blocked (allowlist-only mobile internet)? ` +
      `It uses ${preview.resolvers} DNS resolvers. Your messages stay end-to-end encrypted, but the tunnel server ` +
      `sees which relays you connect to and when. Only accept tunnel links from someone you trust.`,
    "Enable",
    false,
  );
  if (!ok) return false;
  try {
    await invoke("tunnel_install", { link });
  } catch (e) {
    errToast("Couldn't enable the tunnel: " + errMsg(e), 6000);
    return false;
  }
  await refreshTunnelStatus(0, invoke);
  toast("DNS tunnel enabled");
  onChange?.();
  return true;
}

/** Re-check routing after a network switch (Wi-Fi <-> mobile, airplane mode). */
export function bindTunnelNetworkEvents(invoke = shellInvoke()) {
  if (!invoke) return;
  // Mobile WebViews fire "change" on every bandwidth/RTT estimate; the shell
  // only acts on a real resolver/operator change, so a few calls are plenty.
  let last = 0;
  const kick = () => {
    if (!cached.installed || Date.now() - last < 5000) return;
    last = Date.now();
    invoke("tunnel_network_changed").catch(() => {});
  };
  globalThis.navigator?.connection?.addEventListener?.("change", kick);
  globalThis.window?.addEventListener?.("online", kick);
}

/** Android Private DNS intercepts the tunnel's DNS queries (measured: answers
 * shrink to ~512 bytes and every path runs through one provider). */
export function privateDnsWarning(s) {
  if (!s?.network?.private_dns) return "";
  const name = s.network.private_dns_name ? ` (${esc(s.network.private_dns_name)})` : "";
  return `<p class="p2p-hint" style="color:var(--danger)">Private DNS is on${name}. It intercepts the tunnel's DNS queries and makes it much slower. Turn it off in Android Settings → Network → Private DNS while you need the tunnel.</p>`;
}

/** Settings sheet: state, mode, diagnostics, removal. */
export async function openTunnelSettings({ showModal, confirmModal, toast, errToast, onChange, appVersion = "", invoke = shellInvoke() }) {
  if (!invoke) return;
  const s = await refreshTunnelStatus(200, invoke);
  const d = describeTunnel(s);
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="p2p-hint"><b>${esc(d.headline)}</b>${d.detail ? ` — ${esc(d.detail)}` : ""}</p>
    ${privateDnsWarning(s)}
    <fieldset class="scale-opts" data-tunnel-modes>
      <legend class="vh">Tunnel mode</legend>
      ${MODES.map(([v, label, hint]) => `<label class="scale-opt" title="${esc(hint)}"><input type="radio" name="tunnel-mode" value="${v}"${s.mode === v ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}
    </fieldset>
    <div class="bar-opts-hint" data-tunnel-hint>${esc((MODES.find(m => m[0] === s.mode) || MODES[0])[2])}</div>
    <p class="p2p-hint">Server: ${esc(s.zone || "?")} · ${Array.isArray(s.paths) ? `${s.paths.filter(p => p.verified).length} of ${s.paths.length} resolver paths working` : `${esc(s.resolvers ?? "?")} resolvers`}${s.session ? " · session up" : ""}</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      <button type="button" class="btn-text" data-tunnel-share>Share diagnostics…</button>
      <button type="button" class="btn-text" data-tunnel-remove style="color:var(--danger)">Remove the tunnel</button>
    </div>`;
  const { close } = showModal({ title: "DNS tunnel", body });

  body.querySelectorAll('input[name="tunnel-mode"]').forEach(input =>
    input.addEventListener("change", async () => {
      try {
        await invoke("tunnel_set_mode", { mode: input.value });
        body.querySelector("[data-tunnel-hint]").textContent = MODES.find(m => m[0] === input.value)[2];
        await refreshTunnelStatus(0, invoke);
        onChange?.();
      } catch (e) {
        errToast("Couldn't change the mode: " + errMsg(e));
      }
    }));

  body.querySelector("[data-tunnel-share]").addEventListener("click", async () => {
    const fresh = await refreshTunnelStatus(200, invoke);
    const text = tunnelReport(fresh, { app: appVersion });
    try {
      await invoke("share_text", { text, title: "Velta DNS tunnel report" });
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        toast("Diagnostics copied");
      } catch (e) {
        errToast("Couldn't share diagnostics: " + errMsg(e));
      }
    }
  });

  body.querySelector("[data-tunnel-remove]").addEventListener("click", async () => {
    const ok = await confirmModal("Remove the DNS tunnel?", "Mail will only connect directly. You need the tunnel link again to set it up.", "Remove", true);
    if (!ok) return;
    try {
      await invoke("tunnel_remove");
      await refreshTunnelStatus(0, invoke);
      close();
      toast("DNS tunnel removed");
      onChange?.();
    } catch (e) {
      errToast("Couldn't remove the tunnel: " + errMsg(e));
    }
  });
}
