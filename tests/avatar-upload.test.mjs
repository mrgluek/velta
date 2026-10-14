import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const source = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const from = source.indexOf("async function writePickedImage(");
const to = source.indexOf("async function pickProfileImage(", from);
assert.notEqual(from, -1, "missing writePickedImage");
assert.ok(to > from, "missing pickProfileImage after writePickedImage");

function load(core) {
  const ctx = { core };
  createContext(ctx);
  new Script(source.slice(from, to), { filename: "app/js/app.js" }).runInContext(ctx);
  return ctx;
}

test("writePickedImage puts bytes on /uploads for wasm", async () => {
  const writes = [];
  const ctx = load({
    transport: {
      writeCoreFile: async (path, bytes) => { writes.push({ path, bytes }); },
    },
  });
  const file = { name: "me.webp", arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  const path = await ctx.writePickedImage(file);
  assert.match(path, /^\/uploads\/avatar-\d+\.webp$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, path);
  assert.deepEqual([...writes[0].bytes], [1, 2, 3]);
});

test("writePickedImage skips memfs when the mock has no writeCoreFile", async () => {
  const ctx = load({});
  const file = { name: "me.png", arrayBuffer: async () => new Uint8Array([9]).buffer };
  assert.equal(await ctx.writePickedImage(file), null);
});

test("browser picker wires writePickedImage before any data URL fallback", () => {
  const start = source.indexOf("async function pickProfileImage(");
  const end = source.indexOf("async function editProfileFlow(", start);
  const fn = source.slice(start, end);
  assert.match(fn, /writePickedImage/);
  assert.match(fn, /createObjectURL/);
});
