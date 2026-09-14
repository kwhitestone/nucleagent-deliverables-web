import assert from "node:assert/strict";
import test from "node:test";
import { resolvePageContext } from "../src/addons/deliverables/utils/pageContext.ts";

test("resolves a valid conversation-scoped embedded panel", () => {
  assert.deepEqual(resolvePageContext("?conversationId=42&embedded=1"), {
    conversationId: 42,
    embedded: true,
  });
});

test("ignores invalid conversation ids and unknown embedded values", () => {
  assert.deepEqual(resolvePageContext("?conversationId=-1&embedded=yes"), {
    conversationId: undefined,
    embedded: false,
  });
});
