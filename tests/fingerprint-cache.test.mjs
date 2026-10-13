// #45: fingerprints are cached per (accountId, contactId) — switching
// accounts re-wires the source without wiping other accounts' entries, and
// a contact resolved once is never fetched again.
import test from "node:test";
import assert from "node:assert/strict";
import { setFingerprintSource, fingerprintFor, cachedFingerprint, parseFingerprint, deriveFingerprint } from "../app/js/avatar.js";

const ALICE_KEY = "0123 4567 89AB CDEF 0123 4567 89AB CDEF 0123 4567";

function wire(accountId, log) {
  setFingerprintSource(async (contactId) => {
    log.push(`${accountId}:${contactId}`);
    return `Me (me@x):\n\nAlice (alice@x):\n${ALICE_KEY}`;
  }, accountId);
}

test("fingerprints are cached per (accountId, contactId)", async () => {
  const log = [];
  wire("A", log);

  const p1 = fingerprintFor(5, "alice@x");
  const p2 = fingerprintFor(5, "alice@x");
  assert.equal(p1, p2, "same contact reuses the in-flight promise");
  assert.equal(await p1, ALICE_KEY.replaceAll(" ", ""));
  assert.deepEqual(log, ["A:5"], "fetched exactly once");

  wire("B", log);
  assert.equal(cachedFingerprint(5), null, "account B has its own namespace");
  await fingerprintFor(5, "alice@x");
  assert.deepEqual(log, ["A:5", "B:5"]);

  wire("A", log);
  assert.equal(cachedFingerprint(5), ALICE_KEY.replaceAll(" ", ""), "switching back does not refetch");
  assert.deepEqual(log, ["A:5", "B:5"], "account A entry survived the round trip");

  // No key yet: the tile follows the address, not the local contact id.
  setFingerprintSource(async () => "No encryption.", "Z", {
    addrOf: async () => "same@person.org",
  });
  const fromId3 = await fingerprintFor(3, "");
  setFingerprintSource(async () => "No encryption.", "Y", {
    addrOf: async () => "same@person.org",
  });
  const fromId9 = await fingerprintFor(9, "");
  assert.equal(fromId3, fromId9, "same address, different contact ids, same tile");
  assert.notEqual(fromId3, await deriveFingerprint("id:3"));
});

const BOB = "CCCB5AA9F6E1141C943165F1DB18B18CBCF70487";
const BOB_LINES = "CCCB 5AA9 F6E1 141C 9431\n65F1 DB18 B18C BCF7 0487";

test("a fingerprint tile ignores the display name and the address", () => {
  const addr = "e7a1b2c3@mail.org";
  const named = `Messages are end-to-end encrypted.\nFingerprints:\n\nIch (me@mail.org):\nAAAA BBBB CCCC DDDD EEEE\nFFFF 1111 2222 3333 4444\n\nCafe (${addr}):\n${BOB_LINES}`;
  const raw = `Messages are end-to-end encrypted.\nFingerprints:\n\nMe (me@mail.org):\nAAAA BBBB CCCC DDDD EEEE\nFFFF 1111 2222 3333 4444\n\n${addr} (${addr}):\n${BOB_LINES}`;
  assert.equal(parseFingerprint(named, addr), BOB);
  assert.equal(parseFingerprint(raw, addr), BOB);
  assert.equal(parseFingerprint("No encryption.", addr), null);
});
