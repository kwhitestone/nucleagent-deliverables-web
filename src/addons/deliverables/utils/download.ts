import { assertSafePreviewUrl } from "@/addons/deliverables/utils/previewPolicy";

/**
 * Real "save to disk" for a stored deliverable. A cross-origin `<a download>` is ignored
 * by browsers and `window.open` only previews image/video, so the bytes are fetched
 * anonymously (the signed URL is the only credential), wrapped in a same-origin object
 * URL and handed to an anchor with the item's own name.
 * ponytail: whole file in memory as a Blob; fine under the 100 MB catalog cap, stream to disk if that cap grows.
 */
export const REVOKE_AFTER_MS = 40_000; // the browser resolves the blob when the download starts; revoke well after

type Entry = { controller: AbortController; refs: number; done: Promise<void> };
// Request scope (opaque session signal) -> item -> one shared save. A new session never joins an old one.
const entries = new WeakMap<AbortSignal, Map<number, Entry>>();

/** Last path segment only, without characters that are invalid in file names. */
export function downloadFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().replace(/^\.+|\.+$/g, "").trim();
  return cleaned || "download";
}

/**
 * One save per (scope, key) at a time: repeated clicks join the running one. Each caller
 * holds a reference; a caller leaving (its signal aborts) rejects only that caller, and the
 * shared fetch is aborted only when the last caller has left or the scope itself ends.
 */
export function saveAsFile(scope: AbortSignal, key: number, resolveUrl: () => Promise<string>, name: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let items = entries.get(scope);
  if (!items) entries.set(scope, (items = new Map()));
  const scoped = items;
  let entry = scoped.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created: Entry = { controller, refs: 0, done: Promise.resolve() };
    created.done = save(resolveUrl, name, AbortSignal.any([scope, controller.signal]))
      .finally(() => { if (scoped.get(key) === created) scoped.delete(key); });
    scoped.set(key, (entry = created));
  }
  const joined = entry;
  joined.refs += 1;
  return new Promise<void>((resolve, reject) => {
    const leave = () => {
      joined.refs -= 1;
      if (joined.refs === 0) {
        if (scoped.get(key) === joined) scoped.delete(key);
        joined.controller.abort();
      }
      reject(signal.reason);
    };
    signal.addEventListener("abort", leave, { once: true });
    joined.done.then(resolve, reject).finally(() => signal.removeEventListener("abort", leave));
  });
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
