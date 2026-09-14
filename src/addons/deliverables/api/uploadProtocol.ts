import { translate } from "../../../i18n/index.ts";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface FileMetadata {
  name: string;
  type: string;
  size: number;
}

export function validateUploadSelection(conversationId: number, file: FileMetadata | null): string | null {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return translate("invalidConversation");
  if (!file || !file.name.trim()) return translate("chooseValidFile");
  if (!Number.isFinite(file.size) || file.size <= 0) return translate("emptyFile");
  if (file.size > MAX_UPLOAD_BYTES) return translate("uploadTooLarge");
  return null;
}

export function buildPresignPayload(conversationId: number, file: FileMetadata) {
  return {
    conversationId,
    name: file.name.trim(),
    mimeType: file.type.trim() || "application/octet-stream",
    size: file.size,
  };
}

export function buildCompletePayload(refId: string, sha256: string) {
  const normalized = sha256.trim().toLowerCase();
  if (normalized && !/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(translate("invalidChecksum"));
  }
  return { refId: refId.trim(), sha256: normalized };
}
