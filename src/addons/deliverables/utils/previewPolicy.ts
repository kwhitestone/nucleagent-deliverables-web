export type PreviewKind = "image" | "video" | "audio" | "pdf" | "markdown" | "html" | "docx" | "xlsx" | "text" | "unsupported";

function normalizedMime(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(";", 1)[0];
}

export function previewKind(mimeType: string, name: string): PreviewKind {
  const mime = normalizedMime(mimeType);
  const lowerName = name.trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
  if (mime === "text/markdown" || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "markdown";
  if (mime === "text/html" || lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return "html";
  if (mime.includes("wordprocessingml") || lowerName.endsWith(".docx")) return "docx";
  if (mime.includes("spreadsheetml") || lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) return "xlsx";
  if (mime.startsWith("text/") || /\.(txt|csv|json|xml|ya?ml|log|js|ts|go|py|java|rs|css)$/.test(lowerName)) return "text";
  return "unsupported";
}

export function assertSafePreviewUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("unsafe preview URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("unsafe preview URL");
  }
  return url.toString();
}

export function shortFileType(mimeType: string, name: string): string {
  const mime = normalizedMime(mimeType);
  if (mime === "application/pdf") return "PDF";
  const subtype = mime.split("/")[1]?.split("+")[0];
  if (subtype && subtype.length <= 8) return subtype.toUpperCase();
  const extension = name.trim().split(".").pop();
  if (extension && extension !== name && extension.length <= 8) return extension.toUpperCase();
  return "FILE";
}
