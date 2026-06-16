<!-- apps/kimi-web/src/components/TabBar.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PaneKey } from '../types';

const props = defineProps<{
  active: PaneKey;
  changesCount?: number;
  mobile?: boolean;
  hasPreview?: boolean;
  hasBtw?: boolean;
}>();
const emit = defineEmits<{ select: [pane: PaneKey] }>();

const { t } = useI18n();

const BASE_TABS: { key: PaneKey; labelKey: string }[] = [
  { key: 'chat', labelKey: 'sidebar.tabChat' },
  { key: 'files', labelKey: 'sidebar.tabFiles' },
];

// 'preview' and 'btw' are transient tabs — shown only while the group hosts them.
const tabs = computed(() => {
  const extra: { key: PaneKey; labelKey: string }[] = [];
  if (props.hasBtw) extra.push({ key: 'btw', labelKey: 'sidebar.tabBtw' });
  if (props.hasPreview) extra.push({ key: 'preview', labelKey: 'sidebar.tabPreview' });
  return [...BASE_TABS, ...extra];
});
</script>

<template>
  <div class="tabs" :class="{ mobile }">
    <div class="tabs-left">
      <div
        v-for="tab in tabs"
        :key="tab.key"
        class="tb"
        :class="{ on: active === tab.key }"
        @click="emit('select', tab.key)"
      >
        {{ t(tab.labelKey) }}
        <span v-if="tab.key === 'files' && (changesCount ?? 0) > 0" class="d"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  height: 32px;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.tabs-left {
  display: flex;
  align-items: stretch;
}
.tb {
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--dim);
  border-right: 1px solid var(--line);
  cursor: pointer;
}
.tb:hover {
  background: var(--panel2);
}
.tb.on {
  /* Merge the active tab into the content surface below (dark-mode safe). */
  background: var(--bg);
  color: var(--blue2);
  font-weight: 600;
}
.d {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
/* ---- Mobile swap-strip: full-width mono tabs, 46px tall (≥44px tap) ---- */
.tabs.mobile {
  height: 46px;
  background: var(--bg);
}
.tabs.mobile .tb {
  flex: 1;
  justify-content: center;
  gap: 5px;
  padding: 0 2px;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) + 0.5px);
  color: var(--muted);
  border-right: none;
  border-bottom: none;
  /* Three flex:1 tabs + a "10/12" pill must not blow up tiny screens. */
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.tabs.mobile .tb:hover { background: var(--bg); }
.tabs.mobile .tb.on {
  background: var(--bg);
  color: var(--blue);
  font-weight: 600;
}
/* Diff → small warn dot (prototype .dt). */
.tabs.mobile .d {
  width: 6px;
  height: 6px;
  background: var(--warn);
}

/* NOTE: Modern-theme tab styles live in src/style.css (global). Scoped
   `:global(html[data-theme=modern]) .tb` rules here did NOT win the cascade
   (tabs stayed square + bordered), so they were moved to the global sheet. */
</style>
