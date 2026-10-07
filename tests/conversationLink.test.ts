import assert from "node:assert/strict";
import test from "node:test";
import { conversationHref, conversationTarget, openConversation } from "../src/addons/deliverables/utils/conversationLink.ts";

const shell = "https://nucleagent-web.dev.ndaeweb.com";

test("valid conversation ids link to the shell /chat page", () => {
  assert.equal(conversationHref(shell, 421), `${shell}/chat/421`);
  assert.equal(conversationHref(`${shell}/deliverables?x=1`, 7), `${shell}/chat/7`);
});

test("invalid ids never become links", () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "42", null, undefined]) {
    assert.equal(conversationHref(shell, id), null, String(id));
  }
});

test("the drawer's own conversation is not self-linked, other conversations are", () => {
  assert.equal(conversationHref(shell, 42, 42), null);
  assert.equal(conversationHref(shell, 43, 42), `${shell}/chat/43`);
});

test("embedded pages navigate the top frame, standalone pages open a new tab with noopener", () => {
  const standalone = { parent: null as unknown, open: (...args: unknown[]) => { calls.push(args); return null; } };
  standalone.parent = standalone;
  const embedded = { parent: {}, open: (...args: unknown[]) => { calls.push(args); return null; } };
  const calls: unknown[][] = [];
  assert.equal(conversationTarget(standalone as Window), "_blank");
  assert.equal(conversationTarget(embedded as Window), "_top");
  openConversation(`${shell}/chat/1`, embedded as unknown as Window);
  openConversation(`${shell}/chat/2`, standalone as unknown as Window);
  assert.deepEqual(calls, [
    [`${shell}/chat/1`, "_top"],
    [`${shell}/chat/2`, "_blank", "noopener,noreferrer"],
  ]);
});
