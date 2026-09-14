import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafePreviewUrl,
  previewKind,
  shortFileType,
} from "../src/addons/deliverables/utils/previewPolicy.ts";

test("previewKind recognizes safe inline formats", () => {
  assert.equal(previewKind("image/png", "x.png"), "image");
  assert.equal(previewKind("video/mp4", "x.mp4"), "video");
  assert.equal(previewKind("audio/mpeg", "x.mp3"), "audio");
  assert.equal(previewKind("application/pdf", "x.pdf"), "pdf");
  assert.equal(previewKind("text/plain; charset=utf-8", "x.txt"), "text");
  assert.equal(previewKind("text/markdown", "README.md"), "markdown");
  assert.equal(previewKind("application/octet-stream", "README.md"), "markdown");
  assert.equal(previewKind("text/html", "index.html"), "html");
  assert.equal(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "report.docx"), "docx");
  assert.equal(previewKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "data.xlsx"), "xlsx");
  assert.equal(previewKind("application/zip", "x.zip"), "unsupported");
});

test("assertSafePreviewUrl only accepts http and https", () => {
  assert.equal(assertSafePreviewUrl("https://files.example.test/a.pdf"), "https://files.example.test/a.pdf");
  assert.equal(assertSafePreviewUrl("http://127.0.0.1:26610/blob/a"), "http://127.0.0.1:26610/blob/a");
  for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "/relative"]) {
    assert.throws(() => assertSafePreviewUrl(value), /unsafe/i);
  }
});

test("shortFileType derives a restrained display label", () => {
  assert.equal(shortFileType("application/pdf", "report.pdf"), "PDF");
  assert.equal(shortFileType("image/png", "photo"), "PNG");
  assert.equal(shortFileType("", "archive.tar.gz"), "GZ");
  assert.equal(shortFileType("", "README"), "FILE");
});
