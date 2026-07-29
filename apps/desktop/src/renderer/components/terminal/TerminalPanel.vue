<!-- apps/desktop/src/renderer/components/terminal/TerminalPanel.vue -->
<!-- Desktop-only: the bottom terminal panel — a tab strip over the xterm -->
<!-- views. State lives in composables/useNativeTerminal.ts; pure presentation. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/web-ui';
import { useNativeTerminal, type NativeTerminalTab } from '../../composables/useNativeTerminal';
import TerminalView from './TerminalView.vue';

const props = defineProps<{ cwd: string | null }>();

const store = useNativeTerminal();
const { t } = useI18n();

const activeTab = computed<NativeTerminalTab | null>(
  () => store.tabs.value.find((tab) => tab.id === store.activeTabId.value) ?? null,
);

function newTab(): void {
  // No tabs yet: ensureTab owns the first spawn (inflight-deduped).
  if (store.tabs.value.length === 0) {
    store.ensureTab(props.cwd ?? undefined);
    focusFirstTabWhenLanded();
    return;
  }
  void store.newTab(props.cwd ?? undefined).then((tab) => {
    if (tab !== null) activateAndFocus(tab.id);
  });
}

// ensureTab is fire-and-forget: focus the tab once it lands (the view's own
// helper bails inside .tp). One pending watcher max — retries must not pile up.
let focusFirstTabStop: (() => void) | null = null;
function focusFirstTabWhenLanded(): void {
  focusFirstTabStop?.();
  focusFirstTabStop = watch(
    () => store.tabs.value.length,
    (len) => {
      if (len === 0) return;
      focusFirstTabStop?.();
      focusFirstTabStop = null;
      const first = store.tabs.value[0];
      if (first !== undefined) activateAndFocus(first.id);
    },
  );
}
onUnmounted(() => {
  focusFirstTabStop?.();
  focusFirstTabStop = null;
});

function restartActive(): void {
  const tab = activeTab.value;
  if (tab !== null) void store.restartTab(tab.id);
}

// Roving tabindex + arrow-key model for the tablist (§08): ←/→/Home/End move
// selection and focus; clicks hand focus to the xterm itself.
const tabEls = new Map<string, HTMLElement>();
const viewRefs = new Map<string, { focus: () => void }>();

function setTabRef(id: string): (el: unknown) => void {
  return (el: unknown) => {
    if (el instanceof HTMLElement) {
      tabEls.set(id, el);
    } else {
      tabEls.delete(id);
    }
  };
}

function setViewRef(id: string): (el: unknown) => void {
  return (el: unknown) => {
    if (el !== null && typeof el === 'object' && typeof (el as { focus?: unknown }).focus === 'function') {
      viewRefs.set(id, el as { focus: () => void });
    } else {
      viewRefs.delete(id);
    }
  };
}

function activateAndFocus(id: string): void {
  store.activateTab(id);
  // Wait for the v-show flip before focusing the newly-active view.
  void nextTick(() => {
    viewRefs.get(id)?.focus();
  });
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  const tabs = store.tabs.value;
  let target: number | null = null;
  if (event.key === 'ArrowLeft') target = Math.max(0, index - 1);
  else if (event.key === 'ArrowRight') target = Math.min(tabs.length - 1, index + 1);
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = tabs.length - 1;
  else return;
  event.preventDefault();
  const next = tabs[target];
  if (next === undefined || target === index) return;
  store.activateTab(next.id);
  tabEls.get(next.id)?.focus();
}
</script>

<template>
  <div class="tp">
    <div class="tp-toolbar" role="toolbar" :aria-label="t('terminal.toolbarAria')">
      <div class="tp-tabs" role="tablist">
        <div
          v-for="(tab, index) in store.tabs.value"
          :key="tab.id"
          class="tp-tab"
          :class="{ active: tab.id === store.activeTabId.value, exited: tab.status === 'exited' }"
        >
          <button
            :ref="setTabRef(tab.id)"
            type="button"
            class="tp-tab-main"
            role="tab"
            :aria-selected="tab.id === store.activeTabId.value"
            :tabindex="tab.id === store.activeTabId.value ? 0 : -1"
            :title="tab.cwd"
            @click="activateAndFocus(tab.id)"
            @keydown="onTabKeydown($event, index)"
          >
            <Icon name="terminal" size="sm" class="tp-tab-icon" />
            <span class="tp-tab-label">{{ tab.shell }}</span>
          </button>
          <button
            type="button"
            class="tp-tab-close"
            :aria-label="t('terminal.closeTab')"
            @click="store.closeTab(tab.id)"
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
        <button
          type="button"
          class="tp-action"
          :title="t('terminal.newTab')"
          :aria-label="t('terminal.newTab')"
          @click="newTab"
        >
          <Icon name="plus" size="sm" />
        </button>
      </div>
      <span v-if="store.error.value" class="tp-error">{{ store.error.value }}</span>
      <div class="tp-tail">
        <button
          v-if="activeTab?.status === 'exited'"
          type="button"
          class="tp-action"
          :title="t('terminal.restartTab')"
          :aria-label="t('terminal.restartTab')"
          @click="restartActive"
        >
          <Icon name="undo" size="sm" />
        </button>
        <button
          type="button"
          class="tp-action"
          :title="t('terminal.collapse')"
          :aria-label="t('terminal.collapse')"
          @click="store.closePanel()"
        >
          <Icon name="chevron-down" size="sm" />
        </button>
      </div>
    </div>
    <div class="tp-body">
      <!-- Every bucket with tabs keeps its xterm views MOUNTED (v-show) so a
           session round trip preserves scrollback; only the current bucket's
           active tab is visible. -->
      <template v-for="bucket in store.bucketsWithTabs.value" :key="bucket.key">
        <TerminalView
          v-for="tab in bucket.tabs"
          v-show="bucket.key === store.currentKey.value && tab.id === bucket.activeTabId"
          :key="tab.id"
          :ref="setViewRef(tab.id)"
          :tab-id="tab.id"
          :active="bucket.key === store.currentKey.value && tab.id === bucket.activeTabId"
        />
      </template>
      <button
        v-if="store.tabs.value.length === 0"
        type="button"
        class="tp-empty"
        @click="newTab"
      >
        {{ t('terminal.empty') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tp {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}
.tp-toolbar {
  flex: none;
  height: var(--space-8);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2);
  border-bottom: 0.5px solid var(--color-line);
}
.tp-tabs {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-05);
  overflow-x: auto;
  scrollbar-width: none;
}
.tp-tabs::-webkit-scrollbar {
  display: none;
}
.tp-tab {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0;
  height: var(--space-6);
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--ui-font-size-sm);
}
.tp-tab:hover {
  background: var(--color-hover);
}
.tp-tab.active {
  background: var(--color-selected);
  color: var(--color-text);
}
.tp-tab-main {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: var(--font-ui);
  font-size: inherit;
  cursor: pointer;
}
.tp-tab-icon {
  flex: none;
  color: var(--color-text-muted);
}
.tp-tab.active .tp-tab-icon {
  color: var(--color-text);
}
.tp-tab.exited .tp-tab-icon {
  color: var(--color-text-faint);
}
.tp-tab-label {
  max-width: calc(var(--space-8) * 5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
}
.tp-tab-close :deep(svg) {
  width: var(--space-3);
  height: var(--space-3);
}
.tp-tab-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.tp-action {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.tp-action:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.tp-error {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-danger);
  font-size: var(--ui-font-size-xs);
}
.tp-tail {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-05);
}
.tp-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.tp-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
}
.tp-empty:hover {
  color: var(--color-text-muted);
}
</style>
