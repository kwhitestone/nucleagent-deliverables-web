import assert from "node:assert/strict";
import test from "node:test";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createI18n, useI18n } from "vue-i18n";

import i18n, { getLocale, LOCALE_STORAGE_KEY, setLocale, translate } from "../src/i18n/index.ts";
import en from "../src/i18n/en.ts";
import zh from "../src/i18n/zh.ts";

const catalogs = { en, zh };
const markup = '<img src=x onerror="alert(1)">';
const escapedMarkup = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;";
const errorKeys = [
  "loadFailed", "downloadFailed", "cloneFailed", "deleteFailed",
  "previewFailed", "uploadFailed", "addLinkFailed", "importFailed",
] as const;

for (const locale of ["en", "zh"] as const) {
  test(`${locale}: production translations remain plain-text messages`, () => {
    for (const [key, message] of Object.entries(catalogs[locale])) {
      assert.equal(typeof message, "string", key);
      assert.doesNotMatch(message, /[<>]/, key);
    }
  });

  test(`${locale}: real product i18n renders numeric values and escapes text and attributes`, async () => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const app = createSSRApp({
        setup() {
          const { t } = useI18n();
          return () => h("section", [
            h("p", t("resultCount", { count: 2 })),
            h("p", translate("requestFailed", { status: 403 })),
            h("p", t("resultCount", { count: markup })),
            h("input", { placeholder: t("resultCount", { count: markup }) }),
            ...errorKeys.map((key) => h("span", t(key))),
          ]);
        },
      });
      app.use(i18n);

      const html = await renderToString(app);
      assert.ok(html.includes(catalogs[locale].resultCount.replace("{count}", "2")));
      assert.ok(html.includes(catalogs[locale].requestFailed.replace("{status}", "403")));
      assert.ok(html.includes(escapedMarkup));
      assert.doesNotMatch(html, /<img\b/i);
      const placeholder = catalogs[locale].resultCount.replace("{count}", escapedMarkup);
      assert.ok(html.includes(`<input placeholder="${placeholder}">`));
      for (const key of errorKeys) {
        assert.ok(html.includes(`<span>${catalogs[locale][key]}</span>`), key);
      }
    } finally {
      setLocale(previousLocale);
    }
  });
}

test("real locale changes update translations, document metadata and persisted preference", () => {
  const previousLocale = getLocale();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const document = { documentElement: { lang: "" }, title: "" };
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true, value: { setItem: (key: string, value: string) => saved.set(key, value) },
  });
  try {
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      assert.equal(getLocale(), locale);
      assert.equal(translate("title"), catalogs[locale].title);
      assert.equal(saved.get(LOCALE_STORAGE_KEY), locale);
      assert.equal(document.title, catalogs[locale].documentTitle);
      assert.equal(document.documentElement.lang, locale === "zh" ? "zh-CN" : "en-US");
    }
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    setLocale(previousLocale);
  }
});

// GHSA-x8qp-wqqm-57ph: exercise the dependency's HTML sink, not a product feature.
for (const legacy of [false, true]) {
  for (const interpolation of ["named", "list"] as const) {
    test(`GHSA-x8qp-wqqm-57ph: ${legacy ? "legacy" : "composition"} ${interpolation} rendering neutralizes event attributes`, async () => {
      const placeholder = interpolation === "named" ? "{payload}" : "{0}";
      const fixture = createI18n({
        legacy,
        locale: "en",
        warnHtmlMessage: false,
        escapeParameter: true,
        escapeParameterHtml: true,
        messages: {
          en: { warning: `Caution: <img src=x onerror="${placeholder}">` },
        },
      });
      try {
        const app = createSSRApp({
          render() {
            const message = interpolation === "named"
              ? fixture.global.t("warning", { payload: "alert(1)" })
              : fixture.global.t("warning", ["alert(1)"]);
            return h("div", { innerHTML: message });
          },
        });
        app.use(fixture);

        const html = await renderToString(app);
        assert.doesNotMatch(html, /\sonerror\s*=/i);
        assert.equal(html, '<div>Caution: <img src=x &#111;nerror="alert(1)"></div>');
      } finally {
        fixture.dispose();
      }
    });
  }
}
