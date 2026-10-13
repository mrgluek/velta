// C2: wasm core in a dedicated worker. Bridges postMessage ↔ the wrapper's
// message-oriented JSON-RPC (init / receive / on_message). Persistence:
// OPFS mirror of the memfs /accounts tree — restored before core init,
// checkpointed on demand and on an interval (full rewrite, so deletions
// propagate). Single-tab exclusivity is enforced by the transport via
// navigator.locks (two writers would corrupt the snapshot).
let dc = null;
let glue = null;

// Stock chatmail POST /new has no CORS header, so the browser cannot read
// the minted address. /cm-new/<host> on this origin is the relay proxy.
// ponytail: pathname /new only; a /new_email QR still goes direct.
function chatmailNewUrl(input, init, page) {
  try {
    const raw = typeof input === "string" ? input : input?.url;
    if (!raw || !page?.origin) return null;
    const url = new URL(raw, page.href);
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method !== "POST" || url.pathname !== "/new" || url.port || url.hostname === page.hostname) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(url.hostname)) return null;
    return new URL("/cm-new/" + url.hostname + url.search, page.origin).href;
  } catch {
    return null;
  }
}

const _fetch = typeof self.fetch === "function" ? self.fetch.bind(self) : null;
if (_fetch) {
  self.fetch = (input, init) => {
    const proxied = chatmailNewUrl(input, init, self.location);
    if (!proxied) return _fetch(input, init);
    return _fetch(proxied, { method: "POST", redirect: init?.redirect, signal: init?.signal });
  };
}

async function opfsRoot() {
  try {
    return navigator.storage?.getDirectory ? await navigator.storage.getDirectory() : null;
  } catch {
    return null;
  }
}

// OPFS snapshot → memfs, before core init (restore survives even a core that
// never gets to boot — it only needs the module-level vfs_* bindings).
async function restore(root) {
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      const p = `${prefix}/${name}`;
      if (handle.kind === "directory") {
        await walk(handle, p);
      } else {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        glue.vfs_mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
        glue.vfs_write(p, bytes);
      }
    }
  };
  await walk(root, "");
}

// memfs /accounts → OPFS. Full rewrite of the snapshot so deletions and
// renames between checkpoints propagate on the next restore. The snapshot is
// staged in memory first: removeEntry must not run unless the memfs walk
// fully succeeded, or a mid-walk throw would leave OPFS wiped (#106).
// One snapshot at a time. A refresh flush and the interval must not both
// removeEntry the OPFS tree.
let checkpointChain = Promise.resolve();
function checkpoint() {
  const run = checkpointChain.then(snapshot, snapshot);
  checkpointChain = run.then(() => {}, () => {});
  return run;
}

async function snapshot() {
  const root = await opfsRoot();
  if (!root || !glue) return;
  const files = [];
  const walk = async (path) => {
    for (const entry of await glue.vfs_list(path)) {
      if (entry.endsWith("/")) {
        await walk(entry);
      } else {
        files.push({ path: entry, bytes: glue.vfs_read(entry) });
      }
    }
  };
  await walk("/accounts");
  try { await root.removeEntry("accounts", { recursive: true }); } catch {}
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(f.bytes);
    await w.close();
  }
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "boot") {
    try {
      glue = await import(d.glueUrl);
      await glue.default();
      const persist = d.persist !== false;
      if (persist) {
        // C4: ask for eviction exemption (best-effort — denial is not fatal;
        // the V2.5 identity backup is the real hedge against storage pressure).
        navigator.storage?.persist?.().catch(() => {});
        // #106: a skipped restore boots an empty core that init() reads as a
        // fresh install — it would add_account and the next checkpoint would
        // rewrite the good snapshot over it. Fail the boot loudly instead;
        // the worker answers no RPC until the snapshot is confirmed restored.
        const root = await opfsRoot();
        if (!root) throw new Error("OPFS unavailable — cannot restore accounts");
        await restore(root);
      }
      dc = await glue.init(
        (line) => self.postMessage({ type: "line", line }),
        d.wsProxyUrl ?? null,
        persist,
      );
      if (persist) setInterval(() => { checkpoint().catch(() => {}); }, 8_000);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "boot-error", error: String(err?.message ?? err) });
    }
  } else if (d.type === "line" && dc) {
    dc.receive(d.line);
  } else if (d.type === "checkpoint") {
    // Reply only after the rewrite finishes. A caller that does not wait
    // can reload during removeEntry and boot an empty account.
    checkpoint().then(
      () => self.postMessage({ type: "checkpoint-done", id: d.id }),
      (err) => self.postMessage({ type: "checkpoint-error", id: d.id, error: String(err?.message ?? err) }),
    );
  } else if (d.type === "read-file") {
    try {
      const bytes = glue.vfs_read(d.path);
      self.postMessage({ type: "file", id: d.id, bytes });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  } else if (d.type === "list-dir") {
    try {
      const entries = await glue.vfs_list(d.path);
      self.postMessage({ type: "dir", id: d.id, entries });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  } else if (d.type === "write-file") {
    try {
      const parts = d.path.split("/").filter(Boolean);
      let dir = "/";
      for (let i = 0; i < parts.length - 1; i++) {
        dir += parts[i] + "/";
        glue.vfs_mkdirp(dir);
      }
      glue.vfs_write(d.path, d.bytes);
      self.postMessage({ type: "written", id: d.id });
    } catch (err) {
      self.postMessage({ type: "file-error", id: d.id, error: String(err?.message ?? err) });
    }
  }
};
