<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfirmDialog, usePanelTabDrag } from '@moonshot-ai/app-client/composables';
import { panelCloseTargets } from '@moonshot-ai/app-client/panel';
import { PanelContextMenu } from '@moonshot-ai/app-components';
import { createTerminalCloseGuard } from '../../lib/terminalCloseGuard';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import type { SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import { useNativeTerminal, type NativeTerminalTab } from '../../composables/useNativeTerminal';
import { bottomPanelDropTargets, rightPanelDropTargets, useTabBarDropTarget } from '../../lib/terminalTabDropTarget';
import { panelTabCloseAction, panelTabContextItems, usePanelTabContextMenu } from '../../lib/panelTabContextMenu';
import TerminalView from './TerminalView.vue';

const props = defineProps<{ cwd: string | null }>();
const emit = defineEmits<{
  quoteAction: [payload: SelectionActionPayload];
  moveToPanel: [id: string, index: number];
}>();

const store = useNativeTerminal();
const { t } = useI18n();
const { confirm } = useConfirmDialog();
const approveClose = createTerminalCloseGuard({ inspect: ids => store.inspect(ids), confirm, t });
async function closeTab(tab: NativeTerminalTab): Promise<void> {
  await closeTabs([tab]);
}
async function closeTabs(tabs: NativeTerminalTab[]): Promise<void> {
  if (tabs.length === 0) return;
  const context = store.currentKey.value;
  if (!await approveClose(tabs.map(tab => ({ id: tab.id, title: tab.binary ?? tab.shell, ptyId: tab.id })))) return;
  if (store.currentKey.value !== context) return;
  for (const tab of tabs) store.closeTab(tab.id);
  const active = store.activeTabId.value;
  if (active !== null) activateAndFocus(active);
}

const activeTab = computed<NativeTerminalTab | null>(
  () => store.tabs.value.find((tab) => tab.id === store.activeTabId.value) ?? null,
);

function newTab(): void {
  if (store.tabs.value.length === 0) {
    store.ensureTab(props.cwd ?? undefined);
    focusFirstTabWhenLanded();
    return;
  }
  void store.newTab(props.cwd ?? undefined).then((tab) => {
    if (tab !== null) activateAndFocus(tab.id);
  });
}

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

const toolbarEl = ref<HTMLElement | null>(null);
const tabsEl = ref<HTMLElement | null>(null);
const externalDropLeft = useTabBarDropTarget(bottomPanelDropTargets, toolbarEl, tabsEl, () => store.open.value);
const drag = usePanelTabDrag({
  tabs: () => store.tabs.value,
  container: tabsEl,
  enabled: () => store.open.value,
  move: (id, index) => store.moveTab(id, index),
  start: () => contextMenu.close(),
  external: {
    hover: (x, y) => rightPanelDropTargets.hover(x, y),
    clear: () => rightPanelDropTargets.clear(),
    commit: (id, index) => emit('moveToPanel', id, index),
  },
});
const contextMenu = usePanelTabContextMenu({
  id: 'terminal-tabs.context',
  items: (tabId) => panelTabContextItems(t, {
    index: store.tabs.value.findIndex(tab => tab.id === tabId),
    count: store.tabs.value.length,
    move: 'right',
  }),
  select: selectContextAction,
  trigger: (tabId) => tabEls.get(tabId),
});
const contextMenuRef = contextMenu.menuRef;
watch(() => [store.currentKey.value, ...store.tabs.value.map(tab => tab.id)].join(','), () => contextMenu.close());
watch(() => store.open.value, () => contextMenu.close());
function selectContextAction(action: string, id: string): void {
  if (!store.tabs.value.some(tab => tab.id === id)) return;
  if (action === 'move') { emit('moveToPanel', id, Number.MAX_SAFE_INTEGER); return; }
  const close = panelTabCloseAction(action);
  if (close !== undefined) void closeTabs(panelCloseTargets(store.tabs.value, close, id));
}
function openContextMenu(id: string, x: number, y: number, keyboard = false): void {
  contextMenu.show(id, x, y, keyboard);
}
function activateFromClick(id: string): void {
  if (!drag.consumeClick()) activateAndFocus(id);
}
function viewsInStableOrder(tabs: readonly NativeTerminalTab[]): NativeTerminalTab[] {
  return [...tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

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
  void nextTick(() => {
    viewRefs.get(id)?.focus();
  });
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  const tabs = store.tabs.value;
  if (event.isComposing) return;
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const tab = tabs[index];
    if (tab === undefined) return;
    event.preventDefault();
    store.moveTab(tab.id, index + (event.key === 'ArrowLeft' ? -1 : 1));
    void nextTick(() => tabEls.get(tab.id)?.focus());
    return;
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const tab = tabs[index];
    const rect = tab && tabEls.get(tab.id)?.getBoundingClientRect();
    if (tab && rect) {
      event.preventDefault();
      openContextMenu(tab.id, rect.x, rect.bottom, true);
    }
    return;
  }
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
    <PanelContextMenu ref="contextMenuRef" :items="contextMenu.items.value" @select="contextMenu.select" />
    <div ref="toolbarEl" class="tp-toolbar" :class="{ 'is-drop-target': externalDropLeft !== null }" role="toolbar" :aria-label="t('terminal.toolbarAria')">
      <div ref="tabsEl" class="tp-tabs" :class="{ 'is-reordering': drag.draggingId.value !== null }" role="tablist">
        <span v-if="drag.indicatorLeft.value !== null" class="tp-drop-indicator" :style="{ left: `${drag.indicatorLeft.value}px` }" aria-hidden="true" />
        <span v-if="externalDropLeft !== null" class="tp-drop-indicator" :style="{ left: `${externalDropLeft}px` }" aria-hidden="true" />
        <div
          v-for="(tab, index) in store.tabs.value"
          :key="tab.id"
          class="tp-tab"
          :class="{ active: tab.id === store.activeTabId.value, exited: tab.status === 'exited', 'is-dragging': tab.id === drag.draggingId.value }"
          :data-panel-tab-id="tab.id"
          :style="drag.styleFor(tab.id)"
          @contextmenu.prevent.stop="openContextMenu(tab.id, $event.clientX, $event.clientY)"
        >
          <button
            :ref="setTabRef(tab.id)"
            type="button"
            class="tp-tab-main"
            role="tab"
            :aria-selected="tab.id === store.activeTabId.value"
            :tabindex="tab.id === store.activeTabId.value ? 0 : -1"
            :title="tab.cwd"
            @click="activateFromClick(tab.id)"
            @pointerdown="drag.onPointerDown($event, tab.id)"
            @dragstart.prevent
            @keydown="onTabKeydown($event, index)"
          >
            <Icon name="terminal" size="sm" class="tp-tab-icon" />
            <span class="tp-tab-label">{{ tab.binary ?? tab.shell }}</span>
          </button>
          <Tooltip :text="t('terminal.closeTab')">
            <button
              type="button"
              class="tp-tab-close"
              :aria-label="t('terminal.closeTab')"
              @click="closeTab(tab)"
            >
              <Icon name="close" size="sm" />
            </button>
          </Tooltip>
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
      <template v-for="bucket in store.bucketsWithTabs.value" :key="bucket.key">
        <TerminalView
          v-for="tab in viewsInStableOrder(bucket.tabs)"
          v-show="bucket.key === store.currentKey.value && tab.id === bucket.activeTabId"
          :key="tab.id"
          :ref="setViewRef(tab.id)"
          :tab-id="tab.id"
          :active="bucket.key === store.currentKey.value && tab.id === bucket.activeTabId"
          @quote-action="emit('quoteAction', $event)"
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
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.tp-toolbar.is-drop-target {
  background: var(--color-hover);
}
.tp-tabs {
  position: relative;
  isolation: isolate;
  height: 100%;
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
.tp-tabs.is-reordering .tp-tab {
  transition: transform var(--duration-fast) var(--ease-in-out), background var(--duration-fast) var(--ease-out);
}
.tp-tabs.is-reordering .tp-tab.is-dragging {
  z-index: var(--z-dropdown);
  background: var(--color-selected-hover);
  transition: none;
}
.tp-tab.is-dragging .tp-tab-main {
  cursor: grabbing;
}
.tp-drop-indicator {
  position: absolute;
  top: 50%;
  width: var(--space-05);
  height: var(--space-6);
  border-radius: var(--radius-full);
  background: var(--color-text-muted);
  transform: translate(-50%, -50%);
  transition: left var(--duration-fast) var(--ease-in-out);
  z-index: var(--z-sticky);
  pointer-events: none;
}
.tp-tab {
  position: relative;
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
.tp-tab.is-drag-ghost {
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: var(--shadow-md);
}
.tp-tab-main {
  touch-action: pan-x;
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
