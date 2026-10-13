import test from "node:test";
import assert from "node:assert/strict";
// markdown.js pulls in components.js / invites.js (custom elements, storage).
globalThis.HTMLElement = class {};
globalThis.customElements = { get() {}, define() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
const { renderMarkdown } = await import("../app/js/markdown.js");

const LINK = "velta://tunnel?v=1&zone=f.example.org&key=Io9GCoQ60uHpzYq6e4uxx9IrnRrNpG59u8GSut7A1ps&r=192.0.2.1,192.0.2.2";

test("bare velta://tunnel link becomes an anchor without target=_blank", () => {
  const html = renderMarkdown(`Setup: ${LINK}`);
  assert.match(html, /<a href="velta:\/\/tunnel\?v=1&amp;zone=f\.example\.org[^"]*" class="velta-link">/);
  assert.ok(!html.includes("_blank"));
  assert.ok(html.includes("r=192.0.2.1,192.0.2.2</a>"));
});

test("trailing punctuation stays outside the link", () => {
  const html = renderMarkdown(`(${LINK}).`);
  assert.ok(html.endsWith("</a>)."));
});

test("other velta:// links and markdown-labelled ones are not linkified", () => {
  assert.ok(!renderMarkdown("velta://chat?account=1&chat=2&t=abc").includes("<a "));
  // A label can never disguise the destination: the raw link stays visible.
  const labelled = renderMarkdown(`[click](${LINK})`);
  assert.ok(!/<a [^>]*>click<\/a>/.test(labelled));
});
