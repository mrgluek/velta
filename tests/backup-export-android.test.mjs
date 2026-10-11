import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");

test("Android backup export asks where to save instead of the private exports dir", () => {
  assert.match(app, /plugin:dialog\|save/);
  assert.match(app, /publish_backup/);
  assert.doesNotMatch(app, /\/exports"/);
});
