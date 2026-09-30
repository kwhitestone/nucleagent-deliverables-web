<script lang="ts">
/** Bottom sheet of action rows (board §15 ② / ⑤). Phone only; the panel never opens it on desktop. */
export interface SheetAction {
  label: string;
  /** SVG path data (24×24 line icon). */
  icon?: string;
  danger?: boolean;
  center?: boolean;
  run: () => void;
}
</script>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

const props = defineProps<{ open: boolean; title: string; groups: SheetAction[][] }>();
const emit = defineEmits<{ close: [] }>();
const sheet = ref<HTMLElement | null>(null);

watch(() => props.open, async (open) => {
  if (!open) return;
  await nextTick();
  sheet.value?.querySelector<HTMLElement>("button")?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-scrim" @click.self="emit('close')" @keydown.esc="emit('close')">
      <section ref="sheet" class="sheet" role="dialog" aria-modal="true" :aria-label="title">
        <div class="sheet-grab" aria-hidden="true" />
        <h2 class="sheet-title">{{ title }}</h2>
        <div v-for="(group, index) in groups" :key="index" class="sheet-group">
          <button
            v-for="action in group"
            :key="action.label"
            class="sheet-row"
            :class="{ danger: action.danger, center: action.center }"
            type="button"
            @click="action.run()"
          >
            <svg v-if="action.icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="action.icon" /></svg>
            <span>{{ action.label }}</span>
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-scrim { position: fixed; inset: 0; z-index: 110; display: flex; align-items: flex-end; background: rgb(15 23 42 / 42%); }
.sheet { width: 100%; max-height: 85vh; overflow-y: auto; padding: 8px 0 calc(12px + env(safe-area-inset-bottom)); border-radius: var(--r-xl) var(--r-xl) 0 0; background: var(--bg-subtle); animation: fade-in-up .2s var(--ease-out); }
.sheet-grab { width: 36px; height: 5px; margin: 0 auto 8px; border-radius: 3px; background: var(--border-strong); }
.sheet-title { overflow: hidden; padding: 0 20px 10px; color: var(--text-primary); font-size: 17px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.sheet-group { overflow: hidden; margin: 0 16px 12px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-card); }
.sheet-row { display: flex; align-items: center; width: 100%; min-height: 52px; gap: 12px; padding: 8px 16px; border: 0; color: var(--text-primary); background: transparent; font-size: 15px; text-align: left; cursor: pointer; }
.sheet-row + .sheet-row { border-top: 1px solid var(--border); }
.sheet-row svg { width: 18px; height: 18px; flex: none; fill: none; stroke: var(--text-tertiary); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.sheet-row.center { justify-content: center; font-weight: 650; }
.sheet-row.danger { justify-content: center; color: #be123c; font-weight: 650; }
</style>
