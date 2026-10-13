import test from "node:test";
import assert from "node:assert/strict";

// markdown.js pulls in components.js / invites.js (custom elements, storage).
globalThis.HTMLElement = class {};
globalThis.customElements = { get() {}, define() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
const { renderMarkdown } = await import("../app/js/markdown.js");
const { tunnelCardInfo } = await import("../app/js/tunnel.js");

const KEY = "Io9GCoQ60uHpzYq6e4uxx9IrnRrNpG59u8GSut7A1ps";
const LINK = `velta://tunnel?v=1&zone=f.example.org&key=${KEY}&r=192.0.2.1,192.0.2.2`;

test("bare velta://tunnel link becomes a tunnel card showing zone and resolver count", () => {
  const html = renderMarkdown(`Setup: ${LINK}`);
  assert.match(html, /class="invite-card tunnel-card"/);
  assert.match(html, /data-tunnel-open="velta:\/\/tunnel\?v=1&amp;zone=f\.example\.org/);
  assert.match(html, /f\.example\.org · 2 resolvers/);
  assert.ok(!html.includes("<a "));
});

test("the key is only in the data attributes, never in visible text", () => {
  const html = renderMarkdown(LINK);
  const visible = html.replace(/<[^>]*>/g, "");
  assert.ok(!visible.includes(KEY));
});

test("trailing punctuation stays outside the card", () => {
  const html = renderMarkdown(`(${LINK}).`);
  assert.ok(html.endsWith("</span>)."));
});

test("a link without a zone is not a card; other velta:// links stay text", () => {
  assert.equal(tunnelCardInfo("velta://tunnel?v=1&key=x"), null);
  assert.ok(!renderMarkdown("velta://tunnel?v=1&key=x").includes("tunnel-card"));
  assert.ok(!renderMarkdown("velta://chat?account=1&chat=2&t=abc").includes("<a "));
});
