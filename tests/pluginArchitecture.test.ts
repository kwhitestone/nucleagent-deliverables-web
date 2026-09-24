import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("deliverables web is composed from a scoped V2 addon", () => {
  const main = source("main.ts");
  const router = source("router/index.ts");
  const deliverables = source("addons/deliverables/index.ts");
  const shellBridge = source("addons/deliverables/composables/embeddedSession.ts");

  assert.match(main, /@prism-fusion\/plugin-runtime/);
  assert.match(main, /await nextHost\.install\(\)[\s\S]*nextApp\.use\(router\)/);
  assert.doesNotMatch(source("App.vue"), /DeliverablesPage/);
  assert.match(router, /redirect:\s*["']\/deliverables["']/);
  assert.match(deliverables, /routeScopes:\s*\[[^\]]*["']\/deliverables["']/s);
  assert.match(shellBridge, /createRemoteChildChannel/);
  assert.doesNotMatch(shellBridge, /window\.parent\.postMessage/);
  assert.equal(existsSync(new URL("../src/pages", import.meta.url)), false);
});

test("standalone no-session exits to the shell's /login, embedded never navigates", () => {
  const addon = source("addons/deliverables/index.ts");
  const session = source("addons/deliverables/composables/embeddedSession.ts");
  assert.match(addon, /meta:\s*\{\s*requiresAuth:\s*true\s*\}/);
  assert.match(addon, /window\.parent !== window[^\n]*return true/);
  assert.match(session, /if \(window\.parent === window\) \{\s*leaveForShellLogin\(\);/);
  assert.doesNotMatch(source("addons/deliverables/shellLogin.ts"), /\/auth["`]/);
});
