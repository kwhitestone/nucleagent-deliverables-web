export function shouldAcceptShellSession(
  currentVersion: number,
  rejectedVersion: number | null,
  incomingVersion: number,
  hasToken: boolean,
): boolean {
  if (!Number.isSafeInteger(incomingVersion) || incomingVersion < 0) return false;
  if (incomingVersion < currentVersion) return false;
  if (hasToken && incomingVersion === rejectedVersion) return false;
  return true;
}

export function resolveShellLocale(message: unknown): "zh" | "en" | null {
  if (!message || typeof message !== "object") return null;
  const data = message as { source?: unknown; type?: unknown; locale?: unknown };
  if (data.source !== "shell" || data.type !== "locale") return null;
  return data.locale === "zh" || data.locale === "en" ? data.locale : null;
}
