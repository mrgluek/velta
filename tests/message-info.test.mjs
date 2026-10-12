import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatDateTime, formatServerUrl, messageInfoState, timeParts } from "../app/js/format.js";
import { JsonRpcCore } from "../app/js/rpc-core.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("clocks are 24-hour", () => {
  const afternoon = new Date(2026, 9, 12, 15, 4, 5).getTime();
  const morning = new Date(2026, 9, 12, 3, 4, 5).getTime();
  for (const ts of [afternoon, morning]) {
    assert.doesNotMatch(formatDateTime(ts), /AM|PM/);
    assert.doesNotMatch(timeParts(ts).title, /AM|PM/);
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, hourCycle: "h23" });
  assert.ok(formatDateTime(afternoon).includes(clock(afternoon)));
  assert.ok(formatDateTime(morning).includes(clock(morning)));
  assert.equal(timeParts(afternoon).title, formatDateTime(afternoon));
  assert.equal(formatDateTime(NaN), "—");
});

test("server URLs drop the INBOX wrapper and keep a real folder", () => {
  assert.equal(
    formatServerUrl("<a@relay.example.org/INBOX/;UID=180514>"),
    "a@relay.example.org UID=180514",
  );
  assert.equal(
    formatServerUrl("<a@relay.example.org/INBOX/DeltaChat/;UID=9>"),
    "a@relay.example.org INBOX/DeltaChat UID=9",
  );
  assert.equal(formatServerUrl("not-a-url"), "not-a-url");
});

test("message info state is Seen plus Encrypted", () => {
  assert.equal(messageInfoState({ from: 1, state: "read", encrypted: true }), "Seen, Encrypted");
  assert.equal(messageInfoState({ from: 1, state: "sent", encrypted: false }), "Not seen, Not encrypted");
  assert.equal(messageInfoState({ from: 0, unread: true, encrypted: true }), "Not seen, Encrypted");
  assert.equal(messageInfoState({ from: 0, state: "read" }), "Seen, Encrypted");
});

test("mapped messages keep sent and received instants", () => {
  const msg = new JsonRpcCore()._mapMessage({
    id: 202959, chatId: 1, fromId: 2, timestamp: 100, sortTimestamp: 200, receivedTimestamp: 300,
    state: 13, viewType: "Text", showPadlock: false,
    sender: { id: 2, displayName: "A" },
  });
  assert.equal(msg.ts, 200000);
  assert.equal(msg.sentTs, 100000);
  assert.equal(msg.receivedTs, 300000);
  assert.equal(msg.encrypted, false);
  const unset = new JsonRpcCore()._mapMessage({
    id: 1, chatId: 1, fromId: 1, timestamp: 0, sortTimestamp: 5, receivedTimestamp: 0,
    state: 26, viewType: "Text", showPadlock: true, sender: {},
  });
  assert.equal(unset.sentTs, null);
  assert.equal(unset.receivedTs, null);
});

test("message info and clocks do not use a 12-hour locale string", () => {
  const chat = read("app/js/chat-view.js");
  const p2p = read("app/js/p2p.js");
  assert.match(chat, /Database ID/);
  assert.match(chat, /Message-ID/);
  assert.match(chat, /Server URL/);
  assert.match(chat, /getMessageInfo/);
  assert.doesNotMatch(chat, /toLocaleString\(/);
  assert.match(p2p, /formatTime\(m\.ts\)/);
  assert.doesNotMatch(p2p, /toLocaleTimeString/);
  for (const f of ["app/js/format.js", "app/js/diagnostics.js"]) {
    const calls = read(f).match(/toLocaleTimeString\([\s\S]{0,220}?\)/g) || [];
    assert.ok(calls.length > 0, f);
    for (const c of calls) assert.match(c, /hour12:\s*false|\bH24\b/);
  }
});
