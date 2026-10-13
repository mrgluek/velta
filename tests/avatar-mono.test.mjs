// A tile without a real key (no fingerprint yet, or our own profile before it
// is configured) keeps the identity-tile look but in greyscale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setFingerprintSource, fingerprintFor, cachedFingerprintIsDerived, fingerprintGroups, buildAvatarSvg, avatarBackgroundUrl, monoFill } from "../app/js/avatar.js";

const KEY_INFO = "Messages are end-to-end encrypted.\nFingerprints:\n\nMe (me@x.org):\nAAAA BBBB CCCC DDDD EEEE\nFFFF 1111 2222 3333 4444\n\nBob (bob@x.org):\nCCCB 5AA9 F6E1 141C 9431\n65F1 DB18 B18C BCF7 0487";

const colorFills = (svg) => [...svg.matchAll(/<rect [^>]*fill="([^"]+)"/g)].map((m) => m[1]);
const isGrey = (c) => /^#([0-9a-f]{2})\1\1$/.test(c);

test("a contact with a key is colored, one without is greyscale", async () => {
  setFingerprintSource(async (id) => (id === 7 ? KEY_INFO : "No encryption."), "M1", { addrOf: async (id) => `c${id}@x.org` });
  const real = await fingerprintFor(7, "bob@x.org");
  const fake = await fingerprintFor(8, "carol@x.org");
  assert.equal(cachedFingerprintIsDerived(7), false);
  assert.equal(cachedFingerprintIsDerived(8), true);
  const colored = colorFills(buildAvatarSvg({ groups: fingerprintGroups(real) }));
  assert.ok(colored.every((c) => !c.startsWith("#")), "named CSS colors");
  const grey = colorFills(buildAvatarSvg({ groups: fingerprintGroups(fake), mono: true }));
  assert.equal(grey.length, 10);
  assert.ok(grey.every(isGrey), `all grey: ${grey}`);
  assert.notEqual(new Set(grey).size, 1, "the pattern stays visible");
  const url = decodeURIComponent(avatarBackgroundUrl({ groups: fingerprintGroups(fake), mono: true }));
  assert.ok(colorFills(url).every(isGrey));
  assert.notEqual(url, decodeURIComponent(avatarBackgroundUrl({ groups: fingerprintGroups(fake) })), "mono and color are cached apart");
  assert.equal(buildAvatarSvg({ groups: fingerprintGroups(fake), mono: true, withCaptions: true }).includes("<text"), false);
});

test("own profile: greyscale before it has an address, colored once configured", async () => {
  let addr = "";
  setFingerprintSource(async () => { throw new Error("self"); }, "M2", { addrOf: async () => addr });
  await fingerprintFor(1);
  assert.equal(cachedFingerprintIsDerived(1), true, "unconfigured self");
  addr = "me@x.org";
  setFingerprintSource(async () => { throw new Error("self"); }, "M2", { addrOf: async () => addr });
  await fingerprintFor(1);
  assert.equal(cachedFingerprintIsDerived(1), false, "configured self re-resolved");
});

test("monoFill keeps lightness", () => {
  assert.equal(monoFill([255, 255, 255]), "#ffffff");
  assert.equal(monoFill([0, 0, 0]), "#000000");
  assert.equal(monoFill([255, 0, 0]), "#4c4c4c");
});
