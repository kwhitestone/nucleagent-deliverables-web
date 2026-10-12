import { assertSafePreviewUrl } from "@/addons/deliverables/utils/previewPolicy";

/**
 * Real "save to disk" for a stored deliverable. A cross-origin `<a download>` is ignored
 * by browsers and `window.open` only previews image/video, so the bytes are fetched
 * anonymously (the signed URL is the only credential), wrapped in a same-origin object
 * URL and handed to an anchor with the item's own name.
 * ponytail: whole file in memory as a Blob; fine under the 100 MB catalog cap, stream to disk if that cap grows.
 */
export const REVOKE_AFTER_MS = 40_000; // the browser resolves the blob when the download starts; revoke well after

const running = new Map<number, Promise<void>>();

/** Last path segment only, without characters that are invalid in file names. */
export function downloadFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().replace(/^\.+|\.+$/g, "").trim();
  return cleaned || "download";
}

/** One save per key at a time: repeated clicks join the running one. */
export function saveAsFile(key: number, resolveUrl: () => Promise<string>, name: string, signal: AbortSignal): Promise<void> {
  const current = running.get(key);
  if (current) return current;
  const run = save(resolveUrl, name, signal).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function save(resolveUrl: () => Promise<string>, name: string, signal: AbortSignal): Promise<void> {
  const url = assertSafePreviewUrl(await resolveUrl());
  const response = await fetch(url, { signal, credentials: "omit", redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  signal.throwIfAborted();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = downloadFileName(name);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), REVOKE_AFTER_MS);
}
