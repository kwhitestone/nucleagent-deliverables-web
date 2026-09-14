import { createI18n } from "vue-i18n";
import zh from "./zh.ts";
import en from "./en.ts";
import { resolveInitialLocale, type SupportedLocale } from "./localePolicy.ts";

export const LOCALE_STORAGE_KEY = "nucleagent_locale";

const queryLocale = typeof window === "undefined"
  ? null
  : new URLSearchParams(window.location.search).get("locale");
const savedLocale = typeof localStorage === "undefined"
  ? null
  : localStorage.getItem(LOCALE_STORAGE_KEY);
const browserLanguage = typeof navigator === "undefined" ? null : navigator.language;
const initialLocale = resolveInitialLocale(queryLocale, savedLocale, browserLanguage);

const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: "en",
  messages: { zh, en },
});

function applyDocumentLocale(locale: SupportedLocale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en-US";
  document.title = String(i18n.global.t("documentTitle"));
}

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale;
  if (typeof localStorage !== "undefined") localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  applyDocumentLocale(locale);
}

export function getLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale;
}

export function translate(key: string, named: Record<string, string | number> = {}): string {
  return String(i18n.global.t(key, named));
}

applyDocumentLocale(initialLocale);

export type { SupportedLocale };
export default i18n;
