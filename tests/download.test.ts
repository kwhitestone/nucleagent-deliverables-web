import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { installSourceLoader } from "./sourceLoader.ts";

type Download = typeof import("../src/addons/deliverables/utils/download.ts");
let loader: ReturnType<typeof installSourceLoader>;
let downloadFileName: Download["downloadFileName"];
let saveAsFile: Download["saveAsFile"];
let REVOKE_AFTER_MS: number;
before(async () => {
  loader = installSourceLoader();
  ({ downloadFileName, saveAsFile, REVOKE_AFTER_MS } = await import("../src/addons/deliverables/utils/download.ts"));
});
after(() => loader.deregister());

const scope = new AbortController().signal; // one shared request session for the legacy cases
const signedUrl = "https://files.example.test/obj?signature=fixture-only";
type Anchor = { href: string; download: string; rel: string; clicks: number; removed: boolean; click(): void; remove(): void };
let anchors: Anchor[];
let created: string[];
let revoked: string[];
let calls: Array<{ url: string; init?: RequestInit }>;
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] }); // the delayed revoke must never hold the process
  anchors = []; created = []; revoked = []; calls = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => {
      assert.equal(tag, "a");
      const anchor: Anchor = { href: "", download: "", rel: "", clicks: 0, removed: false,
        click() { this.clicks += 1; }, remove() { this.removed = true; } };
      anchors.push(anchor);
      return anchor;
    },
    body: { append: () => undefined },
  } });
  URL.createObjectURL = (blob: Blob) => { const url = `blob:fixture/${created.length}-${blob.size}`; created.push(url); return url; };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(new Uint8Array([1, 2, 3])); };
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  Reflect.deleteProperty(globalThis, "document");
});

test("saves the fetched bytes under the item name and revokes the object URL later, not immediately", async () => {
  await saveAsFile(scope, 1, async () => signedUrl, "报告 v2.md", new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, signedUrl);
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(anchors.length, 1);
  assert.deepEqual([anchors[0].href, anchors[0].download, anchors[0].clicks, anchors[0].removed], [created[0], "报告 v2.md", 1, true]);
  assert.match(created[0], /-3$/);
  assert.deepEqual(revoked, []);
  mock.timers.tick(REVOKE_AFTER_MS - 1);
  assert.deepEqual(revoked, []);
  mock.timers.tick(1);
  assert.deepEqual(revoked, created);
});

test("HTTP errors, unsafe URLs and network failures save nothing", async () => {
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response("<Error/>", { status: 403 }); };
  await assert.rejects(saveAsFile(scope, 2, async () => signedUrl, "a.jpg", new AbortController().signal), /HTTP 403/);
  await assert.rejects(saveAsFile(scope, 3, async () => "javascript:alert(1)", "a.jpg", new AbortController().signal), /unsafe/);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(saveAsFile(scope, 4, async () => signedUrl, "a.jpg", new AbortController().signal), TypeError);
  await assert.rejects(saveAsFile(scope, 5, async () => { throw new Error("download URL refused"); }, "a.jpg", new AbortController().signal), /refused/);
  assert.equal(calls.length, 1);
  assert.deepEqual([anchors.length, created.length], [0, 0]);
});

test("concurrent clicks on the same item fetch and save once; the next click works again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const resolveUrl = async () => { await gate; return signedUrl; };
  const signal = new AbortController().signal;
  const runs = [saveAsFile(scope, 7, resolveUrl, "a.jpg", signal), saveAsFile(scope, 7, resolveUrl, "a.jpg", signal), saveAsFile(scope, 8, async () => signedUrl, "b.jpg", signal)];
  release();
  await Promise.all(runs);
  assert.deepEqual(anchors.map((anchor) => anchor.download).sort(), ["a.jpg", "b.jpg"]);
  await saveAsFile(scope, 7, resolveUrl, "a.jpg", signal);
  assert.equal(anchors.length, 3);
});

test("a retired operation never reaches the save step and releases its blob", async () => {
  const owner = new AbortController();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, blob: async () => { owner.abort(); return new Blob(["x"]); } } as Response;
  };
  await assert.rejects(saveAsFile(scope, 9, async () => signedUrl, "a.jpg", owner.signal), { name: "AbortError" });
  assert.equal(calls[0].init?.signal?.aborted, true); // the sole caller left, so the shared fetch was cancelled
  assert.deepEqual([anchors.length, created.length], [0, 0]);
});

test("file names cannot carry paths or control characters", () => {
  assert.equal(downloadFileName("..\\..//etc/pass<img src=x onerror=alert(1)>.md"), "pass_img src=x onerror=alert(1)_.md");
  assert.equal(downloadFileName("a\u0000b\nc:d*e?f\"g|h.txt"), "a_b_c_d_e_f_g_h.txt");
  assert.equal(downloadFileName("   ...   "), "download");
  assert.equal(downloadFileName("视频 1.mp4"), "视频 1.mp4");
});

test("two callers share one item; the first leaving does not cancel the second", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    await gate;
    init?.signal?.throwIfAborted();
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const first = new AbortController();
  const second = new AbortController();
  const a = saveAsFile(scope, 11, async () => signedUrl, "a.jpg", first.signal);
  const b = saveAsFile(scope, 11, async () => signedUrl, "a.jpg", second.signal);
  await new Promise((resolve) => setImmediate(resolve));
  first.abort();
  release();
  await assert.rejects(a, { name: "AbortError" });
  await b;
  assert.equal(calls.length, 1);
  assert.equal(anchors.length, 1);
});

function gatedFetch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    signals.push(init!.signal!);
    await gate;
    init?.signal?.throwIfAborted();
    return new Response(new Uint8Array([1, 2, 3]));
  };
  return { release, signals };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the shared fetch is aborted only when every caller has left", async () => {
  const { release, signals } = gatedFetch();
  const first = new AbortController();
  const second = new AbortController();
  const a = saveAsFile(scope, 12, async () => signedUrl, "a.jpg", first.signal);
  const b = saveAsFile(scope, 12, async () => signedUrl, "a.jpg", second.signal);
  await tick();
  first.abort();
  assert.equal(signals[0].aborted, false);
  second.abort();
  assert.equal(signals[0].aborted, true);
  release();
  await assert.rejects(a, { name: "AbortError" });
  await assert.rejects(b, { name: "AbortError" });
  assert.deepEqual([calls.length, anchors.length], [1, 0]);
  await saveAsFile(scope, 12, async () => signedUrl, "a.jpg", new AbortController().signal); // fresh entry after the abort
  assert.deepEqual([calls.length, anchors.length], [2, 1]);
});

test("different sessions never share or cancel each other; a session ending aborts only its own save", async () => {
  const { release, signals } = gatedFetch();
  const oldSession = new AbortController();
  const newSession = new AbortController();
  const a = saveAsFile(oldSession.signal, 13, async () => signedUrl, "a.jpg", oldSession.signal);
  const b = saveAsFile(newSession.signal, 13, async () => signedUrl, "a.jpg", new AbortController().signal);
  await tick();
  assert.equal(calls.length, 2);
  oldSession.abort();
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, false]);
  release();
  await assert.rejects(a, { name: "AbortError" });
  await b;
  assert.equal(anchors.length, 1);
});

test("an already-aborted caller is refused without starting a fetch", async () => {
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(saveAsFile(scope, 14, async () => signedUrl, "a.jpg", gone.signal), { name: "AbortError" });
  assert.deepEqual([calls.length, anchors.length], [0, 0]);
});

test("a failed shared save rejects every caller and the next click retries", async () => {
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response("", { status: 500 }); };
  const runs = [1, 2].map(() => saveAsFile(scope, 15, async () => signedUrl, "a.jpg", new AbortController().signal));
  for (const run of runs) await assert.rejects(run, /HTTP 500/);
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(new Uint8Array([9])); };
  await saveAsFile(scope, 15, async () => signedUrl, "a.jpg", new AbortController().signal);
  assert.deepEqual([calls.length, anchors.length], [2, 1]);
});
