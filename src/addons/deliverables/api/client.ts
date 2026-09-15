import {
  normalizeDeliverablePage,
  assertSuccessfulEnvelope,
  unwrapEnvelope,
  type Deliverable,
  type DeliverablePage,
  type Envelope,
  type UploadCredential,
} from "./contracts";
import { buildCompletePayload, buildPresignPayload, type FileMetadata } from "./uploadProtocol";
import { assertSafePreviewUrl } from "@/addons/deliverables/utils/previewPolicy";
import {
  assertCurrentSessionRequest,
  captureSessionRequest,
  handleEmbeddedUnauthorized,
} from "@/addons/deliverables/composables/embeddedSession";
import { translate } from "@/i18n";

const API_BASE = (import.meta.env.VITE_DELIVERABLES_API_URL ?? "").trim().replace(/\/$/, "");
const ROOT = `${API_BASE}/api/v1/deliverables`;

export interface ListParams {
  query?: string;
  conversationId?: number;
  kind?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  beforeId?: number;
  limit?: number;
}

async function request<T>(path: string, init: RequestInit = {}, allowEmptyData = false): Promise<T> {
  const owner = captureSessionRequest();
  if (!owner.token) {
    handleEmbeddedUnauthorized("missing", owner);
    throw new DOMException("Authentication required", "AbortError");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${owner.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const signal = init.signal ? AbortSignal.any([init.signal, owner.signal]) : owner.signal;
  let response: Response;
  try {
    response = await fetch(`${ROOT}${path}`, { ...init, headers, signal });
  } catch (error) {
    assertCurrentSessionRequest(owner);
    throw error;
  }
  assertCurrentSessionRequest(owner);
  const body = await response.json().catch(() => null) as Envelope<T> | null;
  // Body parsing can finish after a trusted session change, even after cancellation.
  assertCurrentSessionRequest(owner);
  if (response.status === 401) handleEmbeddedUnauthorized("rejected", owner);
  if (!response.ok) throw new Error(body?.message?.trim() || translate("requestFailed", { status: response.status }));
  if (!body) throw new Error(translate("invalidResponse"));
  if (allowEmptyData) {
    assertSuccessfulEnvelope(body);
    return undefined as T;
  }
  return unwrapEnvelope(body);
}

export async function listDeliverables(params: ListParams = {}): Promise<DeliverablePage> {
  const query = new URLSearchParams();
  if (params.query?.trim()) query.set("query", params.query.trim());
  if (params.conversationId && params.conversationId > 0) query.set("conversationId", String(params.conversationId));
  if (params.kind?.trim()) query.set("kind", params.kind.trim());
  if (params.status?.trim()) query.set("status", params.status.trim());
  if (params.dateFrom) query.set("dateFrom", params.dateFrom);
  if (params.dateTo) query.set("dateTo", params.dateTo);
  if (params.beforeId && params.beforeId > 0) query.set("beforeId", String(params.beforeId));
  query.set("limit", String(params.limit && params.limit > 0 ? params.limit : 40));
  return normalizeDeliverablePage(await request<DeliverablePage>(`?${query.toString()}`));
}

export async function createUpload(conversationId: number, file: FileMetadata): Promise<UploadCredential> {
  return request<UploadCredential>("/uploads/presign", {
    method: "POST",
    body: JSON.stringify(buildPresignPayload(conversationId, file)),
  });
}

export async function completeUpload(deliverableId: number, refId: string, sha256: string): Promise<Deliverable> {
  return request<Deliverable>(`/${deliverableId}/complete`, {
    method: "POST",
    body: JSON.stringify(buildCompletePayload(refId, sha256)),
  });
}

export async function createAppLink(input: { conversationId: number; name: string; appUrl: string }): Promise<Deliverable> {
  return request<Deliverable>("/app-links", { method: "POST", body: JSON.stringify(input) });
}

export async function importDeliverable(input: { conversationId: number; name?: string; url: string }): Promise<Deliverable> {
  return request<Deliverable>("/imports", { method: "POST", body: JSON.stringify(input) });
}

export async function deleteDeliverable(id: number): Promise<void> {
  await request<void>(`/${id}`, { method: "DELETE" }, true);
}

export async function cloneDeliverable(source: Deliverable, targetConversationId: number): Promise<Deliverable> {
  const copied = await request<Deliverable[]>("/clone", {
    method: "POST",
    body: JSON.stringify({
      sourceConversationId: source.conversationId,
      targetConversationId,
      deliverableIds: [source.id],
    }),
  });
  if (!copied[0]) throw new Error(translate("missingCloneResponse"));
  return copied[0];
}

export async function getDownloadUrl(id: number): Promise<string> {
  const data = await request<{ url: string }>(`/${id}/download`);
  return assertSafePreviewUrl(data.url);
}

export function uploadBytes(
  file: File,
  credential: UploadCredential["upload"],
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const owner = captureSessionRequest();
  const uploadSignal = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal;
  return new Promise((resolve, reject) => {
    const cancelled = () => new DOMException("Upload cancelled", "AbortError");
    if (uploadSignal.aborted) {
      reject(cancelled());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: unknown, value = "") => {
      if (settled) return;
      settled = true;
      uploadSignal.removeEventListener("abort", abort);
      xhr.upload.onprogress = null;
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () => {
      if (settled) return;
      // Settle and detach before abort(), which can synchronously emit events.
      finish(cancelled());
      xhr.abort();
    };
    const isCurrent = () => {
      if (settled) return false;
      try {
        assertCurrentSessionRequest(owner);
        if (!uploadSignal.aborted) return true;
      } catch {
        // A stored credential can also be replaced without a session event.
      }
      abort();
      return false;
    };
    try {
      const useForm = Boolean(credential.fileField || Object.keys(credential.formFields ?? {}).length);
      let body: XMLHttpRequestBodyInit = file;
      if (useForm) {
        const form = new FormData();
        for (const [key, value] of Object.entries(credential.formFields ?? {})) form.append(key, value);
        form.append(credential.fileField || "file", file);
        body = form;
      }
      xhr.open(credential.method || "PUT", assertSafePreviewUrl(credential.uploadUrl), true);
      for (const [key, value] of Object.entries(credential.headers ?? {})) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = (event) => {
        if (isCurrent() && event.lengthComputable) onProgress?.(event.loaded, event.total);
      };
      xhr.onerror = () => { if (isCurrent()) finish(new Error(translate("uploadNetworkFailed"))); };
      xhr.ontimeout = () => { if (isCurrent()) finish(new Error(translate("uploadTimeout"))); };
      xhr.onabort = () => finish(cancelled());
      xhr.onload = () => {
        if (!isCurrent()) return;
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(new Error(translate("uploadFailedStatus", { status: xhr.status })));
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText || "{}") as { dentry_id?: string; refId?: string };
          finish(undefined, data.refId ?? data.dentry_id ?? "");
        } catch {
          finish();
        }
      };
      uploadSignal.addEventListener("abort", abort, { once: true });
      if (isCurrent()) xhr.send(body);
    } catch (error) {
      finish(error);
    }
  });
}

export async function sha256Hex(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
