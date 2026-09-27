<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { completeUpload, createAppLink, createUpload, importDeliverable, sha256Hex, uploadBytes } from "@/addons/deliverables/api/client";
import type { Deliverable } from "@/addons/deliverables/api/contracts";
import { validateUploadSelection } from "@/addons/deliverables/api/uploadProtocol";
import { isCancelled, useSessionLifetime, type SessionOperation } from "@/addons/deliverables/composables/useSessionLifetime";
import { useNarrow } from "@/addons/deliverables/composables/useNarrow";

// `file`: already picked by the phone add sheet (board §15 ②→③).
const props = defineProps<{ open: boolean; mode: "file" | "app" | "import"; conversationId?: number; file?: File | null }>();
const emit = defineEmits<{ close: []; saved: [deliverable: Deliverable] }>();
const { t } = useI18n();

const conversationId = ref("");
const selectedFile = ref<File | null>(null);
const appName = ref("");
const appUrl = ref("");
const importName = ref("");
const importUrl = ref("");
const busy = ref(false);
const progress = ref(0);
const error = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const active = ref(false);
const narrow = useNarrow();
const lifetime = useSessionLifetime(() => {
  reset();
  emit("close");
});

const title = computed(() => props.mode === "file" ? t("uploadTitle") : props.mode === "app" ? t("linkTitle") : t("importTitle"));

function reset(): void {
  lifetime.invalidate();
  active.value = false;
  conversationId.value = "";
  selectedFile.value = null;
  appName.value = "";
  appUrl.value = "";
  importName.value = "";
  importUrl.value = "";
  busy.value = false;
  progress.value = 0;
  error.value = "";
  if (fileInput.value) fileInput.value.value = "";
}

watch([() => props.open, () => props.mode, () => props.conversationId, () => props.file], () => {
  reset();
  active.value = props.open;
  if (props.open && props.conversationId && props.conversationId > 0) {
    conversationId.value = String(props.conversationId);
  }
  if (props.open && props.mode === "file" && props.file) {
    selectedFile.value = props.file;
    autoUpload();
  }
}, { immediate: true, flush: "sync" });

// Phone: upload starts on selection (board §15 ③) once the owner is known;
// otherwise the owner field stays and the primary button starts it.
function autoUpload(): void {
  const id = normalizedConversationId();
  if (narrow.value && selectedFile.value && Number.isSafeInteger(id) && id > 0) void submitFile();
}
onBeforeUnmount(reset);

function close(): void {
  if (!busy.value) {
    reset();
    emit("close");
  }
}

function chooseFile(): void {
  fileInput.value?.click();
}

function selectFile(event: Event): void {
  selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  error.value = "";
  autoUpload();
}

function normalizedConversationId(): number {
  return Number(conversationId.value.trim());
}

async function submitFile(): Promise<void> {
  if (busy.value || !active.value) return;
  const file = selectedFile.value;
  const validation = validateUploadSelection(normalizedConversationId(), file);
  if (validation || !file) {
    error.value = validation || t("chooseValidFile");
    return;
  }
  const id = normalizedConversationId();
  await save(async (owner) => {
    const credential = await createUpload(id, file);
    lifetime.assertCurrent(owner);
    const refId = await uploadBytes(file, credential.upload, (loaded, total) => {
      if (lifetime.isCurrent(owner)) {
        progress.value = total > 0 ? Math.round((loaded / total) * 100) : 0;
      }
    }, owner.signal);
    lifetime.assertCurrent(owner);
    const checksum = await sha256Hex(file);
    lifetime.assertCurrent(owner);
    return completeUpload(credential.deliverable.id, refId, checksum);
  }, "uploadFailed");
}

async function save(create: (owner: SessionOperation) => Promise<Deliverable>, errorKey: string): Promise<void> {
  if (busy.value || !active.value) return;
  const owner = lifetime.capture();
  busy.value = true;
  error.value = "";
  try {
    const completed = await create(owner);
    lifetime.assertCurrent(owner);
    emit("saved", completed);
    lifetime.assertCurrent(owner);
    reset();
    emit("close");
  } catch (reason) {
    if (lifetime.isCurrent(owner) && !isCancelled(reason)) error.value = t(errorKey);
  } finally {
    if (lifetime.isCurrent(owner)) busy.value = false;
  }
}

async function submitLink(): Promise<void> {
  if (busy.value || !active.value) return;
  const id = normalizedConversationId();
  if (!Number.isSafeInteger(id) || id <= 0) {
    error.value = t("invalidConversation");
    return;
  }
  if (!appName.value.trim()) {
    error.value = t("appNameRequired");
    return;
  }
  try {
    const parsed = new URL(appUrl.value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    error.value = t("invalidHttpUrl");
    return;
  }
  await save(() => createAppLink({ conversationId: id, name: appName.value.trim(), appUrl: appUrl.value.trim() }), "addLinkFailed");
}

async function submitImport(): Promise<void> {
  if (busy.value || !active.value) return;
  const id = normalizedConversationId();
  if (!Number.isSafeInteger(id) || id <= 0) {
    error.value = t("invalidConversation");
    return;
  }
  try {
    const parsed = new URL(importUrl.value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    error.value = t("invalidHttpUrl");
    return;
  }
  await save(() => importDeliverable({
      conversationId: id,
      name: importName.value.trim() || undefined,
      url: importUrl.value.trim(),
    }), "importFailed");
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && active" class="dialog-backdrop" @mousedown.self="close">
      <section class="dialog-card" role="dialog" aria-modal="true" :aria-label="title" @keydown.esc="close">
        <header class="dialog-head">
          <div>
            <span class="eyebrow">DELIVERABLE</span>
            <h2>{{ title }}</h2>
          </div>
          <button class="icon-button" type="button" :aria-label="t('close')" :disabled="busy" @click="close">×</button>
        </header>

        <div class="dialog-body">
          <label class="field">
            <span>{{ t("conversation") }}</span>
            <input v-model="conversationId" inputmode="numeric" autocomplete="off" placeholder="128" :disabled="Boolean(props.conversationId)" />
            <small>{{ t("conversationHint") }}</small>
          </label>

          <template v-if="mode === 'file'">
            <input ref="fileInput" class="visually-hidden" type="file" @change="selectFile" />
            <button class="file-picker" type="button" :disabled="busy" @click="chooseFile">
              <strong>{{ selectedFile ? selectedFile.name : t("chooseFile") }}</strong>
              <span>{{ selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB` : "≤ 100 MB" }}<template v-if="busy"> · {{ t("uploading") }} {{ progress }}%</template></span>
            </button>
            <div v-if="busy" class="progress" :aria-label="`${t('uploading')} ${progress}%`">
              <span :style="{ width: `${progress}%` }" />
            </div>
          </template>

          <template v-else-if="mode === 'app'">
            <label class="field">
              <span>{{ t("appName") }}</span>
              <input v-model="appName" autocomplete="off" placeholder="Data dashboard" />
            </label>
            <label class="field">
              <span>{{ t("appUrl") }}</span>
              <input v-model="appUrl" type="url" autocomplete="off" placeholder="https://example.com/app" />
            </label>
          </template>

          <template v-else>
            <label class="field">
              <span>{{ t("sourceUrl") }}</span>
              <input v-model="importUrl" type="url" autocomplete="off" placeholder="https://example.com/report.pdf" />
            </label>
            <label class="field">
              <span>{{ t("optionalName") }}</span>
              <input v-model="importName" autocomplete="off" placeholder="report.pdf" />
            </label>
          </template>

          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        </div>

        <footer class="dialog-actions">
          <button class="button secondary" type="button" :disabled="busy" @click="close">{{ t("cancel") }}</button>
          <button class="button primary" type="button" :disabled="busy" @click="mode === 'file' ? submitFile() : mode === 'app' ? submitLink() : submitImport()">
            {{ busy ? `${t("uploading")} ${progress || ''}` : mode === "file" ? t("confirmUpload") : mode === "app" ? t("confirmLink") : t("confirmImport") }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgb(15 23 42 / 42%); backdrop-filter: blur(8px); }
.dialog-card { width: min(500px, 100%); overflow: hidden; border: 1px solid rgb(255 255 255 / 70%); border-radius: var(--r-xl); background: var(--bg-card); box-shadow: var(--shadow-xl); animation: scale-in .2s var(--ease-out); }
.dialog-head, .dialog-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 24px; }
.dialog-head { border-bottom: 1px solid var(--border); }
.dialog-head h2 { margin-top: 2px; font-size: 20px; line-height: 1.3; }
.eyebrow { color: var(--accent); font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .15em; }
.icon-button { width: 34px; height: 34px; border: 0; border-radius: var(--r-md); color: var(--text-secondary); background: var(--bg-subtle); font-size: 22px; cursor: pointer; }
.dialog-body { display: grid; gap: 18px; padding: 24px; }
.field { display: grid; gap: 7px; color: var(--text-primary); font-size: 13px; font-weight: 650; }
.field input { width: 100%; height: 42px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--r-md); color: var(--text-primary); background: var(--bg-card); }
.field input:focus { border-color: var(--teal-400); box-shadow: 0 0 0 3px rgb(20 184 166 / 10%); outline: 0; }
.field small { color: var(--text-tertiary); font-size: 11px; font-weight: 500; }
.file-picker { display: grid; gap: 4px; min-height: 96px; place-content: center; padding: 18px; border: 1px dashed var(--teal-400); border-radius: var(--r-lg); color: var(--text-primary); background: var(--grad-brand-soft); cursor: pointer; }
.file-picker span { color: var(--text-secondary); font-size: 12px; }
.progress { height: 5px; overflow: hidden; border-radius: var(--r-full); background: var(--slate-100); }
.progress span { display: block; height: 100%; border-radius: inherit; background: var(--grad-teal-indigo); transition: width .18s var(--ease); }
.form-error { padding: 10px 12px; border-radius: var(--r-md); color: #be123c; background: #fff1f2; font-size: 12px; }
.dialog-actions { justify-content: flex-end; border-top: 1px solid var(--border); background: var(--slate-50); }
.button { min-height: 40px; padding: 0 17px; border: 1px solid transparent; border-radius: var(--r-md); font-weight: 700; white-space: nowrap; cursor: pointer; }
.button:disabled { cursor: not-allowed; opacity: .55; }
.button.secondary { border-color: var(--border); color: var(--text-secondary); background: var(--bg-card); }
.button.primary { color: white; background: var(--grad-teal-indigo); box-shadow: var(--shadow-teal); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
/* Phone: a full-screen page, close top-left, primary action pinned at the bottom (board §15 ③). */
@media (max-width: 1023.98px) {
  .dialog-backdrop { place-items: stretch; padding: 0; backdrop-filter: none; }
  .dialog-card { display: flex; flex-direction: column; width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; animation: none; }
  .dialog-head { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: 4px; min-height: 52px; padding: 4px; }
  .dialog-head > div { grid-column: 2; text-align: center; }
  .dialog-head h2 { overflow: hidden; font-size: 17px; text-overflow: ellipsis; white-space: nowrap; }
  .dialog-head .eyebrow { display: none; }
  .icon-button { grid-column: 1; grid-row: 1; width: 44px; height: 44px; background: transparent; }
  .dialog-body { flex: 1; align-content: start; overflow-y: auto; padding: 16px; }
  .field input { height: 48px; font-size: 16px; }
  .file-picker { min-height: 72px; place-content: center start; text-align: left; }
  .file-picker strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dialog-actions { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: var(--bg-card); }
  .dialog-actions .secondary { display: none; }
  .dialog-actions .primary { flex: 1; min-height: 52px; font-size: 16px; }
}
</style>
