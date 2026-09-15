import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { installSourceLoader } from "./sourceLoader.ts";
import { installUploadXhr } from "./uploadXhrHarness.ts";

type Client = typeof import("../src/addons/deliverables/api/client.ts");
type Session = typeof import("../src/addons/deliverables/composables/embeddedSession.ts");
const childWindow = Object.assign(new EventTarget(), {
  performance: globalThis.performance,
  location: { origin: "https://deliverables.example.test", search: "" },
});
const storage = new Map<string, string>();
let client: Client;
let session: Session;
let loader: ReturnType<typeof installSourceLoader>;
let xhr: ReturnType<typeof installUploadXhr>;
let version = 0;
const file = new File(["private fixture"], "private.txt", { type: "text/plain" });
const credential = {
  fileId: "fixture-file", uploadUrl: "https://storage.example.test/upload?signature=fixture-only",
  expiresAt: 0,
};

before(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: childWindow });
  Object.defineProperty(childWindow, "parent", { configurable: true, value: childWindow });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  loader = installSourceLoader();
  client = await import("../src/addons/deliverables/api/client.ts");
  session = await import("../src/addons/deliverables/composables/embeddedSession.ts");
});

beforeEach(() => {
  session.applyShellSession("account-a-fixture", ++version);
  xhr = installUploadXhr();
});
afterEach(() => xhr.restore());
after(() => {
  loader.deregister();
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
});

const outcome = (promise: Promise<string>) => promise.then(
  (value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }),
);
function assertCancelled(result: Awaited<ReturnType<typeof outcome>>) {
  assert.equal(result.value, undefined);
  assert.ok(result.error instanceof DOMException);
  assert.equal(result.error.name, "AbortError");
  assert.ok(!result.error.message.includes("signature"));
}
function assertClean(request: (typeof xhr.requests)[number]) {
  for (const callback of ["onload", "onerror", "ontimeout", "onabort"] as const) {
    assert.equal(request[callback], null);
  }
  assert.equal(request.upload.onprogress, null);
}

for (const nextToken of [null, "account-b-fixture", "account-a-fixture"]) {
  test(`upload XHR is actually aborted on ${nextToken === null ? "logout" : nextToken}`, async () => {
    const pending = outcome(client.uploadBytes(file, credential));
    const request = xhr.requests[0];
    assert.equal(request.sendCalls, 1);
    session.applyShellSession(nextToken, ++version);
    assert.equal(request.abortCalls, 1);
    assertCancelled(await pending);
    assertClean(request);
  });
}

test("caller cancellation aborts XHR once and never exposes its custom reason", async () => {
  const controller = new AbortController();
  const progress: number[] = [];
  const pending = outcome(client.uploadBytes(file, credential, (loaded) => progress.push(loaded), controller.signal));
  const request = xhr.requests[0];
  const lateProgress = request.upload.onprogress;
  const lateLoad = request.onload;
  const lateError = request.onerror;
  controller.abort(new Error(credential.uploadUrl));
  assert.equal(request.abortCalls, 1);
  lateProgress?.({ lengthComputable: true, loaded: 12, total: 12 });
  lateLoad?.();
  lateError?.();
  assertCancelled(await pending);
  assert.deepEqual(progress, []);
  session.applyShellSession(null, ++version);
  assert.equal(request.abortCalls, 1);
  assertClean(request);
});

test("pre-aborted lifetime sends no bytes and constructs no XHR", async () => {
  const controller = new AbortController();
  controller.abort();
  const pending = outcome(client.uploadBytes(file, credential, undefined, controller.signal));
  assert.equal(xhr.requests.length, 0);
  assertCancelled(await pending);
});

test("completed XHR releases session listeners and ignores captured late progress", async () => {
  const signal = session.captureSessionRequest().signal;
  const listenerCount = getEventListeners(signal, "abort").length;
  const progress: number[] = [];
  const pending = client.uploadBytes(file, credential, (loaded) => progress.push(loaded));
  const request = xhr.requests[0];
  const lateProgress = request.upload.onprogress;
  request.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 12 });
  request.onload?.();
  assert.equal(await pending, "fixture-reference");
  assertClean(request);
  assert.equal(getEventListeners(signal, "abort").length, listenerCount);
  lateProgress?.({ lengthComputable: true, loaded: 12, total: 12 });
  assert.deepEqual(progress, [4]);
  session.applyShellSession(null, ++version);
  assert.equal(request.abortCalls, 0);
});

for (const event of ["onerror", "ontimeout", "onabort", "onload"] as const) {
  test(`XHR ${event} rejects once and releases listeners`, async () => {
    const signal = session.captureSessionRequest().signal;
    const listenerCount = getEventListeners(signal, "abort").length;
    const pending = outcome(client.uploadBytes(file, credential));
    const request = xhr.requests[0];
    request.status = 503;
    const callback = request[event];
    assert.equal(typeof callback, "function");
    callback?.();
    assertClean(request);
    const result = await pending;
    if (event === "onabort") assertCancelled(result);
    else assert.ok(result.error instanceof Error);
    callback?.();
    assert.equal(getEventListeners(signal, "abort").length, listenerCount);
    session.applyShellSession(null, ++version);
    assert.equal(request.abortCalls, 0);
  });
}

for (const stage of ["open", "header", "send"] as const) {
  test(`XHR ${stage} setup failure cleans up its lifetime listener`, async () => {
    xhr.restore();
    xhr = installUploadXhr(stage);
    const signal = session.captureSessionRequest().signal;
    const listenerCount = getEventListeners(signal, "abort").length;
    const pending = outcome(client.uploadBytes(file, { ...credential, headers: { "X-Fixture": "test" } }));
    assert.ok((await pending).error instanceof Error);
    assertClean(xhr.requests[0]);
    assert.equal(getEventListeners(signal, "abort").length, listenerCount);
    session.applyShellSession(null, ++version);
    assert.equal(xhr.requests[0].abortCalls, 0);
  });
}

test("unchanged sessions preserve successful direct uploads and fresh sessions get fresh XHRs", async () => {
  const pending = client.uploadBytes(file, credential);
  session.applyShellSession("account-a-fixture", version);
  assert.equal(xhr.requests[0].abortCalls, 0);
  xhr.requests[0].onload?.();
  assert.equal(await pending, "fixture-reference");
  session.applyShellSession("account-b-fixture", ++version);
  const next = client.uploadBytes(file, credential);
  assert.equal(xhr.requests[1].sendCalls, 1);
  xhr.requests[1].onload?.();
  assert.equal(await next, "fixture-reference");
  assert.equal(xhr.requests[1].abortCalls, 0);
});

test("independently replaced credentials cancel XHR on the next progress event", async () => {
  const progress: number[] = [];
  const pending = outcome(client.uploadBytes(file, credential, (loaded) => progress.push(loaded)));
  storage.set("nucleagent_access_token", "replacement-fixture");
  xhr.requests[0].upload.onprogress?.({ lengthComputable: true, loaded: 6, total: 12 });
  assert.equal(xhr.requests[0].abortCalls, 1);
  assertCancelled(await pending);
  assert.deepEqual(progress, []);
});
