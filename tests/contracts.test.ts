import assert from "node:assert/strict";
import test from "node:test";

import {
  unwrapEnvelope,
  assertSuccessfulEnvelope,
  normalizeDeliverablePage,
  type Deliverable,
} from "../src/addons/deliverables/api/contracts.ts";

const sample: Deliverable = {
  id: 17,
  fileId: "file-17",
  storageNamespace: "core",
  userId: 7,
  conversationId: 31,
  stepId: "step-1",
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 4096,
  sha256: "a".repeat(64),
  status: "active",
  source: "generated",
  createdAt: "2026-09-03T08:00:00Z",
  updatedAt: "2026-09-03T08:00:00Z",
};

test("unwrapEnvelope returns the data payload", () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, message: "ok", data: sample }), sample);
});

test("data-less success envelopes remain valid for delete operations", () => {
  assert.doesNotThrow(() => assertSuccessfulEnvelope({ code: 0, message: "success" }));
  assert.throws(() => assertSuccessfulEnvelope({ code: 403, message: "denied" }), /denied/);
});

test("unwrapEnvelope rejects missing and non-success envelopes", () => {
  assert.throws(() => unwrapEnvelope({ code: 500, message: "failed", data: sample }), /failed/);
  assert.throws(() => unwrapEnvelope({ code: 0, message: "ok" }), /missing data/i);
});

test("normalizeDeliverablePage keeps valid rows and pagination", () => {
  assert.deepEqual(normalizeDeliverablePage({
    items: [sample, null, { ...sample, id: 0 }, { ...sample, id: 18, name: "" }],
    hasMore: true,
    nextBeforeId: 17,
  }), {
    items: [sample],
    hasMore: true,
    nextBeforeId: 17,
  });
});

test("normalizeDeliverablePage supplies safe defaults", () => {
  assert.deepEqual(normalizeDeliverablePage(undefined), {
    items: [],
    hasMore: false,
    nextBeforeId: 0,
  });
});
