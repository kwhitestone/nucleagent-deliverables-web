import assert from "node:assert/strict";
import test from "node:test";
import { conversationHref as rawHref, conversationTarget, openConversation, validIMReference } from "../src/addons/deliverables/utils/conversationLink.ts";

const shell = "https://nucleagent-web.dev.ndaeweb.com";
const conversationHref = (origin: string, id: unknown, current?: number) => rawHref(origin, { conversationId: id }, current);

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

test("IM rows open their IM channel directly; Agent rows keep /chat", () => {
  const group = { channelId: "g-d3200795abc", channelType: 2, agentUid: "37" };
  assert.equal(rawHref(shell, { conversationId: 463, imReference: group }),
    `${shell}/im?imChannelId=g-d3200795abc&imChannelType=2&imAgentUid=37`);
  assert.equal(rawHref(shell, { conversationId: 9, imReference: { channelId: "5@37", channelType: 1, agentUid: "37" } }),
    `${shell}/im?imChannelId=5%4037&imChannelType=1&imAgentUid=37`);
  assert.equal(rawHref(shell, { conversationId: 466 }), `${shell}/chat/466`);
  assert.equal(rawHref(shell, { conversationId: 463, imReference: group }, 463), null);
});

test("invalid IM references fall back to /chat instead of a broken IM link", () => {
  const bad: unknown[] = [
    null, "g-x", [], { channelId: "g x", channelType: 2, agentUid: "37" },
    { channelId: "g-x", channelType: 3, agentUid: "37" }, { channelId: "g-x", channelType: 2, agentUid: "037" },
    { channelId: "g-x", channelType: 2, agentUid: 37 }, { channelId: "x".repeat(192), channelType: 2, agentUid: "37" },
    { channelId: "37@5", channelType: 1, agentUid: "37" }, { channelId: "5@6", channelType: 1, agentUid: "37" },
    { channelId: "5@37@9", channelType: 1, agentUid: "37" }, { channelId: "g-x", channelType: 2, agentUid: "18446744073709551616" },
  ];
  for (const imReference of bad) {
    assert.equal(validIMReference(imReference), false, JSON.stringify(imReference));
    assert.equal(rawHref(shell, { conversationId: 7, imReference }), `${shell}/chat/7`);
  }
});
