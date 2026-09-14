import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCX_RENDER_OPTIONS,
  renderSanitizedDocx,
} from "../src/addons/deliverables/utils/docxPreviewPolicy.ts";

test("malicious altChunk content is rendered off-DOM with altChunk disabled", async () => {
  const liveHost = {
    innerHTML: "",
    ownerDocument: {
      createElement: () => ({ innerHTML: "" }),
    },
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
  let renderHost: HTMLElement | undefined;

  await renderSanitizedDocx(
    new ArrayBuffer(0),
    liveHost,
    async (_buffer, host, _styleHost, options) => {
      renderHost = host;
      assert.equal(options.renderAltChunks, false);
      host.innerHTML = '<iframe srcdoc="<script>globalThis.pwned=1</script>"></iframe><p>safe</p>';
    },
    (html) => html.replace(/<iframe[\s\S]*?<\/iframe>/i, ""),
  );

  assert.notEqual(renderHost, liveHost);
  assert.equal(liveHost.innerHTML, "<p>safe</p>");
  assert.equal(DOCX_RENDER_OPTIONS.renderAltChunks, false);
});
