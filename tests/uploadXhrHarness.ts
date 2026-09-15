export function installUploadXhr(failAt?: "open" | "header" | "send") {
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const requests: UploadXhr[] = [];
  class UploadXhr {
    status = 200;
    responseText = '{"refId":"fixture-reference"}';
    abortCalls = 0;
    sendCalls = 0;
    body?: XMLHttpRequestBodyInit;
    method = "";
    url = "";
    headers = new Headers();
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() { requests.push(this); }
    open(method: string, url: string) {
      if (failAt === "open") throw new Error("fixture setup failure");
      this.method = method;
      this.url = url;
    }
    setRequestHeader(key: string, value: string) {
      if (failAt === "header") throw new Error("fixture header failure");
      this.headers.set(key, value);
    }
    send(body: XMLHttpRequestBodyInit) {
      if (failAt === "send") throw new Error("fixture send failure");
      this.body = body;
      this.sendCalls++;
    }
    abort() {
      this.abortCalls++;
      this.onabort?.();
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: UploadXhr });
  return { requests, restore: () => {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  } };
}
