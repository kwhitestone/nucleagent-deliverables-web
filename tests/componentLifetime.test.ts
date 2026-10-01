import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test, type TestContext } from "node:test";
import {
  deferred, DocumentHost, fixtures, flush, installComponentLoader, mountComponent,
} from "./componentHarness.ts";
import { installUploadXhr } from "./uploadXhrHarness.ts";

type Session = typeof import("../src/addons/deliverables/composables/embeddedSession.ts");
const childWindow = Object.assign(new EventTarget(), {
  location: { origin: "https://deliverables.example.test", search: "" },
  performance: globalThis.performance,
  setTimeout, clearTimeout, setInterval, clearInterval,
  open: (...args: unknown[]) => { opened.push(args); },
  prompt: () => "42",
  confirm: () => true,
});
const documentFixture = Object.assign(new EventTarget(), {
  visibilityState: "visible", documentElement: { lang: "" }, title: "",
  createElement: () => new DocumentHost(),
});
const storage = new Map<string, string>();
const originalFetch = globalThis.fetch;
const opened: unknown[][] = [];
let session: Session;
let version = 0;
let removeLoader: () => void;
let PreviewDialog: any;
let UploadDialog: any;
let DeliverablePanel: any;
const mounts: Array<ReturnType<typeof mountComponent>> = [];
const item = {
  id: 7, conversationId: 12, userId: 1, name: "private.txt", source: "upload",
  mimeType: "text/plain", size: 7, status: "active", createdAt: "", updatedAt: "",
};
const signedUrl = "https://files.example.test/private?signature=fixture-only";

before(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: childWindow });
  Object.defineProperty(childWindow, "parent", { configurable: true, value: childWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentFixture });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  removeLoader = installComponentLoader();
  session = await import("../src/addons/deliverables/composables/embeddedSession.ts");
  PreviewDialog = (await import("../src/addons/deliverables/components/PreviewDialog.vue")).default;
  UploadDialog = (await import("../src/addons/deliverables/components/UploadDialog.vue")).default;
  DeliverablePanel = (await import("../src/addons/deliverables/components/DeliverablePanel.vue")).default;
});

beforeEach(() => {
  session.applyShellSession("account-a-fixture", ++version);
  opened.length = 0;
  fixtures.api = {
    listDeliverables: async () => ({ items: [item], hasMore: false, nextBeforeId: 0 }),
    getDownloadUrl: async () => signedUrl,
    cloneDeliverable: async () => ({ ...item, id: 8 }),
    deleteDeliverable: async () => undefined,
    createUpload: async () => ({ deliverable: item, upload: { uploadUrl: signedUrl } }),
    uploadBytes: async () => "fixture-reference",
    sha256Hex: async () => "fixture-digest",
    completeUpload: async () => item,
    createAppLink: async () => ({ ...item, source: "app-link" }),
    importDeliverable: async () => ({ ...item, source: "import" }),
  };
  fixtures.sanitize = (html) => html;
  fixtures.parseMarkdown = async (source) => source;
  fixtures.renderDocx = async (_buffer, host) => { host.innerHTML = "<p>Document fixture</p>"; };
  globalThis.fetch = async () => new Response("private document");
});

afterEach(() => {
  for (const mounted of mounts.splice(0)) mounted.unmount();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "Worker");
});
after(() => {
  removeLoader();
  for (const key of ["window", "document", "localStorage"]) Reflect.deleteProperty(globalThis, key);
});

function mount(component: any, props: Record<string, unknown>) {
  const mounted = mountComponent(component, props);
  mounts.push(mounted);
  return mounted;
}

async function preview(overrides = {}) {
  const closed: boolean[] = [];
  const mounted = mount(PreviewDialog, {
    open: false, deliverable: { ...item, ...overrides }, onClose: () => { closed.push(true); },
  });
  mounted.props.open = true;
  await flush();
  return { ...mounted, closed };
}

async function upload(mode = "file") {
  const saved: unknown[] = [];
  const closed: boolean[] = [];
  const mounted = mount(UploadDialog, {
    open: false, mode, onSaved: (value: unknown) => { saved.push(value); }, onClose: () => { closed.push(true); },
  });
  mounted.props.open = true;
  await flush();
  mounted.state.conversationIdInput = "12";
  mounted.state.selectedFile = new File(["private"], "private.txt", { type: "text/plain" });
  mounted.state.appName = "Private app";
  mounted.state.appUrl = "https://app.example.test/private";
  mounted.state.importUrl = signedUrl;
  return { ...mounted, saved, closed };
}

for (const token of [null, "account-b-fixture", "account-a-fixture"]) {
  test(`session retirement clears an already loaded preview (${token === null ? "logout" : token})`, async () => {
    const mounted = await preview();
    assert.equal(mounted.state.text, "private document");
    session.applyShellSession(token, ++version);
    assert.equal(mounted.state.url, "");
    assert.equal(mounted.state.text, "");
    assert.equal(mounted.state.markdown, "");
    assert.deepEqual(mounted.state.sheetRows, []);
    assert.equal(mounted.state.error, "");
    mounted.state.openExternal();
    assert.equal(opened.length, 0);
    assert.equal(mounted.closed.length, 1);
  });
}

test("retiring a preview aborts direct fetch and ignores its late body", async () => {
  const body = deferred<Blob>();
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return { ok: true, headers: new Headers(), blob: () => body.promise } as Response;
  };
  const mounted = await preview();
  session.applyShellSession(null, ++version);
  body.resolve(new Blob(["old content"]));
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(mounted.state.text, "");
  assert.equal(mounted.state.url, "");
  assert.equal(mounted.state.error, "");
});

test("a late preview result cannot overwrite another preview or end its loading state", async () => {
  const oldResult = deferred<string>();
  const newResult = deferred<string>();
  fixtures.api.getDownloadUrl = (id) => id === 7 ? oldResult.promise : newResult.promise;
  const mounted = await preview({ mimeType: "image/png", name: "private.png" });
  mounted.props.deliverable = { ...item, id: 8, mimeType: "image/png", name: "next.png" };
  await flush();
  oldResult.resolve(signedUrl);
  await flush();
  assert.equal(mounted.state.url, "");
  assert.equal(mounted.state.loading, true);
  newResult.resolve("https://files.example.test/current");
  await flush();
  assert.equal(mounted.state.url, "https://files.example.test/current");
  assert.equal(mounted.state.loading, false);
});

test("retired preview errors are silent and current errors never expose signed URLs", async () => {
  const result = deferred<string>();
  fixtures.api.getDownloadUrl = () => result.promise;
  const mounted = await preview();
  session.applyShellSession("account-b-fixture", ++version);
  result.reject(new Error(`Failed: ${signedUrl}`));
  await flush();
  assert.equal(mounted.state.error, "");
  const current = await preview();
  assert.equal(current.state.error, "previewFailed");
  assert.ok(!current.state.error.includes("signature"));
});

test("late DOCX rendering cannot write back into a cleared live host", async () => {
  const render = deferred<void>();
  const host = new DocumentHost();
  let options: any;
  fixtures.renderDocx = async (_buffer, target, _styles, config) => {
    options = config;
    await render.promise;
    target.innerHTML = "<p>Old private document</p>";
  };
  const mounted = mount(PreviewDialog, { open: false, deliverable: { ...item, name: "private.docx", mimeType: "" } });
  mounted.state.docxHost = host;
  mounted.props.open = true;
  await flush();
  assert.equal(options.renderAltChunks, false);
  session.applyShellSession(null, ++version);
  render.resolve();
  await flush();
  assert.equal(host.innerHTML, "");
  assert.equal(mounted.state.url, "");
});

test("workbook worker and its timeout are retired with the preview", async (t: TestContext) => {
  let worker: any;
  class WorkbookWorker {
    terminated = false;
    onmessage?: (event: unknown) => void;
    onerror?: () => void;
    constructor() { worker = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkbookWorker });
  const mounted = await preview({ name: "private.xlsx", mimeType: "" });
  t.after(() => worker?.onerror?.());
  assert.ok(worker);
  session.applyShellSession(null, ++version);
  const terminatedAtRetirement = worker.terminated;
  worker.onmessage?.({ data: { rows: [["old private cell"]] } });
  await flush();
  assert.equal(terminatedAtRetirement, true);
  assert.deepEqual(mounted.state.sheetRows, []);
  assert.equal(mounted.state.error, "");
});

for (const boundary of ["createUpload", "uploadBytes", "sha256Hex", "completeUpload"]) {
  test(`upload retirement at ${boundary} stops remaining phases and saved events`, async () => {
    const gate = deferred<any>();
    const calls: string[] = [];
    let progress: ((loaded: number, total: number) => void) | undefined;
    const values: Record<string, unknown> = {
      createUpload: { deliverable: item, upload: { uploadUrl: signedUrl } },
      uploadBytes: "fixture-reference", sha256Hex: "fixture-digest", completeUpload: item,
    };
    for (const name of Object.keys(values)) {
      fixtures.api[name] = (...args) => {
        calls.push(name);
        if (name === "uploadBytes") progress = args[2];
        return name === boundary ? gate.promise : Promise.resolve(values[name]);
      };
    }
    const mounted = await upload();
    const pending = mounted.state.submitFile();
    await flush();
    assert.equal(calls.at(-1), boundary);
    session.applyShellSession("account-b-fixture", ++version);
    const callsAtRetirement = [...calls];
    progress?.(10, 10);
    gate.resolve(values[boundary]);
    await pending;
    assert.deepEqual(calls, callsAtRetirement);
    assert.deepEqual(mounted.saved, []);
    assert.equal(mounted.state.progress, 0);
    assert.equal(mounted.state.busy, false);
    assert.equal(mounted.state.selectedFile, null);
    assert.equal(mounted.state.importUrl, "");
    assert.equal(mounted.state.error, "");
  });
}

for (const action of ["submitLink", "submitImport"]) {
  test(`${action} ignores retired completion and input state`, async () => {
    const result = deferred<any>();
    fixtures.api[action === "submitLink" ? "createAppLink" : "importDeliverable"] = () => result.promise;
    const mounted = await upload(action === "submitLink" ? "app" : "import");
    const pending = mounted.state[action]();
    session.applyShellSession(null, ++version);
    result.resolve(item);
    await pending;
    assert.deepEqual(mounted.saved, []);
    assert.equal(mounted.state.appUrl, "");
    assert.equal(mounted.state.importUrl, "");
    assert.equal(mounted.state.error, "");
  });
}

test("closing and reopening upload ignores the old error and busy finalizer", async () => {
  const oldResult = deferred<any>();
  const currentResult = deferred<any>();
  fixtures.api.createUpload = () => oldResult.promise;
  const mounted = await upload();
  const previous = mounted.state.submitFile();
  mounted.props.open = false;
  await flush();
  mounted.props.open = true;
  await flush();
  mounted.state.conversationIdInput = "12";
  mounted.state.selectedFile = new File(["new"], "new.txt");
  fixtures.api.createUpload = () => currentResult.promise;
  const current = mounted.state.submitFile();
  oldResult.reject(new Error(`Old error ${signedUrl}`));
  await previous;
  assert.equal(mounted.state.busy, true);
  assert.equal(mounted.state.error, "");
  currentResult.reject(new Error(`Current error ${signedUrl}`));
  await current;
  assert.equal(mounted.state.busy, false);
  assert.equal(mounted.state.error, "uploadFailed");
});

test("panel session change clears private dialogs, filters, rows and notices before reload", async () => {
  const mounted = mount(DeliverablePanel, {});
  await flush();
  mounted.state.showPreview(item);
  mounted.state.uploadMode = "file";
  mounted.state.query = "private query";
  mounted.state.conversationId = "12";
  mounted.state.kind = "document";
  mounted.state.dateFrom = "2026-09-01";
  mounted.state.notice = "Private action";
  fixtures.api.listDeliverables = () => new Promise(() => {});
  session.applyShellSession("account-b-fixture", ++version);
  assert.equal(mounted.state.previewItem, null);
  assert.equal(mounted.state.uploadMode, null);
  assert.deepEqual(mounted.state.items, []);
  assert.equal(mounted.state.query, "");
  assert.equal(mounted.state.conversationId, "");
  assert.equal(mounted.state.kind, "");
  assert.equal(mounted.state.dateFrom, "");
  assert.equal(mounted.state.notice, "");
});

for (const action of ["download", "clone", "remove"]) {
  for (const failure of [false, true]) {
    test(`panel ${action} ignores retired ${failure ? "errors" : "success"}`, async () => {
      const result = deferred<any>();
      const mounted = mount(DeliverablePanel, {});
      await flush();
      fixtures.api[{ download: "getDownloadUrl", clone: "cloneDeliverable", remove: "deleteDeliverable" }[action]!] = () => result.promise;
      const pending = mounted.state[action](item);
      session.applyShellSession("account-b-fixture", ++version);
      await flush();
      const rows = [...mounted.state.items];
      if (failure) result.reject(new Error(`Old error ${signedUrl}`));
      else result.resolve(action === "download" ? signedUrl : { ...item, id: 8 });
      await pending;
      assert.deepEqual(mounted.state.items, rows);
      assert.equal(mounted.state.notice, "");
      assert.equal(mounted.state.error, "");
      assert.equal(opened.length, 0);
    });
  }
}

test("unmount prevents a delayed upload from starting byte transfer", async () => {
  const credential = deferred<any>();
  let transfers = 0;
  fixtures.api.createUpload = () => credential.promise;
  fixtures.api.uploadBytes = async () => { transfers++; return "fixture-reference"; };
  const mounted = await upload();
  const pending = mounted.state.submitFile();
  mounted.unmount();
  credential.resolve({ deliverable: item, upload: { uploadUrl: signedUrl } });
  await pending;
  assert.equal(transfers, 0);
  assert.deepEqual(mounted.saved, []);
});

test("current file upload completes once with captured inputs and clears the form", async () => {
  const credential = deferred<any>();
  const calls: unknown[][] = [];
  fixtures.api.createUpload = (...args) => { calls.push(["presign", ...args]); return credential.promise; };
  fixtures.api.uploadBytes = async (file, upload, progress) => {
    calls.push(["bytes", file, upload]);
    progress(1, 2);
    assert.equal(mounted.state.progress, 50);
    return "current-reference";
  };
  fixtures.api.sha256Hex = async (file) => { calls.push(["hash", file]); return "current-digest"; };
  fixtures.api.completeUpload = async (...args) => { calls.push(["complete", ...args]); return item; };
  const mounted = await upload();
  const selected = mounted.state.selectedFile;
  const input = { value: "selected-file" };
  mounted.state.fileInput = input;
  const pending = mounted.state.submitFile();
  await mounted.state.submitFile();
  assert.equal(calls.length, 1);
  mounted.state.conversationIdInput = "99";
  mounted.state.selectedFile = new File(["replacement"], "replacement.txt");
  credential.resolve({ deliverable: item, upload: { uploadUrl: signedUrl } });
  await pending;
  assert.deepEqual(calls[0], ["presign", 12, selected]);
  assert.equal(calls[1][1], selected);
  assert.deepEqual(calls[2], ["hash", selected]);
  assert.deepEqual(calls[3], ["complete", item.id, "current-reference", "current-digest"]);
  assert.deepEqual(mounted.saved, [item]);
  assert.equal(mounted.closed.length, 1);
  assert.equal(mounted.state.busy, false);
  assert.equal(mounted.state.active, false);
  assert.equal(mounted.state.selectedFile, null);
  assert.equal(input.value, "");
});

for (const [mode, action, api, source, error] of [
  ["app", "submitLink", "createAppLink", "app-link", "addLinkFailed"],
  ["import", "submitImport", "importDeliverable", "import", "importFailed"],
]) {
  test(`current ${mode} saves once and clears private input`, async () => {
    const mounted = await upload(mode);
    await mounted.state[action]();
    assert.deepEqual(mounted.saved, [{ ...item, source }]);
    assert.equal(mounted.closed.length, 1);
    assert.equal(mounted.state.appUrl, "");
    assert.equal(mounted.state.importUrl, "");
    assert.equal(mounted.state.busy, false);
  });

  test(`current ${mode} failure hides raw URL and permits retry`, async () => {
    const mounted = await upload(mode);
    fixtures.api[api] = async () => { throw new Error(`Rejected: ${signedUrl}`); };
    await mounted.state[action]();
    assert.equal(mounted.state.error, error);
    assert.equal(mounted.state.busy, false);
    assert.equal(mounted.state.active, true);
    fixtures.api[api] = async () => ({ ...item, source });
    await mounted.state[action]();
    assert.equal(mounted.saved.length, 1);
    assert.equal(mounted.state.error, "");
  });
}

test("session change reentered by a saved listener cannot close a new dialog", async () => {
  const mounted = await upload("app");
  mounted.props.onSaved = () => { session.applyShellSession("account-b-fixture", ++version); };
  await flush();
  await mounted.state.submitLink();
  assert.equal(mounted.closed.length, 1, "session retirement closes once, stale save must not close again");
  assert.equal(mounted.state.error, "");
});

test("changing upload context retires the pending operation", async () => {
  const result = deferred<any>();
  fixtures.api.createAppLink = () => result.promise;
  const mounted = await upload("app");
  const pending = mounted.state.submitLink();
  mounted.props.conversationId = 42;
  await flush();
  result.resolve(item);
  await pending;
  assert.equal(mounted.state.conversationIdInput, "42");
  assert.equal(mounted.state.busy, false);
  assert.equal(mounted.saved.length, 0);
  assert.equal(mounted.closed.length, 0);
});

test("current markdown preview sanitizes and retiring asynchronous parsing clears it", async () => {
  fixtures.parseMarkdown = async () => "<p>Current document</p><script>fixture</script>";
  fixtures.sanitize = () => "<p>Current document</p>";
  const current = await preview({ mimeType: "text/markdown", name: "private.md" });
  assert.equal(current.state.markdown, "<p>Current document</p>");
  const parsed = deferred<string>();
  fixtures.parseMarkdown = () => parsed.promise;
  const retired = await preview({ mimeType: "text/markdown", name: "retired.md" });
  session.applyShellSession(null, ++version);
  parsed.resolve("<p>Old private document</p>");
  await flush();
  assert.equal(retired.state.markdown, "");
  assert.equal(current.state.markdown, "");
  assert.equal(retired.state.error, "");
});

test("current DOCX commits sanitized staged content only while its host is current", async () => {
  const host = new DocumentHost();
  fixtures.sanitize = () => "<p>Sanitized current document</p>";
  const mounted = mount(PreviewDialog, { open: false, deliverable: { ...item, name: "private.docx", mimeType: "" } });
  mounted.state.docxHost = host;
  mounted.props.open = true;
  await flush();
  assert.equal(host.innerHTML, "<p>Sanitized current document</p>");
  assert.equal(mounted.state.loading, false);
  assert.equal(mounted.state.error, "");
  mounted.unmount();
  assert.equal(host.innerHTML, "");
  assert.equal(mounted.state.url, "");
});

for (const failure of [false, true]) {
  test(`current workbook ${failure ? "error is generic" : "renders rows"} and terminates its worker`, async () => {
    let worker: any;
    class WorkbookWorker {
      terminated = false;
      onmessage?: (event: unknown) => void;
      onerror?: () => void;
      constructor() { worker = this; }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkbookWorker });
    const mounted = await preview({ name: "current.xlsx", mimeType: "" });
    if (failure) worker.onerror();
    else worker.onmessage({ data: { rows: [["Current cell"]] } });
    await flush();
    assert.equal(worker.terminated, true);
    assert.equal(worker.onmessage, null);
    assert.equal(mounted.state.loading, false);
    assert.equal(mounted.state.error, failure ? "previewFailed" : "");
    assert.deepEqual(mounted.state.sheetRows, failure ? [] : [["Current cell"]]);
  });
}

test("app-link preview opens only its validated current URL", async () => {
  fixtures.api.getDownloadUrl = async () => { throw new Error("app links must not request downloads"); };
  const mounted = await preview({ source: "app-link", appUrl: "https://app.example.test/" });
  mounted.state.openExternal();
  assert.deepEqual(opened, [["https://app.example.test/", "_blank", "noopener,noreferrer"]]);
  mounted.state.close();
  mounted.state.openExternal();
  assert.equal(opened.length, 1);
  assert.equal(mounted.state.active, false);
  assert.equal(mounted.state.url, "");
  const unsafe = await preview({ source: "app-link", appUrl: "javascript:fixture()" });
  unsafe.state.openExternal();
  assert.equal(opened.length, 1);
  assert.equal(unsafe.state.error, "previewFailed");
});

test("late direct preview body rejection after unmount is silent and aborted", async () => {
  const body = deferred<Blob>();
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return { ok: true, headers: new Headers(), blob: () => body.promise } as Response;
  };
  const mounted = await preview();
  mounted.unmount();
  body.reject(new Error(`Read failed: ${signedUrl}`));
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(mounted.state.error, "");
  assert.equal(mounted.state.url, "");
  assert.equal(mounted.state.loading, false);
});

test("current panel actions preserve download, clone and delete behavior", async () => {
  const mounted = mount(DeliverablePanel, {});
  await flush();
  await mounted.state.download(item);
  assert.deepEqual(opened, [[signedUrl, "_blank", "noopener,noreferrer"]]);
  await mounted.state.clone(item);
  assert.deepEqual(mounted.state.items.map((value: any) => value.id), [8, 7]);
  assert.equal(mounted.state.notice, "copied");
  await mounted.state.remove(item);
  assert.deepEqual(mounted.state.items.map((value: any) => value.id), [8]);
  assert.equal(mounted.state.notice, "deleted");
});

for (const [action, api, error] of [
  ["download", "getDownloadUrl", "downloadFailed"],
  ["clone", "cloneDeliverable", "cloneFailed"],
  ["remove", "deleteDeliverable", "deleteFailed"],
]) {
  test(`current panel ${action} errors do not disclose signed URLs`, async () => {
    const mounted = mount(DeliverablePanel, {});
    await flush();
    fixtures.api[api] = async () => { throw new Error(`Failed: ${signedUrl}`); };
    await mounted.state[action](item);
    assert.equal(mounted.state.error, error);
    assert.deepEqual(mounted.state.items, [item]);
  });
}

test("panel list pagination and request ordering remain intact", async () => {
  const mounted = mount(DeliverablePanel, { conversationId: 12 });
  await flush();
  fixtures.api.listDeliverables = async (params) => {
    assert.equal(params.conversationId, 12);
    assert.equal(params.beforeId, 7);
    return { items: [{ ...item, id: 6 }], nextBeforeId: 6, hasMore: true };
  };
  mounted.state.nextBeforeId = 7;
  await mounted.state.load(true);
  assert.deepEqual(mounted.state.items.map((value: any) => value.id), [7, 6]);
  const old = deferred<any>();
  fixtures.api.listDeliverables = () => old.promise;
  const previous = mounted.state.load();
  fixtures.api.listDeliverables = async () => ({ items: [{ ...item, id: 9 }], nextBeforeId: 0, hasMore: false });
  await mounted.state.load();
  old.reject(new Error(`Old list: ${signedUrl}`));
  await previous;
  assert.deepEqual(mounted.state.items.map((value: any) => value.id), [9]);
  assert.equal(mounted.state.error, "");
  assert.equal(mounted.state.loading, false);
  session.applyShellSession("account-b-fixture", ++version);
  assert.equal(mounted.state.conversationId, "12");
});

test("panel confirm and prompt cannot start writes after reentrant session changes", async (t) => {
  let writes = 0;
  fixtures.api.cloneDeliverable = async () => { writes++; return item; };
  fixtures.api.deleteDeliverable = async () => { writes++; };
  const mounted = mount(DeliverablePanel, {});
  await flush();
  t.mock.method(childWindow, "prompt", () => { session.applyShellSession("account-b-fixture", ++version); return "42"; });
  await mounted.state.clone(item);
  t.mock.method(childWindow, "confirm", () => { session.applyShellSession(null, ++version); return true; });
  await mounted.state.remove(item);
  assert.equal(writes, 0);
  assert.equal(mounted.state.error, "");
});

test("session lifetime validates active owners and invalidates on replacement and disposal", async () => {
  const { useSessionLifetime, isCancelled } = await import("../src/addons/deliverables/composables/useSessionLifetime.ts");
  let resets = 0;
  const mounted = mount({ setup: () => useSessionLifetime(() => { resets++; }) }, {});
  const first = mounted.state.capture();
  mounted.state.assertCurrent(first);
  assert.equal(mounted.state.isCurrent(first), true);
  mounted.state.invalidate();
  assert.equal(first.signal.aborted, true);
  assert.throws(() => mounted.state.assertCurrent(first), { name: "AbortError" });
  const second = mounted.state.capture();
  session.applyShellSession("account-b-fixture", ++version);
  assert.equal(second.signal.aborted, true);
  assert.equal(resets, 1);
  const last = mounted.state.capture();
  mounted.unmount();
  assert.equal(mounted.state.isCurrent(last), false);
  assert.equal(last.signal.aborted, true);
  session.applyShellSession(null, ++version);
  assert.equal(resets, 1, "unmounted component must remove its session listener");
  assert.equal(isCancelled(new DOMException("retired", "AbortError")), true);
  assert.equal(isCancelled(new Error("failure")), false);
});

test("panel filters, notices and refresh timers retire with their component", async (t) => {
  let reloads = 0;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  t.mock.method(childWindow, "setTimeout", (callback: () => void) => { timers.set(++timerId, callback); return timerId; });
  t.mock.method(childWindow, "clearTimeout", (id: number) => { timers.delete(id); });
  t.mock.method(childWindow, "setInterval", (callback: () => void) => { timers.set(++timerId, callback); return timerId; });
  t.mock.method(childWindow, "clearInterval", (id: number) => { timers.delete(id); });
  fixtures.api.listDeliverables = async () => { reloads++; return { items: [item], hasMore: false, nextBeforeId: 0 }; };
  const mounted = mount(DeliverablePanel, { embedded: true });
  await flush();
  mounted.state.query = "current";
  assert.equal(mounted.state.hasFilters, true);
  mounted.state.scheduleLoad();
  mounted.state.scheduleLoad();
  assert.equal(timers.size, 2, "one pending search plus one refresh interval");
  mounted.state.clearFilters();
  await flush();
  assert.equal(mounted.state.hasFilters, false);
  mounted.state.handleSaved({ ...item, id: 8 });
  assert.equal(mounted.state.notice, "uploaded");
  mounted.state.handleSaved({ ...item, id: 9, source: "app-link" });
  assert.equal(mounted.state.notice, "linkCreated");
  mounted.state.handleSaved({ ...item, id: 10, source: "import" });
  assert.equal(mounted.state.notice, "imported");
  for (const callback of [...timers.values()]) callback();
  await flush();
  assert.equal(mounted.state.notice, "");
  assert.ok(reloads >= 3);
  mounted.state.handleSaved(item);
  mounted.state.scheduleLoad();
  session.applyShellSession("account-b-fixture", ++version);
  await flush();
  assert.equal(timers.size, 1, "retirement clears search and notice timers");
  assert.equal(mounted.state.notice, "");
  mounted.unmount();
  assert.equal(timers.size, 0);
});

test("panel display helpers and upload validation remain usable", async () => {
  const panel = mount(DeliverablePanel, {});
  assert.equal(panel.state.formatSize(1024), "1.0 KB");
  assert.equal(panel.state.formatSize(Number.NaN), "0 B");
  assert.equal(panel.state.formatDate("invalid"), "");
  assert.ok(panel.state.formatDate("2026-09-15T00:00:00Z"));
  for (const [source, label] of [["generated", "agentSource"], ["app-link", "appSource"], ["import", "importSource"], ["upload", "uploadSource"]]) {
    assert.equal(panel.state.sourceLabel(source), label);
  }
  const mounted = await upload();
  assert.equal(mounted.state.title, "uploadTitle");
  let clicks = 0;
  mounted.state.fileInput = { click: () => { clicks++; }, value: "" };
  mounted.state.chooseFile();
  assert.equal(clicks, 1);
  mounted.state.selectFile({ target: { files: [] } });
  await mounted.state.submitFile();
  assert.ok(mounted.state.error);
  mounted.state.conversationIdInput = "0";
  await mounted.state.submitLink();
  assert.equal(mounted.state.error, "invalidConversation");
  await mounted.state.submitImport();
  assert.equal(mounted.state.error, "invalidConversation");
  mounted.state.conversationIdInput = "12";
  mounted.state.appName = "";
  await mounted.state.submitLink();
  assert.equal(mounted.state.error, "appNameRequired");
  mounted.state.appName = "Current";
  mounted.state.appUrl = "javascript:fixture()";
  await mounted.state.submitLink();
  assert.equal(mounted.state.error, "invalidHttpUrl");
  mounted.state.importUrl = "javascript:fixture()";
  await mounted.state.submitImport();
  assert.equal(mounted.state.error, "invalidHttpUrl");
  mounted.state.close();
  assert.equal(mounted.closed.length, 1);
  assert.equal(mounted.state.error, "");
});

test("lifetime rejects an independently replaced stored credential", async () => {
  const { useSessionLifetime } = await import("../src/addons/deliverables/composables/useSessionLifetime.ts");
  const { setAccessToken } = await import("../src/addons/deliverables/utils/token.ts");
  const mounted = mount({ setup: () => useSessionLifetime(() => undefined) }, {});
  const owner = mounted.state.capture();
  setAccessToken("independently-replaced-fixture");
  assert.equal(owner.signal.aborted, false);
  assert.equal(mounted.state.isCurrent(owner), false);
  assert.throws(() => mounted.state.assertCurrent(owner), { name: "AbortError" });
});

for (const retire of ["logout", "unmount", "close", "context"]) {
  test(`upload dialog ${retire} aborts actual client XHR without starting hash or completion`, async (t) => {
    const xhr = installUploadXhr();
    t.after(xhr.restore);
    const client = await import("../src/addons/deliverables/api/client.ts");
    fixtures.api.uploadBytes = client.uploadBytes;
    let continuations = 0;
    fixtures.api.sha256Hex = async () => { continuations++; return ""; };
    fixtures.api.completeUpload = async () => { continuations++; return item; };
    const mounted = await upload();
    const pending = mounted.state.submitFile();
    await flush();
    const request = xhr.requests[0];
    assert.equal(request.sendCalls, 1);
    const lateProgress = request.upload.onprogress;
    if (retire === "logout") session.applyShellSession(null, ++version);
    else if (retire === "unmount") mounted.unmount();
    else if (retire === "close") mounted.props.open = false;
    else mounted.props.conversationId = 99;
    await flush();
    assert.equal(request.abortCalls, 1);
    lateProgress?.({ lengthComputable: true, loaded: 7, total: 7 });
    await pending;
    assert.equal(continuations, 0);
    assert.equal(mounted.saved.length, 0);
    assert.equal(mounted.state.error, "");
    assert.equal(mounted.state.progress, 0);
    assert.equal(mounted.state.busy, false);
  });
}

// UNI-MOBILE-IMPL board §15: phone add sheet, row menu and upload-on-pick.
function withNarrow(t: TestContext, matches: boolean): void {
  Object.defineProperty(childWindow, "matchMedia", {
    configurable: true,
    value: () => ({ matches, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  t.after(() => Reflect.deleteProperty(childWindow, "matchMedia"));
}

async function uploadWithFile(props: Record<string, unknown>) {
  const saved: unknown[] = [];
  const mounted = mount(UploadDialog, { open: false, mode: "file", file: null, onSaved: (value: unknown) => { saved.push(value); }, onClose: () => undefined, ...props });
  mounted.props.file = new File(["private"], "private.txt", { type: "text/plain" });
  mounted.props.open = true;
  await flush();
  return { ...mounted, saved };
}

test("phone upload starts on pick when the owning conversation is locked", async (t) => {
  withNarrow(t, true);
  const calls: unknown[][] = [];
  fixtures.api.createUpload = async (...args) => { calls.push(args); return { deliverable: item, upload: { uploadUrl: signedUrl } }; };
  const mounted = await uploadWithFile({ conversationId: 12 });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 12);
  assert.deepEqual(mounted.saved, [item]);
});

test("phone upload waits for an owner, then starts on the next pick", async (t) => {
  withNarrow(t, true);
  let calls = 0;
  fixtures.api.createUpload = async () => { calls++; return { deliverable: item, upload: { uploadUrl: signedUrl } }; };
  const mounted = await uploadWithFile({});
  assert.equal(calls, 0);
  assert.equal(mounted.state.selectedFile?.name, "private.txt");
  mounted.state.conversationIdInput = "12";
  mounted.state.selectFile({ target: { files: [new File(["next"], "next.txt")] } });
  await flush();
  assert.equal(calls, 1);
});

test("desktop upload keeps the explicit start step", async () => {
  let calls = 0;
  fixtures.api.createUpload = async () => { calls++; return { deliverable: item, upload: { uploadUrl: signedUrl } }; };
  const mounted = await uploadWithFile({ conversationId: 12 });
  assert.equal(calls, 0);
  assert.equal(mounted.state.selectedFile?.name, "private.txt");
});

test("panel phone sheets list only existing actions and close before running them", async () => {
  const mounted = mount(DeliverablePanel, {});
  await flush();
  assert.deepEqual(mounted.state.addGroups.map((group: any[]) => group.map((action) => action.label)), [
    ["uploadTitle", "fromPhotos", "importUrl", "addLink"], ["cancel"],
  ]);
  mounted.state.addSheetOpen = true;
  mounted.state.addGroups[0][2].run();
  assert.equal(mounted.state.addSheetOpen, false);
  assert.equal(mounted.state.uploadMode, "import");
  let clicked = 0;
  mounted.state.fileInput = { value: "stale", click: () => { clicked++; } };
  mounted.state.addGroups[0][0].run();
  assert.equal(clicked, 1);
  assert.equal(mounted.state.fileInput.value, "");
  const picked = new File(["x"], "x.png", { type: "image/png" });
  mounted.state.filePicked({ target: { files: [picked] } });
  assert.equal(mounted.state.uploadMode, "file");
  assert.equal(mounted.state.pickedFile, picked);
  mounted.state.closeUpload();
  assert.equal(mounted.state.pickedFile, null);

  assert.deepEqual(mounted.state.menuGroups, []);
  mounted.state.menuItem = item;
  const labels = mounted.state.menuGroups.map((group: any[]) => group.map((action) => [action.label, Boolean(action.danger)]));
  assert.deepEqual(labels, [[["preview", false], ["download", false], ["clone…", false]], [["remove", true]]]);
  mounted.state.menuGroups[0][0].run();
  assert.equal(mounted.state.menuItem, null);
  assert.equal(mounted.state.previewItem?.id, item.id);
  mounted.state.menuItem = { ...item, source: "app-link", appUrl: "https://app.example.test" };
  assert.deepEqual(mounted.state.menuGroups[0].map((action: any) => action.label), ["openApp", "clone…"]);
  assert.equal(mounted.state.rowMeta(mounted.state.menuItem), "appSource");
  assert.equal(mounted.state.rowMeta(item), "7 B");

  fixtures.api.listDeliverables = () => new Promise(() => {});
  mounted.state.setKind("image");
  assert.equal(mounted.state.kind, "image");
  mounted.state.addSheetOpen = true;
  mounted.state.pickedFile = picked;
  session.applyShellSession("account-b-fixture", ++version);
  assert.equal(mounted.state.addSheetOpen, false);
  assert.equal(mounted.state.menuItem, null);
  assert.equal(mounted.state.pickedFile, null);
});
