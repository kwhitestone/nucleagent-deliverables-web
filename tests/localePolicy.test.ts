import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLocale, resolveInitialLocale } from "../src/i18n/localePolicy.ts";
import en from "../src/i18n/en.ts";
import zh from "../src/i18n/zh.ts";

test("locale normalization accepts only the two supported languages", () => {
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("en_US"), "en");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(normalizeLocale(null), null);
});

test("shell query locale wins, followed by saved preference and browser language", () => {
  assert.equal(resolveInitialLocale("zh", "en", "en-US"), "zh");
  assert.equal(resolveInitialLocale(null, "en", "zh-CN"), "en");
  assert.equal(resolveInitialLocale(null, null, "en-GB"), "en");
  assert.equal(resolveInitialLocale(null, null, "fr-FR"), "zh");
});

test("Chinese and English catalogs expose the same message keys", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
