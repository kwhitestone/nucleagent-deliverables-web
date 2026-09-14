import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_UPLOAD_BYTES,
  buildCompletePayload,
  buildPresignPayload,
  validateUploadSelection,
} from "../src/addons/deliverables/api/uploadProtocol.ts";
import { setLocale } from "../src/i18n/index.ts";

test("buildPresignPayload preserves authoritative browser metadata", () => {
  const file = { name: "  Quarterly report.pdf  ", type: "application/pdf", size: 2048 };
  assert.deepEqual(buildPresignPayload(42, file), {
    conversationId: 42,
    name: "Quarterly report.pdf",
    mimeType: "application/pdf",
    size: 2048,
  });
});

test("buildPresignPayload uses a binary mime fallback", () => {
  assert.equal(buildPresignPayload(9, { name: "data.bin", type: "", size: 1 }).mimeType, "application/octet-stream");
});

test("validateUploadSelection rejects invalid conversation and file boundaries", () => {
  setLocale("zh");
  assert.equal(validateUploadSelection(0, { name: "a", type: "text/plain", size: 1 }), "请输入有效的对话 ID");
  assert.equal(validateUploadSelection(1, { name: " ", type: "text/plain", size: 1 }), "请选择有效文件");
  assert.equal(validateUploadSelection(1, { name: "a", type: "text/plain", size: 0 }), "文件不能为空");
  assert.match(validateUploadSelection(1, { name: "a", type: "text/plain", size: MAX_UPLOAD_BYTES + 1 }) ?? "", /100MB/);
  assert.equal(validateUploadSelection(1, { name: "a", type: "text/plain", size: 1 }), null);

  setLocale("en");
  assert.equal(validateUploadSelection(0, { name: "a", type: "text/plain", size: 1 }), "Enter a valid conversation ID");
  assert.equal(validateUploadSelection(1, { name: " ", type: "text/plain", size: 1 }), "Choose a valid file");
  setLocale("zh");
});

test("buildCompletePayload rejects malformed checksums", () => {
  assert.deepEqual(buildCompletePayload("", ""), { refId: "", sha256: "" });
  assert.deepEqual(buildCompletePayload(" ref-1 ", "A".repeat(64)), { refId: "ref-1", sha256: "a".repeat(64) });
  assert.throws(() => buildCompletePayload("", "not-a-checksum"), /SHA-256/);
});
