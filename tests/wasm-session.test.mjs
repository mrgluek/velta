import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acquireWasmLock } from "../app/js/transport-worker-wasm.js";

// A refresh starts the new page while the dying one still holds
// velta-wasm-core. ifAvailable used to fail that race and boot the demo.
// The retry waits the lock out. A tab that keeps holding it still loses.

function request(held) {
  return (name, options, callback) => {
    assert.equal(name, "velta-wasm-core");
    assert.equal(options.ifAvailable, true);
    callback(held());
    return Promise.resolve();
  };
}

test("acquireWasmLock waits out a lock the dying page still holds", async () => {
  let n = 0;
  let release = null;
  const ok = await acquireWasmLock(
    request(() => (++n >= 3 ? {} : null)),
    (r) => { release = r; },
    500,
  );
  assert.equal(ok, true);
  assert.equal(n, 3);
  assert.equal(typeof release, "function");
});

test("acquireWasmLock gives up when another tab keeps the core", async () => {
  const ok = await acquireWasmLock(request(() => null), () => {}, 120);
  assert.equal(ok, false);
});

test("a refresh flushes the account snapshot and a boot checkpoints it", () => {
  const transport = readFileSync(new URL("../app/js/transport-worker-wasm.js", import.meta.url), "utf8");
  const rpc = readFileSync(new URL("../app/js/rpc-core.js", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../app/js/worker-wasm.js", import.meta.url), "utf8");
  assert.match(transport, /pagehide/);
  assert.match(transport, /visibilityState === "hidden"/);
  assert.match(rpc, /this\.transport\.checkpoint\?\.\(\)/);
  assert.match(worker, /checkpointChain/);
});
