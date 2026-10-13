// V2.5 identity backup crypto: bundle round-trip, wrong-passphrase/tamper
// rejection, base64 helpers. Pure WebCrypto — runs in node and in the
// browser (the rig re-runs the round-trip in Chromium via the same module).
import test from "node:test";
import assert from "node:assert/strict";
import {
  wrapIdentityBundle,
  unwrapIdentityBundle,
  buildIdentityBundle,
  bytesToBase64,
  base64ToBytes,
  mailLoginFromTransports,
  accountDirFromToml,
  mailLoginsFromDbText,
} from "../app/js/identity-backup.js";

const PASS = "correct horse battery staple";
const KEYS = { "private-key-abc.asc": bytesToBase64(new TextEncoder().encode("-----BEGIN PGP PRIVATE KEY-----\nabc\n")), };

test("bundle round-trip preserves every field", async () => {
  const bundle = buildIdentityBundle({ addr: "alice@example.org", mail_pw: "hunter2", keys: KEYS });
  const wrapped = await wrapIdentityBundle(bundle, PASS);
  const out = await unwrapIdentityBundle(wrapped, PASS);
  assert.equal(out.kind, "velta-identity");
  assert.equal(out.addr, "alice@example.org");
  assert.equal(out.mail_pw, "hunter2");
  assert.deepEqual(out.keys, KEYS);
  assert.ok(out.exported);
});

test("wrapped file carries the magic header and is not plaintext", async () => {
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr: "a@b.c", mail_pw: "x", keys: {} }), PASS);
  assert.ok(new TextDecoder().decode(wrapped.slice(0, 16)).startsWith("VeltaIdentity-v1"));
  assert.ok(!new TextDecoder().decode(wrapped).includes("hunter2"));
});

test("wrong passphrase is rejected", async () => {
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr: "a@b.c", mail_pw: "x", keys: {} }), PASS);
  await assert.rejects(() => unwrapIdentityBundle(wrapped, "wrong"), /Wrong passphrase or corrupted backup/);
});

test("tampered ciphertext is rejected", async () => {
  const wrapped = await wrapIdentityBundle(buildIdentityBundle({ addr: "a@b.c", mail_pw: "x", keys: {} }), PASS);
  wrapped[wrapped.length - 5] ^= 0xff;
  await assert.rejects(() => unwrapIdentityBundle(wrapped, PASS));
});

test("non-identity files are rejected before any crypto", async () => {
  await assert.rejects(() => unwrapIdentityBundle(new TextEncoder().encode("hello world, not a backup at all"), PASS), /Not a Velta identity backup/);
  await assert.rejects(() => unwrapIdentityBundle(new Uint8Array(8), PASS), /Not a Velta identity backup/);
});

test("mail login accepts a flat password or the db's imap password", () => {
  const flat = [{ addr: "a@example.org", password: "flat-secret" }];
  assert.deepEqual(mailLoginFromTransports(flat, "a@example.org"), { addr: "a@example.org", mailPw: "flat-secret" });
  const nested = [{ addr: "a@example.org", imap: { password: "nested-secret" } }, { addr: "b@example.org", password: "other" }];
  assert.deepEqual(mailLoginFromTransports(nested, "a@example.org"), { addr: "a@example.org", mailPw: "nested-secret" });
  assert.equal(mailLoginFromTransports([{ addr: "a@example.org" }], "a@example.org"), null);
  assert.deepEqual(mailLoginFromTransports([{ addr: "a@example.org" }, { addr: "b@example.org", password: "other" }], "a@example.org"), { addr: "b@example.org", mailPw: "other" });
});

test("account dir is the selected toml directory name", () => {
  const toml = `selected_account = 2\n[[accounts]]\nid = 1\ndir = "not-this"\n[[accounts]]\nid = 2\ndir = "acct-dir"\n`;
  assert.equal(accountDirFromToml(toml), "acct-dir");
  assert.equal(accountDirFromToml(`selected_account = 1\n[[accounts]]\nid = 1\ndir = "../x"`), null);
});

test("db text yields login json and ignores a chat that mentions a password", () => {
  const entered = '{"addr":"a@example.org","imap":{"server":"","password":"db-secret"},"certificate_checks":"Strict"}';
  const configured = '{"addr":"a@example.org","imap_password":"cfg-secret","certificate_checks":"Strict"}';
  const decoy = '{"addr":"evil@example.org","password":"nope"}';
  const logins = mailLoginsFromDbText(decoy + entered + configured);
  assert.deepEqual(mailLoginFromTransports(logins, "a@example.org"), { addr: "a@example.org", mailPw: "db-secret" });
});

test("base64 helpers round-trip binary bytes", () => {
  const u8 = new Uint8Array(70_000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(u8)), u8);
});

// #105 audit: the restore path must never strand the user on a half-created
// account. Source-integrity pins for the app.js flow (not importable):
//   • unwrap BEFORE addAccount — a wrong passphrase creates nothing;
//   • configure failure removes the stray (deleteAccount) instead of
//     leaving it selected (#99 family);
//   • configure runs BEFORE import_self_keys (spike day 18 — the import
//     marks the account configured and would short-circuit the login proof).
const appSrc = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
import { readFileSync } from "node:fs";

test("restore flow ordering: unwrap-first, configure-before-keys, stray rollback", () => {
  const start = appSrc.indexOf("async function runIdentityRestore(");
  const end = appSrc.indexOf("function openIdentityBackup(", start);
  assert.ok(start !== -1 && end > start, "runIdentityRestore exists before openIdentityBackup");
  const body = appSrc.slice(start, end);
  const unwrap = body.indexOf("unwrapIdentityBundle(");
  const add = body.indexOf("core.addAccount()");
  const configure = body.indexOf("core.configureWithCredentials(bundle.addr");
  const keys = body.indexOf("importSelfKeys(id, dir, pass)");
  const rollback = body.indexOf("core.deleteAccount(id)");
  assert.ok(unwrap !== -1 && unwrap < add, "bundle unwrapped before any account is created");
  assert.ok(add !== -1 && add < configure && configure < keys, "configure BEFORE import_self_keys (day 18)");
  assert.ok(rollback !== -1 && rollback < keys, "failed configure removes the stray account");
  assert.ok(!body.includes("batchSetConfig"), "core 2.63: legacy addr/mail_pw configs are gone — add_transport configures");
});

test("identity export takes a password from the transport list or the account db", () => {
  const start = appSrc.indexOf("async function runIdentityExport(");
  const end = appSrc.indexOf("async function runIdentityRestore(", start);
  const body = appSrc.slice(start, end);
  assert.ok(body.includes("mailLoginForBackup()"));
  assert.ok(appSrc.includes("mailLoginsFromDbText("));
  assert.ok(!body.includes("transport?.password"));
});
