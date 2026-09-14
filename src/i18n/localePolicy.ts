export type SupportedLocale = "zh" | "en";

export function normalizeLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace("_", "-");
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

export function resolveInitialLocale(
  queryLocale: unknown,
  savedLocale: unknown,
  browserLanguage: unknown,
): SupportedLocale {
  return normalizeLocale(queryLocale)
    ?? normalizeLocale(savedLocale)
    ?? normalizeLocale(browserLanguage)
    ?? "zh";
}
