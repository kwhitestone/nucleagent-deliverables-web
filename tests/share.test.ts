import assert from "node:assert/strict";
import test from "node:test";

import { shareOrCopy } from "../src/addons/deliverables/utils/share.ts";

const data = { title: "report.pdf", url: "https://files.example.test/report" };

test("shareOrCopy prefers the native share sheet", async () => {
  const shared: unknown[] = [];
  assert.equal(await shareOrCopy({ share: async (value) => { shared.push(value); } }, data), "shared");
  assert.deepEqual(shared, [data]);
});

test("shareOrCopy treats a dismissed share sheet as cancelled, not as a fallback", async () => {
  const copied: string[] = [];
  const nav = {
    share: async () => { throw new DOMException("dismissed", "AbortError"); },
    clipboard: { writeText: async (text: string) => { copied.push(text); } },
  };
  assert.equal(await shareOrCopy(nav, data), "cancelled");
  assert.deepEqual(copied, []);
});

test("shareOrCopy falls back to copying the link when share is missing or refused", async () => {
  const copied: string[] = [];
  const clipboard = { writeText: async (text: string) => { copied.push(text); } };
  assert.equal(await shareOrCopy({ clipboard }, data), "copied");
  assert.equal(await shareOrCopy({ share: async () => { throw new DOMException("no", "NotAllowedError"); }, clipboard }, data), "copied");
  assert.deepEqual(copied, [data.url, data.url]);
});

test("shareOrCopy reports failure when neither share nor clipboard works", async () => {
  assert.equal(await shareOrCopy(undefined, data), "failed");
  assert.equal(await shareOrCopy({}, data), "failed");
  assert.equal(await shareOrCopy({ clipboard: { writeText: async () => { throw new Error("denied"); } } }, data), "failed");
});
