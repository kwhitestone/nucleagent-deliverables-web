import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { installSourceLoader } from "./sourceLoader.ts";

type Client = typeof import("../src/addons/deliverables/api/client.ts");
type Session = typeof import("../src/addons/deliverables/composables/embeddedSession.ts");
type Outcome<T> = { value: T; error?: never } | { error: unknown; value?: never };

const ACCESS_TOKEN_KEY = "nucleagent_access_token";
const SHELL_ORIGIN = "https://shell.example.test";
const messages: Array<{ type: string; payload?: unknown }> = [];
const changes: boolean[] = [];
const parent = { postMessage(message: { type: string; payload?: unknown }, origin: string) {
  assert.equal(origin, SHELL_ORIGIN);
  messages.push(message);
} };
const childWindow = Object.assign(new EventTarget(), {
  parent,
  performance: globalThis.performance,
  location: { origin: "https://deliverables.example.test", search: "" },
});
const storage = new Map<string, string>();
const originalFetch = globalThis.fetch;
let loader: ReturnType<typeof installSourceLoader>;
let client: Client;
let session: Session;
let disposeBridge: () => void;
let version = 0;

before(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: childWindow });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  Object.defineProperty(globalThis, "__NUCLEAGENT_DELIVERABLES_CONFIG__", {
    configurable: true, value: { shellUrl: SHELL_ORIGIN },
  });
  loader = installSourceLoader();
  client = await import("../src/addons/deliverables/api/client.ts");
  session = await import("../src/addons/deliverables/composables/embeddedSession.ts");
  childWindow.addEventListener(session.SESSION_CHANGE_EVENT, (event) => {
    changes.push((event as CustomEvent<{ authenticated: boolean }>).detail.authenticated);
  });
});

function receive(type: string, payload?: unknown): void {
  childWindow.dispatchEvent(Object.assign(new Event("message"), {
    source: parent, origin: SHELL_ORIGIN,
    data: {
      protocol: "prism-fusion/remote", version: 1, appId: "deliverables",
      instanceId: "fixture-session-instance", type, payload,
    },
  }));
}

beforeEach(() => {
  session.applyShellSession("account-a-token", ++version);
  disposeBridge = session.installShellBridge();
  receive("host:init");
  messages.length = 0;
  changes.length = 0;
});

afterEach(() => {
  disposeBridge();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});

after(() => {
  loader?.deregister();
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "__NUCLEAGENT_DELIVERABLES_CONFIG__");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

function response(status = 200, data: unknown = { items: [], hasMore: false, nextBeforeId: 0 }): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : status, message: "Unauthorized", data }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function pendingRequest() {
  const gate = deferred<Response>();
  let init!: RequestInit;
  globalThis.fetch = async (_input, requestInit) => {
    init = requestInit!;
    return gate.promise;
  };
  const result = settle(client.listDeliverables());
  return { result, init: () => init, release: gate.resolve };
}

function assertCancelled(outcome: Outcome<unknown>): void {
  assert.ok(outcome.error instanceof DOMException);
  assert.equal(outcome.error.name, "AbortError");
  assert.equal(outcome.value, undefined);
}

for (const sameToken of [false, true]) {
  test(`a delayed 401 cannot reject a newer ${sameToken ? "same-token generation" : "credential"}`, async () => {
    const pending = pendingRequest();
    const nextToken = sameToken ? "account-a-token" : "account-b-token";
    session.applyShellSession(nextToken, ++version);
    pending.release(response(401));

    const outcome = await pending.result;
    assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), nextToken);
    assert.equal(messages.length, 0);
    assert.deepEqual(changes, [true]);
    assertCancelled(outcome);
    assert.equal(pending.init().signal?.aborted, true);
  });
}

test("logout retires an in-flight successful response and later login gets a fresh scope", async () => {
  const pending = pendingRequest();
  session.applyShellSession(null, ++version);
  pending.release(response());
  assertCancelled(await pending.result);
  assert.equal(pending.init().signal?.aborted, true);
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), null);

  session.applyShellSession("account-b-token", ++version);
  const next = pendingRequest();
  next.release(response());
  assert.equal((await next.result).error, undefined);
  assert.equal(next.init().signal?.aborted, false);
});

for (const sameToken of [false, true]) {
  test(`a stale download URL cannot reach a newer ${sameToken ? "same-token generation" : "account"}`, async () => {
    const body = deferred<unknown>();
    const parsing = deferred<void>();
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: () => { parsing.resolve(); return body.promise; },
    } as Response);
    const result = settle(client.getDownloadUrl(7));
    await parsing.promise;
    session.applyShellSession(sameToken ? "account-a-token" : "account-b-token", ++version);
    body.resolve({ code: 0, data: { url: "https://files.example.test/old-account-private" } });
    assertCancelled(await result);
    assert.equal(messages.length, 0);
  });
}

test("an unchanged trusted session does not cancel requests", async () => {
  const pending = pendingRequest();
  assert.deepEqual(session.applyShellSession("account-a-token", version), { accepted: true, changed: false });
  assert.deepEqual(session.applyShellSession("outdated-token", version - 1), { accepted: false, changed: false });
  pending.release(response());
  assert.equal((await pending.result).error, undefined);
  assert.equal(pending.init().signal?.aborted, false);
  assert.equal(changes.length, 0);
});

test("a current expired credential still invalidates its session and notifies the shell once", async () => {
  const pending = pendingRequest();
  pending.release(response(401));
  const result = await pending.result;
  assert.match(String(result.error), /Unauthorized/);
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), null);
  assert.equal(pending.init().signal?.aborted, true);
  assert.deepEqual(changes, [false]);
  assert.deepEqual(messages, [{
    protocol: "prism-fusion/remote", version: 1, appId: "deliverables",
    instanceId: "fixture-session-instance", type: "auth-required",
    payload: { source: "sub", type: "auth-required", reason: "rejected", sessionVersion: version },
  }]);
  assert.deepEqual(session.applyShellSession("account-a-token", version), { accepted: false, changed: false });
});

test("concurrent 401 responses retire their own generation only once", async () => {
  const gates = [deferred<Response>(), deferred<Response>()];
  let index = 0;
  globalThis.fetch = async () => gates[index++].promise;
  const first = settle(client.listDeliverables());
  const second = settle(client.listDeliverables());
  gates[0].resolve(response(401));
  assert.match(String((await first).error), /Unauthorized/);
  gates[1].resolve(response(401));
  assertCancelled(await second);
  assert.equal(messages.length, 1);
  assert.deepEqual(changes, [false]);
});

test("a missing-token request asks for the shell handshake without sending unauthenticated HTTP", async () => {
  session.applyShellSession(null, ++version);
  messages.length = 0;
  changes.length = 0;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return response(401); };

  const first = await settle(client.listDeliverables());
  const second = await settle(client.listDeliverables());
  assert.equal(requests, 0);
  assertCancelled(first);
  assertCancelled(second);
  assert.deepEqual(messages.map((message) => message.payload), [{
    source: "sub", type: "auth-required", reason: "missing", sessionVersion: version,
  }]);
  assert.deepEqual(changes, []);

  session.applyShellSession("account-b-token", ++version);
  globalThis.fetch = async () => response();
  assert.equal((await settle(client.listDeliverables())).error, undefined);
});

test("a same-token account switch followed by logout cannot revive an old response", async () => {
  const pending = pendingRequest();
  session.applyShellSession(null, ++version);
  session.applyShellSession("account-a-token", ++version);
  pending.release(response());
  assertCancelled(await pending.result);
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-a-token");
});

test("an independently replaced stored token is not cleared by an older 401", async () => {
  const pending = pendingRequest();
  localStorage.setItem(ACCESS_TOKEN_KEY, "replacement-token");
  pending.release(response(401));
  const result = await pending.result;
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "replacement-token");
  assertCancelled(result);
  assert.equal(messages.length, 0);
});

test("a stale unauthorized callback cannot clear a synchronized missing-token handshake", () => {
  session.applyShellSession(null, ++version);
  const missing = session.captureSessionRequest();
  session.applyShellSession("account-b-token", ++version);
  session.handleEmbeddedUnauthorized("missing", missing);
  session.handleEmbeddedUnauthorized("rejected", missing);
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-b-token");
  assert.equal(messages.length, 0);
});

test("delayed 401 body parsing cannot reject an account installed after the headers", async () => {
  const body = deferred<unknown>();
  const parsing = deferred<void>();
  globalThis.fetch = async () => ({
    ok: false, status: 401,
    json: () => { parsing.resolve(); return body.promise; },
  } as Response);
  const result = settle(client.listDeliverables());
  await parsing.promise;
  session.applyShellSession("account-b-token", ++version);
  body.resolve({ code: 401, message: "Expired old token" });
  assertCancelled(await result);
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-b-token");
  assert.equal(messages.length, 0);
});

test("stale transport errors are cancelled while current network failures remain observable", async () => {
  const gate = deferred<void>();
  const networkFailure = new TypeError("Fixture network failure");
  globalThis.fetch = async () => { await gate.promise; throw networkFailure; };
  const pending = settle(client.listDeliverables());
  session.applyShellSession("account-b-token", ++version);
  gate.resolve();
  assertCancelled(await pending);
  assert.equal((await settle(client.listDeliverables())).error, networkFailure);
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-b-token");
});

test("logout aborts a transport that honors its session signal", async () => {
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  });
  const pending = settle(client.listDeliverables());
  session.applyShellSession(null, ++version);
  assertCancelled(await pending);
});

test("a reentrant session replacement is never sent a rejected notification for its predecessor", async () => {
  const synchronize = () => { session.applyShellSession("account-b-token", ++version); };
  childWindow.addEventListener(session.SESSION_CHANGE_EVENT, synchronize, { once: true });
  const pending = pendingRequest();
  pending.release(response(401));
  await pending.result;
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-b-token");
  assert.equal(messages.length, 0);
});

test("a missing-token handshake is not deduplicated before the channel can deliver it", async () => {
  disposeBridge();
  session.applyShellSession(null, ++version);
  disposeBridge = session.installShellBridge();
  assertCancelled(await settle(client.listDeliverables()));
  receive("host:init");
  messages.length = 0;
  assertCancelled(await settle(client.listDeliverables()));
  assert.deepEqual(messages.map((message) => message.payload), [{
    source: "sub", type: "auth-required", reason: "missing", sessionVersion: version,
  }]);
});

test("trusted shell messages retain their locale and session validation", () => {
  receive("locale", { source: "shell", type: "locale", locale: "en" });
  receive("locale", { source: "sub", type: "locale", locale: "fr" });
  receive("auth");
  receive("auth", "invalid");
  receive("auth", { source: "other", type: "auth", token: "untrusted", sessionVersion: version + 1 });
  receive("auth", { source: "shell", type: "auth", token: "untrusted", sessionVersion: 0.5 });
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-a-token");
  receive("auth", { source: "shell", type: "auth", token: "trusted", sessionVersion: ++version });
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "trusted");
  receive("auth", { source: "shell", type: "auth", sessionVersion: ++version });
  assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), null);
});

test("standalone requests reject expired credentials without requiring a shell channel", async () => {
  Object.defineProperty(childWindow, "parent", { configurable: true, value: childWindow });
  try {
    session.installShellBridge()();
    globalThis.fetch = async () => response(401);
    const result = await settle(client.listDeliverables());
    assert.match(String(result.error), /Unauthorized/);
    assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), null);
    assert.equal(messages.length, 0);
  } finally {
    Object.defineProperty(childWindow, "parent", { configurable: true, value: parent });
  }
});

test("valid endpoint wrappers retain authorization, query, payload and envelope contracts", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let data: unknown;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return response(200, data);
  };
  data = { items: [], hasMore: false, nextBeforeId: 0 };
  await client.listDeliverables({
    query: " report ", conversationId: 42, kind: " document ", status: " active ",
    dateFrom: "2026-09-01", dateTo: "2026-09-15", beforeId: 10, limit: 5,
  });
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url, SHELL_ORIGIN).searchParams), {
    query: "report", conversationId: "42", kind: "document", status: "active",
    dateFrom: "2026-09-01", dateTo: "2026-09-15", beforeId: "10", limit: "5",
  });
  const item = { id: 7, conversationId: 42, userId: 1, name: "report.txt" };
  data = { deliverable: item, upload: { fileId: "fixture-file" } };
  await client.createUpload(42, { name: "report.txt", type: "text/plain", size: 10 });
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), {
    conversationId: 42, name: "report.txt", mimeType: "text/plain", size: 10,
  });
  data = item;
  assert.deepEqual(await client.completeUpload(7, "ref-7", ""), item);
  assert.deepEqual(await client.createAppLink({ conversationId: 42, name: "report", appUrl: "https://app.example.test" }), item);
  assert.deepEqual(await client.importDeliverable({ conversationId: 42, url: "https://files.example.test/report" }), item);
  data = [item];
  assert.deepEqual(await client.cloneDeliverable(item as Parameters<Client["cloneDeliverable"]>[0], 43), item);
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body as string), {
    sourceConversationId: 42, targetConversationId: 43, deliverableIds: [7],
  });
  data = [];
  await assert.rejects(client.cloneDeliverable(item as Parameters<Client["cloneDeliverable"]>[0], 43));
  data = undefined;
  assert.equal(await client.deleteDeliverable(7), undefined);
  assert.equal(calls.at(-1)!.init.method, "DELETE");
  data = { url: "https://files.example.test/report" };
  assert.equal(await client.getDownloadUrl(7), "https://files.example.test/report");
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer account-a-token");
    assert.equal(call.init.signal?.aborted, false);
    if (call.init.body) assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
  }
});

test("malformed and forbidden current responses remain failures without expiring the session", async () => {
  for (const [fixture, expected] of [
    [new Response("not JSON", { status: 200 }), /invalid response/],
    [new Response("not JSON", { status: 403 }), /Request failed \(403\)/],
    [new Response(JSON.stringify({ code: 403, message: "Forbidden" }), { status: 403 }), /Forbidden/],
    [new Response(JSON.stringify({ code: 500, message: "Envelope failure" }), { status: 200 }), /Envelope failure/],
  ] as const) {
    globalThis.fetch = async () => fixture;
    await assert.rejects(client.listDeliverables(), expected);
    assert.equal(localStorage.getItem(ACCESS_TOKEN_KEY), "account-a-token");
  }
  assert.equal(messages.length, 0);
});

test("existing binary upload and digest helpers retain successful and failed response handling", async () => {
  const file = new File(["report"], "report.txt", { type: "text/plain" });
  let xhr: FakeXhr;
  class FakeXhr {
    status = 200;
    responseText = '{"refId":"ref-7"}';
    headers = new Headers();
    body?: XMLHttpRequestBodyInit;
    upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }) => undefined };
    onload = () => undefined;
    onerror = () => undefined;
    ontimeout = () => undefined;
    constructor() { xhr = this; }
    open(method: string, url: string) {
      assert.ok(["PUT", "POST"].includes(method));
      assert.equal(url, "https://storage.example.test/upload");
    }
    setRequestHeader(key: string, value: string) { this.headers.set(key, value); }
    send(body: XMLHttpRequestBodyInit) { this.body = body; }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXhr });
  const credential = { fileId: "fixture", method: "PUT", uploadUrl: "https://storage.example.test/upload", expiresAt: 0 };
  const progress: number[] = [];
  const binary = client.uploadBytes(file, { ...credential, headers: { "X-Fixture": "test" } },
    (loaded, total) => { progress.push(loaded, total); });
  assert.equal(xhr!.body, file);
  assert.equal(xhr!.headers.get("X-Fixture"), "test");
  xhr!.upload.onprogress({ lengthComputable: true, loaded: 6, total: 6 });
  xhr!.onload();
  assert.equal(await binary, "ref-7");
  assert.deepEqual(progress, [6, 6]);

  const form = client.uploadBytes(file, { ...credential, method: "POST", formFields: { key: "fixture" } });
  assert.ok(xhr!.body instanceof FormData);
  assert.equal(xhr!.body.get("key"), "fixture");
  assert.ok(xhr!.body.get("file") instanceof File);
  xhr!.responseText = '{"dentry_id":"entry-7"}';
  xhr!.onload();
  assert.equal(await form, "entry-7");
  for (const result of ["", "not JSON"]) {
    const upload = client.uploadBytes(file, { ...credential, method: "", fileField: "document" });
    xhr!.responseText = result;
    xhr!.onload();
    assert.equal(await upload, "");
  }
  for (const failure of ["onerror", "ontimeout", "onload"] as const) {
    const upload = settle(client.uploadBytes(file, credential));
    xhr!.status = 500;
    xhr![failure]();
    assert.ok((await upload).error instanceof Error);
  }
  assert.equal(await client.sha256Hex(file), createHash("sha256").update("report").digest("hex"));
});
