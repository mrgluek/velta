import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

test("the drawer multi-device checkbox is the core bcc_self setting", () => {
  assert.match(ui, /data-toggle="multidevice"/);
  assert.match(app, /getConfig\?\.\("bcc_self"\)/);
  assert.match(app, /setConfig\("bcc_self", on \? "1" : "0"\)/);
  assert.doesNotMatch(app, /localStorage\.(get|set)Item\("velta-(bcc|multidevice)/);
});
