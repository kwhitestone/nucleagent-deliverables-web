export type DeliverableStatus = "pending" | "active" | "failed";
export type DeliverableSource = "generated" | "upload" | "import" | "app-link";

export interface Deliverable {
  id: number;
  fileId: string;
  storageNamespace: string;
  userId: number;
  conversationId: number;
  stepId?: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  status: DeliverableStatus;
  source: DeliverableSource;
  appUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Envelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export interface DeliverablePage {
  items: Deliverable[];
  hasMore: boolean;
  nextBeforeId: number;
}

export interface UploadCredential {
  deliverable: Deliverable;
  upload: {
    fileId: string;
    method: string;
    uploadUrl: string;
    headers?: Record<string, string>;
    formFields?: Record<string, string>;
    fileField?: string;
    storedUrl?: string;
    expiresAt: number;
  };
}

export function unwrapEnvelope<T>(envelope: Envelope<T>): T {
  if (envelope.code !== 0) {
    throw new Error(envelope.message?.trim() || "request failed");
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new Error("response is missing data");
  }
  return envelope.data;
}

export function assertSuccessfulEnvelope(envelope: Envelope<unknown>): void {
  if (envelope.code !== 0) {
    throw new Error(envelope.message?.trim() || "request failed");
  }
}

function isDeliverable(value: unknown): value is Deliverable {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Deliverable>;
  return Number.isSafeInteger(item.id) && (item.id ?? 0) > 0 &&
    Number.isSafeInteger(item.userId) && (item.userId ?? 0) > 0 &&
    Number.isSafeInteger(item.conversationId) && (item.conversationId ?? 0) > 0 &&
    typeof item.name === "string" && item.name.trim().length > 0 &&
    typeof item.status === "string" && typeof item.source === "string";
}

export function normalizeDeliverablePage(value: Partial<DeliverablePage> | undefined): DeliverablePage {
  const items = Array.isArray(value?.items) ? value.items.filter(isDeliverable) : [];
  const nextBeforeId = Number.isSafeInteger(value?.nextBeforeId) && (value?.nextBeforeId ?? 0) > 0
    ? value!.nextBeforeId!
    : 0;
  return {
    items,
    hasMore: value?.hasMore === true,
    nextBeforeId,
  };
}
