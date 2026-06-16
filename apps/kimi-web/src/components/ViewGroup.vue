<script setup lang="ts">
import type { PaneKey } from '../types';
import TabBar from './TabBar.vue';

defineProps<{
  active: PaneKey;
  changesCount?: number;
  canClose?: boolean;
  /** This group currently hosts a preview pane → show its 'preview' tab. */
  hasPreview?: boolean;
  /** This group currently hosts a BTW side chat → show its 'btw' tab. */
  hasBtw?: boolean;
}>();

const emit = defineEmits<{
  select: [pane: PaneKey];
  split: [dir: 'row' | 'col'];
  close: [];
}>();
</script>

<template>
  <section class="view-group">
    <div class="view-tabs">
      <TabBar
        :active="active"
        :changes-count="changesCount"
        :has-preview="hasPreview"
        :has-btw="hasBtw"
        @select="emit('select', $event)"
      />
      <div class="view-actions">
        <button type="button" class="view-btn" title="Split right" @click="emit('split', 'row')">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M8 3v10"/></svg>
        </button>
        <button type="button" class="view-btn" title="Split down" @click="emit('split', 'col')">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M2.5 8h11"/></svg>
        </button>
        <button v-if="canClose" type="button" class="view-btn" title="Close group" @click="emit('close')">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
    </div>
    <div class="view-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.view-group {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.view-tabs {
  flex: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  border-bottom: 1px solid var(--line);
}
.view-tabs :deep(.tabs) {
  border-bottom: none;
}
.view-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  background: var(--panel);
}
.view-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.view-btn:hover {
  color: var(--ink);
  background: var(--panel2);
}
.view-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
