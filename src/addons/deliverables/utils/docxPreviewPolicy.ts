import type { Options } from "docx-preview";

type DocxRenderer = (
  data: ArrayBuffer,
  bodyContainer: HTMLElement,
  styleContainer: HTMLElement | undefined,
  options: Partial<Options>,
) => Promise<unknown>;

type HtmlSanitizer = (html: string) => string;

export const DOCX_RENDER_OPTIONS = Object.freeze<Partial<Options>>({
  inWrapper: true,
  renderAltChunks: false,
});

export async function renderSanitizedDocx(
  buffer: ArrayBuffer,
  liveHost: HTMLElement,
  render: DocxRenderer,
  sanitize: HtmlSanitizer,
): Promise<void> {
  const detachedHost = liveHost.ownerDocument.createElement("div");
  await render(buffer, detachedHost, undefined, DOCX_RENDER_OPTIONS);

  liveHost.innerHTML = sanitize(detachedHost.innerHTML);
  for (const anchor of liveHost.querySelectorAll("a")) {
    try {
      const link = new URL(anchor.getAttribute("href") || "");
      if (link.protocol !== "http:" && link.protocol !== "https:") throw new Error("unsafe link");
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
    } catch {
      anchor.removeAttribute("href");
    }
  }
}
