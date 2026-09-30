<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  cloneDeliverable,
  deleteDeliverable,
  getDownloadUrl,
  listDeliverables,
} from "@/addons/deliverables/api/client";
import type { Deliverable } from "@/addons/deliverables/api/contracts";
import { isCancelled, useSessionLifetime } from "@/addons/deliverables/composables/useSessionLifetime";
import { assertSafePreviewUrl, previewKind, shortFileType } from "@/addons/deliverables/utils/previewPolicy";
import ActionSheet, { type SheetAction } from "./ActionSheet.vue";
import PreviewDialog from "./PreviewDialog.vue";
import UploadDialog from "./UploadDialog.vue";

const props = withDefaults(defineProps<{ conversationId?: number; embedded?: boolean }>(), {
  conversationId: undefined,
  embedded: false,
});

const { t } = useI18n();
const items = ref<Deliverable[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const query = ref("");
const conversationId = ref(props.conversationId ? String(props.conversationId) : "");
const kind = ref("");
const dateFrom = ref("");
const dateTo = ref("");
const hasMore = ref(false);
const nextBeforeId = ref(0);
const uploadMode = ref<"file" | "app" | "import" | null>(null);
const pickedFile = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const photoInput = ref<HTMLInputElement | null>(null);
const previewItem = ref<Deliverable | null>(null);
// Phone chrome (board §15): the "+" add sheet and the per-row "⋯" sheet.
const addSheetOpen = ref(false);
const menuItem = ref<Deliverable | null>(null);
const notice = ref("");
let searchTimer: number | null = null;
let autoRefreshTimer: number | null = null;
let noticeTimer: number | null = null;
let requestVersion = 0;
const lifetime = useSessionLifetime(onSessionChange);

const scopedToConversation = computed(() => Boolean(props.conversationId && props.conversationId > 0));
// Single-path line icons from the board's symbol set (static, never data).
const ICONS = {
  upload: "M12 16V4M6 10l6-6 6 6M4 20h16",
  photos: "M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM10 8.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM21 15l-5-5L5 21",
  link: "M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7",
  app: "M4 3h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zM8 21h8M12 17v4",
};
const kindChips = [
  { value: "", key: "chipAll" },
  { value: "document", key: "chipDocuments" },
  { value: "image", key: "images" },
  { value: "media", key: "chipMedia" },
  { value: "app", key: "applications" },
];
const hasFilters = computed(() => Boolean(query.value || (!scopedToConversation.value && conversationId.value) || kind.value || dateFrom.value || dateTo.value));

function listParams(beforeId?: number) {
  const parsedConversationId = Number(conversationId.value.trim());
  return {
    query: query.value,
    conversationId: Number.isSafeInteger(parsedConversationId) && parsedConversationId > 0 ? parsedConversationId : undefined,
    kind: kind.value || undefined,
    status: "active",
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
    beforeId,
    limit: 40,
  };
}

/**
 * `quiet` refreshes in place: the focus/visibility refresh used to swap the list
 * for the loading panel, so the first tap into the iframe (which is what fires
 * `focus`) unmounted the button it landed on and the click was lost.
 */
async function load(append = false, quiet = false): Promise<void> {
  const owner = lifetime.capture();
  const version = ++requestVersion;
  if (append) loadingMore.value = true;
  else if (!quiet || !items.value.length) loading.value = true;
  error.value = "";
  try {
    const page = await listDeliverables(listParams(append ? nextBeforeId.value : undefined));
    if (version !== requestVersion || !lifetime.isCurrent(owner)) return;
    items.value = append ? [...items.value, ...page.items] : [...page.items];
    hasMore.value = page.hasMore;
    nextBeforeId.value = page.nextBeforeId;
  } catch (reason) {
    if (version !== requestVersion || !lifetime.isCurrent(owner) || isCancelled(reason)) return;
    error.value = t("loadFailed");
    if (!append) items.value = [];
  } finally {
    if (version === requestVersion && lifetime.isCurrent(owner)) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function scheduleLoad(): void {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { void load(); }, 280);
}

function resetFilters(): void {
  query.value = "";
  conversationId.value = scopedToConversation.value ? String(props.conversationId) : "";
  kind.value = "";
  dateFrom.value = "";
  dateTo.value = "";
}

function clearFilters(): void {
  resetFilters();
  void load();
}

function handleSaved(deliverable: Deliverable): void {
  items.value = [deliverable, ...items.value.filter((item) => item.id !== deliverable.id)];
  notice.value = deliverable.source === "app-link" ? t("linkCreated") : deliverable.source === "import" ? t("imported") : t("uploaded");
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.value = ""; }, 2600);
}

function openUpload(mode: "file" | "app" | "import"): void {
  addSheetOpen.value = false;
  pickedFile.value = null;
  uploadMode.value = mode;
}

// The native picker must open inside the tap itself (iOS drops deferred clicks),
// so the phone sheet owns the inputs and hands the picked file to the upload page.
function pickFile(input: HTMLInputElement | null): void {
  addSheetOpen.value = false;
  if (!input) return;
  input.value = "";
  input.click();
}

function filePicked(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  pickedFile.value = file;
  uploadMode.value = "file";
}

function closeUpload(): void {
  uploadMode.value = null;
  pickedFile.value = null;
}

function setKind(value: string): void {
  kind.value = value;
  void load();
}

const addGroups = computed<SheetAction[][]>(() => [
  [
    { label: t("uploadTitle"), icon: ICONS.upload, run: () => pickFile(fileInput.value) },
    { label: t("fromPhotos"), icon: ICONS.photos, run: () => pickFile(photoInput.value) },
    { label: t("importUrl"), icon: ICONS.link, run: () => openUpload("import") },
    { label: t("addLink"), icon: ICONS.app, run: () => openUpload("app") },
  ],
  [{ label: t("cancel"), center: true, run: () => { addSheetOpen.value = false; } }],
]);

const menuGroups = computed<SheetAction[][]>(() => {
  const item = menuItem.value;
  if (!item) return [];
  const act = (run: (target: Deliverable) => unknown) => () => { menuItem.value = null; void run(item); };
  const main: SheetAction[] = [{ label: item.source === "app-link" ? t("openApp") : t("preview"), run: act(showPreview) }];
  if (item.source !== "app-link") main.push({ label: t("download"), run: act(download) });
  main.push({ label: `${t("clone")}…`, run: act(clone) });
  return [main, [{ label: t("remove"), danger: true, run: act(remove) }]];
});

function rowMeta(item: Deliverable): string {
  return item.source === "app-link" ? t("appSource") : formatSize(item.size);
}

function showPreview(item: Deliverable): void {
  previewItem.value = item;
}

async function download(item: Deliverable): Promise<void> {
  const owner = lifetime.capture();
  try {
    const target = item.source === "app-link" ? assertSafePreviewUrl(item.appUrl || "") : await getDownloadUrl(item.id);
    lifetime.assertCurrent(owner);
    if (!target) throw new Error(t("downloadUnavailable"));
    window.open(target, "_blank", "noopener,noreferrer");
  } catch (reason) {
    if (lifetime.isCurrent(owner) && !isCancelled(reason)) error.value = t("downloadFailed");
  }
}

async function clone(item: Deliverable): Promise<void> {
  const owner = lifetime.capture();
  const answer = window.prompt(t("clonePrompt"));
  if (answer === null || !lifetime.isCurrent(owner)) return;
  const targetConversationId = Number(answer.trim());
  if (!Number.isSafeInteger(targetConversationId) || targetConversationId <= 0) {
    error.value = t("invalidConversation");
    return;
  }
  try {
    const copied = await cloneDeliverable(item, targetConversationId);
    lifetime.assertCurrent(owner);
    items.value = [copied, ...items.value.filter((candidate) => candidate.id !== copied.id)];
    notice.value = t("copied");
  } catch (reason) {
    if (lifetime.isCurrent(owner) && !isCancelled(reason)) error.value = t("cloneFailed");
  }
}

async function remove(item: Deliverable): Promise<void> {
  const owner = lifetime.capture();
  if (!window.confirm(t("confirmDelete")) || !lifetime.isCurrent(owner)) return;
  try {
    await deleteDeliverable(item.id);
    lifetime.assertCurrent(owner);
    items.value = items.value.filter((candidate) => candidate.id !== item.id);
    notice.value = t("deleted");
  } catch (reason) {
    if (lifetime.isCurrent(owner) && !isCancelled(reason)) error.value = t("deleteFailed");
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function sourceLabel(source: Deliverable["source"]): string {
  if (source === "generated") return t("agentSource");
  if (source === "app-link") return t("appSource");
  if (source === "import") return t("importSource");
  return t("uploadSource");
}

function onSessionChange(): void {
  if (searchTimer) window.clearTimeout(searchTimer);
  if (noticeTimer) window.clearTimeout(noticeTimer);
  previewItem.value = null;
  uploadMode.value = null;
  pickedFile.value = null;
  addSheetOpen.value = false;
  menuItem.value = null;
  items.value = [];
  notice.value = "";
  error.value = "";
  hasMore.value = false;
  nextBeforeId.value = 0;
  loadingMore.value = false;
  resetFilters();
  void load();
}

function refreshWhenVisible(): void {
  if (document.visibilityState === "visible" && !loading.value && !loadingMore.value) void load(false, true);
}

onMounted(() => {
  window.addEventListener("focus", refreshWhenVisible);
  document.addEventListener("visibilitychange", refreshWhenVisible);
  if (props.embedded) autoRefreshTimer = window.setInterval(refreshWhenVisible, 15_000);
  void load();
});
onBeforeUnmount(() => {
  requestVersion += 1;
  if (searchTimer) window.clearTimeout(searchTimer);
  if (autoRefreshTimer) window.clearInterval(autoRefreshTimer);
  if (noticeTimer) window.clearTimeout(noticeTimer);
  window.removeEventListener("focus", refreshWhenVisible);
  document.removeEventListener("visibilitychange", refreshWhenVisible);
});
</script>

<template>
  <section class="deliverables-shell" :class="{ embedded }">
    <header class="page-head anim-fade-up" :class="{ compact: embedded }">
      <div class="heading-copy">
        <span class="eyebrow">DELIVERABLES</span>
        <h1>{{ embedded ? t("conversationTitle") : t("title") }}</h1>
        <p v-if="!embedded">{{ t("subtitle") }}</p>
      </div>
      <div class="primary-actions">
        <button class="button secondary" type="button" @click="uploadMode = 'app'">{{ t("addLink") }}</button>
        <button class="button secondary" type="button" @click="uploadMode = 'import'">{{ t("importUrl") }}</button>
        <button class="button primary" type="button" @click="uploadMode = 'file'">{{ t("upload") }}</button>
      </div>
      <button class="add-button" type="button" :aria-label="t('addTitle')" @click="addSheetOpen = true">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </header>

    <div class="catalog-card anim-fade-up delay-1">
      <div class="filters">
        <label class="search-field">
          <span aria-hidden="true">⌕</span>
          <input v-model="query" :placeholder="t('search')" @input="scheduleLoad" />
        </label>
        <input v-if="!scopedToConversation" v-model="conversationId" class="filter-control conversation" inputmode="numeric" :placeholder="t('conversation')" @input="scheduleLoad" />
        <select v-model="kind" class="filter-control" @change="load()">
          <option value="">{{ t("allTypes") }}</option>
          <option value="document">{{ t("documents") }}</option>
          <option value="image">{{ t("images") }}</option>
          <option value="media">{{ t("media") }}</option>
          <option value="app">{{ t("applications") }}</option>
        </select>
        <input v-model="dateFrom" class="filter-control date" type="date" :aria-label="t('startDate')" @change="load()" />
        <input v-model="dateTo" class="filter-control date" type="date" :aria-label="t('endDate')" @change="load()" />
        <button v-if="hasFilters" class="text-button" type="button" @click="clearFilters">{{ t("clearFilters") }}</button>
        <button class="text-button" type="button" @click="load()">{{ t("refresh") }}</button>
      </div>
      <div class="chips" role="group" :aria-label="t('allTypes')">
        <button v-for="chip in kindChips" :key="chip.key" class="chip" type="button" :aria-pressed="kind === chip.value" @click="setKind(chip.value)">{{ t(chip.key) }}</button>
      </div>

      <div v-if="loading" class="state-panel" aria-live="polite">
        <span class="spinner" /><strong>{{ t("loading") }}</strong>
        <div class="skeleton-lines"><i /><i /><i /></div>
      </div>

      <div v-else-if="error && !items.length" class="state-panel error-state">
        <span class="state-code">ERR</span><strong>{{ t("loadFailed") }}</strong><p>{{ error }}</p>
        <button class="button secondary" type="button" @click="load()">{{ t("retry") }}</button>
      </div>

      <div v-else-if="!items.length" class="state-panel empty-state">
        <span class="empty-mark">N</span><strong>{{ t("emptyTitle") }}</strong><p>{{ t("emptyBody") }}</p>
        <button class="button primary" type="button" @click="uploadMode = 'file'">{{ t("upload") }}</button>
      </div>

      <template v-else>
        <div class="table-summary">{{ t("resultCount", { count: items.length }) }}</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>{{ t("file") }}</th><th>{{ t("conversation") }}</th><th>{{ t("source") }}</th><th>{{ t("size") }}</th><th>{{ t("created") }}</th><th class="actions-heading">{{ t("actions") }}</th></tr></thead>
            <tbody>
              <tr v-for="item in items" :key="item.id">
                <td>
                  <button class="file-cell" type="button" @click="showPreview(item)">
                    <span class="type-badge" :data-kind="previewKind(item.mimeType, item.name)">{{ item.source === "app-link" ? "APP" : shortFileType(item.mimeType, item.name) }}</span>
                    <span class="file-copy"><strong>{{ item.name }}</strong><small>{{ item.mimeType || "application/octet-stream" }}</small></span>
                  </button>
                </td>
                <td><span class="conversation-id">#{{ item.conversationId }}</span></td>
                <td><span class="source-badge" :data-source="item.source">{{ sourceLabel(item.source) }}</span></td>
                <td>{{ item.source === "app-link" ? "" : formatSize(item.size) }}</td>
                <td>{{ formatDate(item.createdAt) }}</td>
                <td>
                  <div class="row-actions">
                    <button type="button" @click="showPreview(item)">{{ item.source === "app-link" ? t("openApp") : t("preview") }}</button>
                    <button v-if="item.source !== 'app-link'" type="button" @click="download(item)">{{ t("download") }}</button>
                    <button type="button" @click="clone(item)">{{ t("clone") }}</button>
                    <button class="danger" type="button" @click="remove(item)">{{ t("remove") }}</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mobile-list">
          <div v-for="item in items" :key="item.id" class="mobile-row">
            <button class="file-cell" type="button" @click="showPreview(item)">
              <span class="type-badge" :data-kind="previewKind(item.mimeType, item.name)">{{ item.source === "app-link" ? "APP" : shortFileType(item.mimeType, item.name) }}</span>
              <span class="file-copy"><strong>{{ item.name }}</strong><small>{{ rowMeta(item) }}</small></span>
            </button>
            <button class="more-button" type="button" :aria-label="`${t('actions')}: ${item.name}`" @click="menuItem = item">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10.2a1.8 1.8 0 110 3.6 1.8 1.8 0 010-3.6zM12 10.2a1.8 1.8 0 110 3.6 1.8 1.8 0 010-3.6zM19 10.2a1.8 1.8 0 110 3.6 1.8 1.8 0 010-3.6z" /></svg>
            </button>
          </div>
        </div>

        <footer v-if="hasMore" class="load-more"><button class="button secondary" type="button" :disabled="loadingMore" @click="load(true)">{{ loadingMore ? t("loading") : t("loadMore") }}</button></footer>
      </template>
    </div>

    <p v-if="error && items.length" class="inline-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="toast" role="status">{{ notice }}</p>
    <input ref="fileInput" class="visually-hidden" type="file" tabindex="-1" aria-hidden="true" @change="filePicked" />
    <input ref="photoInput" class="visually-hidden" type="file" accept="image/*,video/*" tabindex="-1" aria-hidden="true" @change="filePicked" />
    <UploadDialog :open="uploadMode !== null" :mode="uploadMode || 'file'" :file="pickedFile" :conversation-id="props.conversationId" @close="closeUpload" @saved="handleSaved" />
    <ActionSheet :open="addSheetOpen" :title="t('addTitle')" :groups="addGroups" @close="addSheetOpen = false" />
    <ActionSheet :open="menuItem !== null" :title="menuItem?.name ?? ''" :groups="menuGroups" @close="menuItem = null" />
    <PreviewDialog :open="previewItem !== null" :deliverable="previewItem" @close="previewItem = null" />
  </section>
</template>

<style scoped>
.deliverables-shell { width: min(1440px, 100%); margin: 0 auto; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; margin-bottom: 24px; }
.page-head.compact { align-items: center; margin-bottom: 14px; }
.page-head.compact h1 { font-size: 24px; }
.embedded .catalog-card { border-radius: var(--r-lg); }
.heading-copy { max-width: 700px; }
.eyebrow { display: block; margin-bottom: 4px; color: var(--accent); font-family: var(--font-mono); font-size: 10px; font-weight: 800; letter-spacing: .18em; }
h1 { font-family: var(--font-display); font-size: clamp(32px, 4vw, 48px); font-weight: 500; line-height: 1.08; letter-spacing: -.02em; }
.heading-copy p { margin-top: 8px; color: var(--text-secondary); font-size: 14px; }
.primary-actions { display: flex; gap: 10px; }
.button { min-height: 40px; padding: 0 16px; border: 1px solid transparent; border-radius: var(--r-md); font-size: 13px; font-weight: 750; white-space: nowrap; cursor: pointer; transition: transform .15s var(--ease), box-shadow .15s var(--ease); }
.button:hover { transform: translateY(-1px); }
.button:disabled { cursor: wait; opacity: .55; }
.button.primary { color: white; background: var(--grad-teal-indigo); box-shadow: var(--shadow-teal); }
.button.secondary { border-color: var(--border); color: var(--text-secondary); background: var(--bg-card); }
.catalog-card { overflow: hidden; border: 1px solid rgb(226 232 240 / 88%); border-radius: var(--r-xl); background: rgb(255 255 255 / 88%); box-shadow: var(--shadow-sm); backdrop-filter: blur(12px); }
.filters { display: flex; flex-wrap: wrap; gap: 9px; padding: 15px 17px; border-bottom: 1px solid var(--border); background: rgb(248 250 252 / 74%); }
.search-field { display: flex; flex: 1 1 260px; align-items: center; gap: 8px; min-width: 220px; height: 38px; padding: 0 11px; border: 1px solid var(--border); border-radius: var(--r-md); background: white; }
.search-field span { color: var(--text-tertiary); font-size: 22px; line-height: 1; }
.search-field input { width: 100%; border: 0; outline: 0; color: var(--text-primary); background: transparent; }
.filter-control { height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--r-md); color: var(--text-secondary); background: white; }
.conversation { width: 132px; }
.date { width: 142px; }
.text-button { padding: 0 7px; border: 0; color: var(--accent); background: transparent; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
.state-panel { display: grid; min-height: 350px; place-content: center; justify-items: center; gap: 10px; padding: 36px; color: var(--text-secondary); text-align: center; }
.state-panel strong { color: var(--text-primary); font-size: 16px; }
.state-panel p { max-width: 440px; }
.spinner { width: 28px; height: 28px; border: 3px solid var(--slate-200); border-top-color: var(--accent); border-radius: 50%; animation: spin .75s linear infinite; }
.skeleton-lines { display: grid; width: min(360px, 70vw); gap: 8px; margin-top: 14px; }
.skeleton-lines i { height: 8px; border-radius: var(--r-full); background: linear-gradient(90deg, var(--slate-100), var(--slate-200), var(--slate-100)); background-size: 200% 100%; animation: shimmer 1.4s infinite; }
.skeleton-lines i:nth-child(2) { width: 84%; }.skeleton-lines i:nth-child(3) { width: 92%; }
.state-code { padding: 5px 9px; border-radius: var(--r-sm); color: var(--rose-500); background: #fff1f2; font-family: var(--font-mono); font-size: 11px; font-weight: 800; }
.empty-mark { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 16px; color: white; background: var(--grad-teal-indigo); font-family: var(--font-display); font-size: 25px; box-shadow: var(--shadow-teal); }
.table-summary { padding: 10px 18px 0; color: var(--text-tertiary); font-size: 11px; }
.table-wrap { overflow-x: auto; padding: 0 16px 14px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { padding: 11px 10px; color: var(--text-tertiary); font-size: 10px; font-weight: 800; letter-spacing: .05em; text-align: left; text-transform: uppercase; }
th:first-child { width: 34%; } th:nth-child(2) { width: 10%; } th:nth-child(3) { width: 11%; } th:nth-child(4) { width: 8%; } th:nth-child(5) { width: 14%; } th:last-child { width: 23%; }
td { padding: 12px 10px; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: 12px; vertical-align: middle; }
tbody tr { transition: background .14s var(--ease); } tbody tr:hover { background: rgb(240 253 250 / 58%); }
.file-cell { display: flex; align-items: center; width: 100%; gap: 11px; min-width: 0; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.type-badge { display: grid; flex: 0 0 auto; width: 42px; height: 42px; place-items: center; border: 1px solid var(--teal-100); border-radius: 12px; color: var(--teal-700); background: var(--teal-50); font-family: var(--font-mono); font-size: 9px; font-weight: 800; }
.type-badge[data-kind="image"], .type-badge[data-kind="video"], .type-badge[data-kind="audio"] { border-color: #e0e7ff; color: var(--indigo-600); background: #eef2ff; }
.file-copy { display: grid; min-width: 0; gap: 2px; }
.file-copy strong, .file-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-copy strong { color: var(--text-primary); font-size: 13px; }.file-copy small { color: var(--text-tertiary); font-size: 10px; }
.conversation-id { font-family: var(--font-mono); color: var(--text-secondary); }
.source-badge { display: inline-flex; padding: 4px 7px; border-radius: var(--r-full); color: var(--teal-700); background: var(--teal-50); font-size: 10px; font-weight: 700; white-space: nowrap; }
.source-badge[data-source="agent"] { color: var(--indigo-600); background: #eef2ff; }.source-badge[data-source="app"] { color: var(--violet-600); background: #f5f3ff; }
.row-actions { display: flex; flex-wrap: wrap; gap: 3px; }
.row-actions button { padding: 4px 6px; border: 0; color: var(--accent); background: transparent; font-size: 10px; font-weight: 700; white-space: nowrap; cursor: pointer; }
.row-actions .danger { color: var(--rose-500); }
.actions-heading { text-align: left; }
.load-more { display: flex; justify-content: center; padding: 5px 18px 19px; }
.add-button, .chips, .mobile-list { display: none; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.inline-error { margin-top: 12px; color: var(--rose-500); font-size: 12px; }
.toast { position: fixed; right: 24px; bottom: 24px; z-index: 120; padding: 11px 15px; border: 1px solid var(--teal-200); border-radius: var(--r-md); color: var(--teal-800); background: var(--teal-50); box-shadow: var(--shadow-lg); font-weight: 700; animation: slide-in-right .2s var(--ease-out); }
/* Phone layout (UNI-MOBILE-IMPL board §15, Ruling 1a: below 1024px). */
@media (max-width: 1023.98px) {
  .page-head, .page-head.compact { flex-direction: row; align-items: center; gap: 12px; margin-bottom: 12px; }
  .eyebrow, .heading-copy p, .primary-actions, .table-summary, .table-wrap { display: none; }
  h1, .page-head.compact h1 { font-family: var(--font-body); font-size: 22px; font-weight: 700; letter-spacing: 0; }
  .add-button { display: grid; flex: none; width: 44px; height: 44px; place-items: center; border: 0; border-radius: var(--r-md); color: var(--text-primary); background: transparent; cursor: pointer; }
  .add-button svg, .more-button svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .catalog-card { border-radius: var(--r-lg); backdrop-filter: none; }
  .filters { padding: 12px 12px 10px; border-bottom: 0; background: transparent; }
  .filters > :not(.search-field) { display: none; }
  .search-field { flex-basis: 100%; min-width: 0; height: 40px; }
  .search-field input { height: 44px; margin: -2px 0; font-size: 16px; }
  .chips { display: flex; gap: 8px; overflow-x: auto; padding: 0 12px 12px; scrollbar-width: none; }
  .chip { flex: none; height: 44px; padding: 0 14px; border: 1px solid var(--border); border-radius: var(--r-full); color: var(--text-primary); background: var(--bg-card); font-size: 14px; font-weight: 600; cursor: pointer; }
  .chip[aria-pressed="true"] { border-color: transparent; color: var(--indigo-600); background: var(--grad-brand-soft); }
  .mobile-list { display: block; overflow: hidden; margin: 0 12px 12px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-card); }
  .mobile-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px; align-items: center; gap: 4px; min-height: 64px; padding: 0 4px 0 12px; }
  .mobile-row + .mobile-row { border-top: 1px solid var(--border); }
  .mobile-row .file-cell { min-height: 64px; gap: 12px; }
  .mobile-row .type-badge { width: 40px; height: 40px; border-radius: var(--r-md); font-size: 10.5px; }
  .mobile-row .file-copy strong { font-size: 15px; font-weight: 600; }
  .mobile-row .file-copy small { color: var(--text-secondary); font-size: 12.5px; }
  .more-button { display: grid; width: 44px; height: 44px; place-items: center; border: 0; border-radius: var(--r-md); color: var(--text-secondary); background: transparent; cursor: pointer; }
  .button { min-height: 44px; }
  .state-panel { min-height: 240px; padding: 24px 16px; }
  .toast { right: 14px; bottom: 14px; left: 14px; text-align: center; }
}
</style>
