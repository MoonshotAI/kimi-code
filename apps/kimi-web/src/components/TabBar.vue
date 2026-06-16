<!-- apps/kimi-web/src/components/TabBar.vue -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PaneKey } from '../types';

const props = defineProps<{
  active: PaneKey;
  changesCount?: number;
  mobile?: boolean;
  hasPreview?: boolean;
  hasBtw?: boolean;
  /** Id of the tabpanel these tabs control (enables aria-controls / tab ids). */
  panelId?: string;
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

function tabId(key: PaneKey): string | undefined {
  return props.panelId ? `${props.panelId}__${key}` : undefined;
}

const tablistEl = ref<HTMLElement | null>(null);

function focusTab(key: PaneKey): void {
  void nextTick(() => {
    tablistEl.value?.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)?.focus();
  });
}

// Roving-tabindex keyboard navigation: Left/Right move (and activate) the
// adjacent tab, wrapping at the ends; Home/End jump to the first/last.
function onKeydown(event: KeyboardEvent): void {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const list = tabs.value;
  if (list.length === 0) return;
  const cur = Math.max(0, list.findIndex((tb) => tb.key === props.active));
  let next = cur;
  if (event.key === 'ArrowLeft') next = (cur - 1 + list.length) % list.length;
  else if (event.key === 'ArrowRight') next = (cur + 1) % list.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = list.length - 1;
  const tab = list[next];
  if (!tab) return;
  if (tab.key !== props.active) emit('select', tab.key);
  focusTab(tab.key);
}
</script>

<template>
  <div class="tabs" :class="{ mobile }">
    <div
      ref="tablistEl"
      class="tabs-left"
      role="tablist"
      :aria-label="t('sidebar.tablistLabel')"
      :aria-orientation="'horizontal'"
      @keydown="onKeydown"
    >
      <button
        v-for="tab in tabs"
        :key="tab.key"
        :id="tabId(tab.key)"
        type="button"
        class="tb"
        role="tab"
        :data-tab-key="tab.key"
        :class="{ on: active === tab.key }"
        :aria-selected="active === tab.key"
        :aria-controls="panelId || undefined"
        :tabindex="active === tab.key ? 0 : -1"
        @click="emit('select', tab.key)"
      >
        {{ t(tab.labelKey) }}
        <span v-if="tab.key === 'files' && (changesCount ?? 0) > 0" class="d" aria-hidden="true"></span>
      </button>
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
  appearance: none;
  font: inherit;
  box-sizing: border-box;
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--dim);
  background: transparent;
  border: none;
  border-right: 1px solid var(--line);
  cursor: pointer;
}
.tb:hover {
  background: var(--panel2);
}
.tb:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
  border-radius: 2px;
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
.tabs.mobile .tabs-left {
  flex: 1;
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
