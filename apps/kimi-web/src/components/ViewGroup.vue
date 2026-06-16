<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PaneKey } from '../types';
import TabBar from './TabBar.vue';

const props = defineProps<{
  active: PaneKey;
  changesCount?: number;
  canClose?: boolean;
  /** This group currently hosts a preview pane → show its 'preview' tab. */
  hasPreview?: boolean;
  /** This group currently hosts a BTW side chat → show its 'btw' tab. */
  hasBtw?: boolean;
  /** Stable id of this pane group, used to link the tablist to its tabpanel. */
  groupId?: string;
}>();

const emit = defineEmits<{
  select: [pane: PaneKey];
  split: [dir: 'row' | 'col'];
  close: [];
}>();

const { t } = useI18n();

// Tabpanel id derived from the group id so each split pane has a unique
// tablist ↔ tabpanel relationship (aria-controls / aria-labelledby).
const panelId = computed(() => (props.groupId ? `pane-${props.groupId}` : undefined));
const panelLabelledBy = computed(() =>
  panelId.value ? `${panelId.value}__${props.active}` : undefined,
);
</script>

<template>
  <section class="view-group">
    <div class="view-tabs">
      <TabBar
        :active="active"
        :changes-count="changesCount"
        :has-preview="hasPreview"
        :has-btw="hasBtw"
        :panel-id="panelId"
        @select="emit('select', $event)"
      />
      <div class="view-actions">
        <button type="button" class="view-btn" :title="t('workspace.splitRight')" :aria-label="t('workspace.splitRight')" @click="emit('split', 'row')">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M8 3v10"/></svg>
        </button>
        <button type="button" class="view-btn" :title="t('workspace.splitDown')" :aria-label="t('workspace.splitDown')" @click="emit('split', 'col')">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M2.5 8h11"/></svg>
        </button>
        <button v-if="canClose" type="button" class="view-btn" :title="t('workspace.closeGroup')" :aria-label="t('workspace.closeGroup')" @click="emit('close')">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
    </div>
    <div
      class="view-body"
      :id="panelId"
      role="tabpanel"
      :aria-labelledby="panelLabelledBy"
    >
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
  width: 28px;
  height: 28px;
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
.view-btn:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}
.view-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
