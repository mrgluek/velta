import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactMediaUrl } from "../app/js/media.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("media server token never reaches the logs", () => {
  assert.equal(
    redactMediaUrl(`http://127.0.0.1:41234/${TOKEN}/%2Fdata%2Faccounts%2Fa.jpg?w=720`),
    "http://127.0.0.1:41234/<token>/%2Fdata%2Faccounts%2Fa.jpg?w=720",
  );
  assert.equal(redactMediaUrl(`http://127.0.0.1:41234/${TOKEN}`), "http://127.0.0.1:41234/<token>", "media base without a path");
  assert.equal(redactMediaUrl("http://blobfile.localhost/%2Fa.jpg"), "http://blobfile.localhost/%2Fa.jpg", "other URLs unchanged");
  assert.equal(redactMediaUrl(undefined), "");
});

test("the media server is not pinned to a port the CSP would have to name", () => {
  for (const file of ["../app/index.html", "../velta-app/src-tauri/tauri.conf.json", "../velta-app/src-tauri/tauri.android.conf.json"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!src.includes("127.0.0.1:20810"), `${file}: fixed media port gone`);
    for (const dir of ["img-src", "media-src", "frame-src", "connect-src"]) {
      const m = src.match(new RegExp(`${dir} [^;]*`));
      assert.ok(m && m[0].includes("http://127.0.0.1:*"), `${file}: ${dir} allows the ephemeral media port`);
    }
  }
  const rust = readFileSync(new URL("../velta-app/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.ok(rust.includes('TcpListener::bind("127.0.0.1:0")'), "media server binds an ephemeral port");
  assert.ok(!rust.includes('bind("127.0.0.1:20810")'), "no fixed media port");
});
