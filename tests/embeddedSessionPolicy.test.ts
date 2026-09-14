import assert from "node:assert/strict";
import test from "node:test";

import { resolveShellLocale, shouldAcceptShellSession } from "../src/addons/deliverables/composables/embeddedSessionPolicy.ts";

test("shell session policy rejects invalid and stale versions", () => {
  assert.equal(shouldAcceptShellSession(2, null, Number.NaN, true), false);
  assert.equal(shouldAcceptShellSession(2, null, -1, true), false);
  assert.equal(shouldAcceptShellSession(2, null, 1, true), false);
});

test("shell session policy rejects a credential version already rejected by the child", () => {
  assert.equal(shouldAcceptShellSession(4, 4, 4, true), false);
  assert.equal(shouldAcceptShellSession(4, 4, 4, false), true);
  assert.equal(shouldAcceptShellSession(4, 4, 5, true), true);
});

test("locale policy accepts only trusted shell locale messages", () => {
  assert.equal(resolveShellLocale({ source: "shell", type: "locale", locale: "zh" }), "zh");
  assert.equal(resolveShellLocale({ source: "shell", type: "locale", locale: "en" }), "en");
  assert.equal(resolveShellLocale({ source: "sub", type: "locale", locale: "zh" }), null);
  assert.equal(resolveShellLocale({ source: "shell", type: "locale", locale: "fr" }), null);
});
