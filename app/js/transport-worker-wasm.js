// C2 transport: satisfies the JsonRpcCore transport contract
// { name, send(line), setReceiver(fn) } by hosting the wasm core in a
// module worker (worker-wasm.js). Feature-detect at the boot site decides
// between this and the Tauri/WS transports (no __TAURI__ + PWA + wasm flag).
// A reload starts the new page while the previous document still holds
// velta-wasm-core. ifAvailable would fail that race and the app would boot
// the empty demo instead of the saved account. A real second tab still
// holds the lock after the grace period.
export async function acquireWasmLock(request, onHeld, waitMs = 1500) {
  if (typeof request !== "function") return true;
  const once = () => new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(!!ok); } };
    request("velta-wasm-core", { ifAvailable: true }, (lock) => {
      finish(!!lock);
      if (!lock) return;
      return new Promise((release) => { onHeld(release); });
    }).catch(() => finish(false));
  });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await once()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export class WorkerWasmTransport {
  constructor({
    workerUrl = new URL("./worker-wasm.js", import.meta.url).href,
    glueUrl,
    wsProxyUrl = null,
  } = {}) {
    this.name = "worker-wasm";
    this._workerUrl = workerUrl;
    this._glueUrl = glueUrl;
    this._wsProxyUrl = wsProxyUrl;
    this._receiver = null;
    this._worker = null;
    this._fileSeq = 0;
  }

  async setReceiver(fn) {
    this._receiver = fn;
    if (!this._worker) await this._boot();
  }

  send(line) {
    this._worker?.postMessage({ type: "line", line });
  }

  // Generic memfs passthrough (V2.5 identity backup: grab the self-keys tar
  // the core wrote, or place one for import). Resolves Uint8Array / undefined.
  readCoreFile(path) {
    return this._fileRequest({ type: "read-file", path }, "file");
  }

  readCoreFileList(path) {
    return this._fileRequest({ type: "list-dir", path }, "dir");
  }

  writeCoreFile(path, bytes) {
    return this._fileRequest({ type: "write-file", path, bytes }, "written");
  }

  _fileRequest(msg, okType) {
    if (!this._worker) return Promise.reject(new Error("worker not booted"));
    const id = ++this._fileSeq;
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const d = e.data;
        if (d.id !== id) return;
        this._worker.removeEventListener("message", onMsg);
        if (d.type === okType) resolve(d.bytes ?? d.entries);
        else reject(new Error(d.error));
      };
      this._worker.addEventListener("message", onMsg);
      this._worker.postMessage({ ...msg, id });
    });
  }

  // Ask the worker to copy memfs → OPFS. Refresh kills the worker; the
  // 8s interval alone never runs for that last session.
  checkpoint() {
    this._worker?.postMessage({ type: "checkpoint" });
  }

  async _boot() {
    // Single-tab gate: two live cores would race the OPFS snapshot. Hold the
    // lock for the worker's lifetime; a second tab gets a clear error.
    const acquired = await acquireWasmLock(
      navigator.locks?.request?.bind(navigator.locks),
      (release) => { this._releaseLock = release; },
    );
    if (!acquired) throw new Error("wasm core is already open in another tab");
    return new Promise((resolve, reject) => {
      const w = new Worker(this._workerUrl, { type: "module" });
      const flush = () => w.postMessage({ type: "checkpoint" });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
      window.addEventListener("pagehide", flush);
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === "line") this._receiver?.(d.line);
        else if (d.type === "ready") resolve();
        else if (d.type === "boot-error") {
          this._releaseLock?.();
          reject(new Error(d.error));
        }
      };
      w.onerror = (e) => {
        this._releaseLock?.();
        reject(new Error(`worker error: ${e.message ?? "unknown"}`));
      };
      w.postMessage({ type: "boot", glueUrl: this._glueUrl, wsProxyUrl: this._wsProxyUrl });
      this._worker = w;
    });
  }
}
