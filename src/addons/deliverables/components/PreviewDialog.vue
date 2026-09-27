<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getDownloadUrl } from "@/addons/deliverables/api/client";
import type { Deliverable } from "@/addons/deliverables/api/contracts";
import { isCancelled, useSessionLifetime, type SessionOperation } from "@/addons/deliverables/composables/useSessionLifetime";
import { renderSanitizedDocx } from "@/addons/deliverables/utils/docxPreviewPolicy";
import { assertSafePreviewUrl, previewKind, type PreviewKind } from "@/addons/deliverables/utils/previewPolicy";
import { shareOrCopy } from "@/addons/deliverables/utils/share";

const props = defineProps<{ open: boolean; deliverable: Deliverable | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const loading = ref(false);
const error = ref("");
const url = ref("");
const kind = ref<PreviewKind>("unsupported");
const text = ref("");
const markdown = ref("");
const sheetRows = ref<string[][]>([]);
const docxHost = ref<HTMLElement | null>(null);
const active = ref(false);
const shareNotice = ref("");
const lifetime = useSessionLifetime(close);

function reset(): void {
  lifetime.invalidate();
  active.value = false;
  shareNotice.value = "";
  loading.value = false;
  error.value = "";
  url.value = "";
  kind.value = "unsupported";
  text.value = "";
  markdown.value = "";
  sheetRows.value = [];
  if (docxHost.value) docxHost.value.replaceChildren();
}

function parseWorkbook(buffer: ArrayBuffer, owner: SessionOperation): Promise<string[][]> {
  lifetime.assertCurrent(owner);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/xlsxPreview.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => {
      window.clearTimeout(timeout);
      owner.signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Preview closed", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(t("workbookParseTimeout")));
    }, 8000);
    owner.signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ rows?: string[][]; errorKey?: string }>) => {
      cleanup();
      if (event.data.errorKey) reject(new Error(t(event.data.errorKey)));
      else resolve(event.data.rows ?? []);
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error(t("workbookParseFailed")));
    };
    try {
      worker.postMessage(buffer, [buffer]);
    } catch (reason) {
      cleanup();
      reject(reason);
    }
  });
}

async function fetchLimitedText(downloadUrl: string, owner: SessionOperation, maxBytes = 10 * 1024 * 1024): Promise<string> {
  const response = await fetch(downloadUrl, { signal: owner.signal });
  lifetime.assertCurrent(owner);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(t("previewTooLarge"));
  const blob = await response.blob();
  lifetime.assertCurrent(owner);
  if (blob.size > maxBytes) throw new Error(t("previewTooLarge"));
  return blob.text();
}

async function load(): Promise<void> {
  reset();
  const item = props.deliverable;
  if (!props.open || !item) return;
  const owner = lifetime.capture();
  active.value = true;
  loading.value = true;
  try {
    kind.value = item.source === "app-link" ? "unsupported" : previewKind(item.mimeType, item.name);
    if (item.source === "app-link") {
      url.value = assertSafePreviewUrl(item.appUrl || "");
      return;
    }
    const downloadUrl = await getDownloadUrl(item.id);
    lifetime.assertCurrent(owner);
    url.value = downloadUrl;
    if (kind.value === "text") {
      const content = await fetchLimitedText(downloadUrl, owner);
      lifetime.assertCurrent(owner);
      text.value = content;
    }
    if (kind.value === "markdown") {
      const source = await fetchLimitedText(downloadUrl, owner);
      lifetime.assertCurrent(owner);
      const html = await marked.parse(source);
      lifetime.assertCurrent(owner);
      markdown.value = DOMPurify.sanitize(html);
    }
    if (kind.value === "docx") {
      const response = await fetch(downloadUrl, { signal: owner.signal });
      lifetime.assertCurrent(owner);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      lifetime.assertCurrent(owner);
      if (buffer.byteLength > 20 * 1024 * 1024) throw new Error(t("previewTooLarge"));
      loading.value = false;
      await nextTick();
      lifetime.assertCurrent(owner);
      const { renderAsync } = await import("docx-preview");
      lifetime.assertCurrent(owner);
      const host = docxHost.value;
      if (host) {
        // The renderer may finish after logout; only commit to the live host
        // once the session and preview lifetime have been checked again.
        const staged = host.ownerDocument.createElement("div");
        await renderSanitizedDocx(buffer, staged, renderAsync, (html) => DOMPurify.sanitize(html, {
          FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
        }));
        lifetime.assertCurrent(owner);
        if (docxHost.value === host) host.innerHTML = staged.innerHTML;
      }
    }
    if (kind.value === "xlsx") {
      const response = await fetch(downloadUrl, { signal: owner.signal });
      lifetime.assertCurrent(owner);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get("content-length") || 0) > 20 * 1024 * 1024) throw new Error(t("previewTooLarge"));
      const buffer = await response.arrayBuffer();
      lifetime.assertCurrent(owner);
      if (buffer.byteLength > 20 * 1024 * 1024) throw new Error(t("previewTooLarge"));
      const rows = await parseWorkbook(buffer, owner);
      lifetime.assertCurrent(owner);
      sheetRows.value = rows;
    }
  } catch (reason) {
    if (lifetime.isCurrent(owner) && !isCancelled(reason)) {
      error.value = t("previewFailed");
    }
  } finally {
    if (lifetime.isCurrent(owner)) loading.value = false;
  }
}

function close(): void {
  reset();
  emit("close");
}

function openExternal(): void {
  if (url.value) window.open(url.value, "_blank", "noopener,noreferrer");
}

// Phone bottom bar (board §15 ④): share sheet, or copy the link where unsupported.
async function share(): Promise<void> {
  const owner = lifetime.capture();
  const name = props.deliverable?.name ?? "";
  if (!url.value) return;
  const outcome = await shareOrCopy(typeof navigator === "undefined" ? undefined : navigator, { title: name, url: url.value });
  if (!lifetime.isCurrent(owner)) return;
  shareNotice.value = outcome === "copied" ? t("linkCopied") : outcome === "failed" ? t("shareFailed") : "";
}

watch([() => props.open, () => props.deliverable], () => { void load(); }, { immediate: true, flush: "sync" });
onBeforeUnmount(reset);
</script>

<template>
  <Teleport to="body">
    <div v-if="open && deliverable && active" class="preview-backdrop" @mousedown.self="close">
      <section class="preview-card" role="dialog" aria-modal="true" :aria-label="deliverable.name" @keydown.esc="close">
        <header class="preview-head">
          <div class="preview-title">
            <span>{{ deliverable.mimeType || "application/octet-stream" }}</span>
            <h2>{{ deliverable.name }}</h2>
          </div>
          <div class="preview-actions">
            <button v-if="url" class="button secondary" type="button" @click="openExternal">
            {{ deliverable.source === "app-link" ? t("openApp") : t("download") }}
            </button>
            <button class="icon-button" type="button" :aria-label="t('close')" @click="close">×</button>
          </div>
        </header>

        <div class="preview-body">
          <div v-if="loading" class="preview-state"><span class="spinner" />{{ t("loadingPreview") }}</div>
          <div v-else-if="error" class="preview-state error"><strong>{{ t("previewFailed") }}</strong><span>{{ error }}</span></div>
          <a v-else-if="deliverable.source === 'app-link'" class="app-preview" :href="url" target="_blank" rel="noopener noreferrer">
            <span>WEB APP</span><strong>{{ deliverable.name }}</strong><small>{{ url }}</small>
          </a>
          <img v-else-if="kind === 'image'" class="media-preview image" :src="url" :alt="deliverable.name" />
          <video v-else-if="kind === 'video'" class="media-preview" :src="url" controls />
          <audio v-else-if="kind === 'audio'" class="audio-preview" :src="url" controls />
          <iframe v-else-if="kind === 'pdf'" class="frame-preview" :src="url" :title="deliverable.name" />
          <iframe v-else-if="kind === 'html'" class="frame-preview" :src="url" sandbox="" :title="deliverable.name" />
          <article v-else-if="kind === 'markdown'" class="document markdown" v-html="markdown" />
          <pre v-else-if="kind === 'text'" class="document text-preview">{{ text }}</pre>
          <div v-else-if="kind === 'docx'" ref="docxHost" class="document office-preview" />
          <div v-else-if="kind === 'xlsx'" class="sheet-wrap">
            <table><tbody><tr v-for="(row, rowIndex) in sheetRows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td></tr></tbody></table>
          </div>
          <div v-else class="preview-state"><strong>{{ deliverable.name }}</strong><span>{{ t("previewUnavailable") }}</span><button class="button primary" type="button" @click="openExternal">{{ t("download") }}</button></div>
        </div>
        <footer class="preview-bar">
          <p v-if="shareNotice" class="share-notice" role="status">{{ shareNotice }}</p>
          <button class="bar-button" type="button" :disabled="!url" @click="share">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v13M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" /></svg>{{ t("share") }}
          </button>
          <button class="bar-button primary" type="button" :disabled="!url" @click="openExternal">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M4 20h16" /></svg>{{ deliverable.source === "app-link" ? t("openApp") : t("download") }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.preview-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgb(15 23 42 / 48%); backdrop-filter: blur(8px); }
.preview-card { display: grid; grid-template-rows: auto minmax(0, 1fr); width: min(1120px, 96vw); height: min(820px, 92vh); overflow: hidden; border: 1px solid rgb(255 255 255 / 70%); border-radius: var(--r-xl); background: var(--bg-card); box-shadow: var(--shadow-xl); animation: scale-in .2s var(--ease-out); }
.preview-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.preview-title { min-width: 0; }
.preview-title span { color: var(--accent); font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; }
.preview-title h2 { overflow: hidden; margin-top: 2px; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
.preview-actions { display: flex; flex: 0 0 auto; gap: 9px; }
.button, .icon-button { min-height: 36px; border: 1px solid transparent; border-radius: var(--r-md); font-weight: 700; cursor: pointer; }
.button { padding: 0 14px; white-space: nowrap; }
.button.secondary { border-color: var(--border); color: var(--text-secondary); background: var(--bg-card); }
.button.primary { color: white; background: var(--grad-teal-indigo); }
.icon-button { width: 36px; color: var(--text-secondary); background: var(--bg-subtle); font-size: 22px; }
.preview-body { display: grid; min-height: 0; place-items: center; overflow: auto; background: var(--slate-50); }
.preview-state { display: grid; gap: 10px; max-width: 420px; justify-items: center; padding: 34px; color: var(--text-secondary); text-align: center; }
.preview-state.error strong { color: var(--rose-500); }
.spinner { width: 24px; height: 24px; border: 3px solid var(--slate-200); border-top-color: var(--accent); border-radius: 50%; animation: spin .75s linear infinite; }
.media-preview { max-width: 100%; max-height: 100%; }
.image { object-fit: contain; }
.audio-preview { width: min(520px, 80%); }
.frame-preview { width: 100%; height: 100%; border: 0; background: white; }
.document { width: min(880px, calc(100% - 48px)); min-height: calc(100% - 48px); margin: 24px; padding: 42px; border: 1px solid var(--border); background: white; box-shadow: var(--shadow-sm); }
.text-preview { overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 12px; }
.markdown :deep(img) { max-width: 100%; }
.markdown :deep(pre) { overflow: auto; padding: 14px; border-radius: var(--r-md); background: var(--slate-900); color: var(--slate-100); }
.office-preview { padding: 0; }
.sheet-wrap { align-self: stretch; justify-self: stretch; overflow: auto; margin: 18px; border: 1px solid var(--border); background: white; }
.sheet-wrap table { border-collapse: collapse; font-size: 12px; }
.sheet-wrap td { min-width: 100px; padding: 7px 9px; border: 1px solid var(--border); white-space: nowrap; }
.app-preview { display: grid; width: min(600px, calc(100% - 40px)); gap: 8px; padding: 30px; border: 1px solid var(--teal-200); border-radius: var(--r-xl); color: var(--text-primary); background: var(--grad-brand-soft); text-decoration: none; box-shadow: var(--shadow-md); }
.app-preview span { color: var(--accent); font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .14em; }
.app-preview strong { font-size: 22px; }
.app-preview small { overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.preview-bar { display: none; }
@media (max-width: 640px) { .preview-backdrop { padding: 0; } .preview-card { width: 100%; height: 100%; border-radius: 0; } .document { width: calc(100% - 24px); margin: 12px; padding: 22px; } }
/* Phone: full-screen second level, back top-left, actions in the thumb zone (board §15 ④). */
@media (max-width: 1023.98px) {
  .preview-backdrop { padding: 0; backdrop-filter: none; }
  .preview-card { grid-template-rows: auto minmax(0, 1fr) auto; width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; animation: none; }
  .preview-head { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: 4px; min-height: 52px; padding: 4px; }
  .preview-title { grid-column: 2; text-align: center; }
  .preview-title h2 { font-size: 16px; }
  .preview-title span { font-size: 11px; }
  .preview-actions { display: contents; }
  .preview-actions .button { display: none; }
  .icon-button { grid-column: 1; grid-row: 1; width: 44px; min-height: 44px; background: transparent; }
  .document { width: calc(100% - 24px); margin: 12px; padding: 22px; }
  .preview-bar { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border); background: var(--bg-card); }
  .bar-button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 52px; border: 1px solid var(--border-strong); border-radius: var(--r-lg); color: var(--text-primary); background: var(--bg-card); font-size: 16px; font-weight: 650; cursor: pointer; }
  .bar-button.primary { border-color: transparent; color: white; background: var(--grad-teal-indigo); }
  .bar-button:disabled { cursor: not-allowed; opacity: .55; }
  .bar-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .share-notice { position: absolute; right: 16px; bottom: calc(100% + 8px); left: 16px; padding: 10px 12px; border: 1px solid var(--teal-200); border-radius: var(--r-md); color: var(--teal-800); background: var(--teal-50); font-weight: 700; text-align: center; }
}
</style>
