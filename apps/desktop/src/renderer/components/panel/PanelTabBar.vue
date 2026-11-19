<script setup lang="ts">
import { browserApprovalBrowserIds } from '../../lib/browserPageDialogs';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Favicon, Icon, IconButton, Kbd, Menu, MenuItem, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import { panelRegistry, type BrowserTabPayload, type PanelLauncherType, type TermTabPayload } from '@moonshot-ai/app-client/panel';
import { useIsMobile, usePanelTabDrag, type PanelTab } from '@moonshot-ai/app-client/composables';
import { PanelContextMenu, PanelTabLabel } from '@moonshot-ai/app-components';
import { panelLauncherItems } from '../../lib/panelLauncher';
import { registerBrowserOverlayMenu } from '../../lib/browserOverlayMenu';
import { browserTabMenuItems, isBrowserTabAction, type BrowserTabAction } from '../../lib/browserTabMenu';
import { focusAfterTabClose, focusClosedPanelToggle } from './tabCloseFocus';
import { panelTabContextItems, usePanelTabContextMenu } from '../../lib/panelTabContextMenu';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { bottomPanelDropTargets, rightPanelDropTargets, useTabBarDropTarget } from '../../lib/terminalTabDropTarget';

const props = defineProps<{
  tabs: PanelTab[];
  activeTabId: string | null;
  revealedTabId?: string | null;
  expanded: boolean;
  visible: boolean;
  canExpand: boolean;
  canOpenDiff: boolean;
  canOpenFiles: boolean;
  canOpenTerm: boolean;
  canOpenBrowser: boolean;
  canForkBrowser: boolean;
  browserStates: Record<string, { url: string; muted?: boolean }>;
  canOpenBtw: boolean;
}>();

const emit = defineEmits<{
  activate: [id: string];
  move: [id: string, index: number];
  moveToBottom: [id: string, index: number];
  close: [id: string];
  add: [type: PanelLauncherType];
  browserTabAction: [
    tabId: string,
    action: BrowserTabAction,
  ];
  closeOthers: [id: string];
  closeToRight: [id: string];
  closeAll: [];
  toggleExpanded: [];
  hide: [];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();

const pendingBrowserIds = computed(() => new Set(browserApprovalBrowserIds.value));

function awaitsPermission(tab: PanelTab): boolean {
  return tab.type === 'browser' && pendingBrowserIds.value.has((tab.payload as BrowserTabPayload).browserId);
}

function iconOf(tab: PanelTab): string {
  return panelRegistry[tab.type].icon;
}

function controlStatus(tab: PanelTab): 'running' | 'paused' | 'unknown' | undefined {
  return tab.type === 'browser' ? (tab.payload as BrowserTabPayload | undefined)?.controlled?.status : undefined;
}

function tabTooltipText(tab: PanelTab): string | undefined {
  if (tab.type === 'browser') return awaitsPermission(tab) ? undefined : tab.title;
  return tab.presentation?.title ?? tab.title;
}

function controlLabel(tab: PanelTab): string {
  const status = controlStatus(tab);
  return t(status === 'paused' ? 'browser.controlPaused' : status === 'unknown' ? 'browser.controlUnknown' : 'browser.controlledTab');
}

function browserLoading(tab: PanelTab): boolean {
  return tab.type === 'browser' && (tab.payload as BrowserTabPayload | undefined)?.loading === true;
}

function faviconOf(tab: PanelTab): string | null {
  if (tab.type !== 'browser' || tab.payload === undefined) return null;
  return (tab.payload as BrowserTabPayload).favicon ?? null;
}

const brokenFaviconUrls = ref<ReadonlySet<string>>(new Set());

watch(() => props.tabs.map(tab => [tab.id, faviconOf(tab), browserLoading(tab)] as const), (next, previous = []) => {
  const reset = new Set(next.filter(([id, favicon, loading]) => { const before = previous.find(item => item[0] === id); return !before || before[1] !== favicon || (loading && !before[2]); }).map(item => item[0]));
  brokenFaviconUrls.value = new Set([...brokenFaviconUrls.value].filter(key => next.some(([id]) => key.startsWith(`${id}:`) && !reset.has(id))));
});

function visibleFaviconOf(tab: PanelTab): string | null {
  const favicon = faviconOf(tab);
  return favicon !== null && !brokenFaviconUrls.value.has(`${tab.id}:${favicon}`) ? favicon : null;
}

function onFaviconLoad(tabId: string, event: Event): void {
  if (!(event.currentTarget instanceof HTMLImageElement)) return;
  const source = event.currentTarget.getAttribute('src');
  if (source === null) return;
  const next = new Set(brokenFaviconUrls.value);
  next.delete(`${tabId}:${source}`);
  brokenFaviconUrls.value = next;
}

function onFaviconError(tabId: string, event: Event): void {
  if (!(event.currentTarget instanceof HTMLImageElement)) return;
  const source = event.currentTarget.getAttribute('src');
  if (source !== null) brokenFaviconUrls.value = new Set([...brokenFaviconUrls.value, `${tabId}:${source}`]);
}

const tabsEl = ref<HTMLElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const externalDropLeft = useTabBarDropTarget(rightPanelDropTargets, rootEl, tabsEl, () => props.visible);
const terminalStore = useNativeTerminal();
function isMovableTerminal(id: string): boolean {
  const tab = props.tabs.find(item => item.id === id);
  if (tab?.type !== 'term') return false;
  const ptyId = (tab.payload as TermTabPayload | undefined)?.ptyId;
  return ptyId !== undefined && terminalStore.panelTabOf(ptyId) !== undefined;
}
const drag = usePanelTabDrag({
  tabs: () => props.tabs,
  container: tabsEl,
  enabled: () => props.visible,
  move: (id, index) => emit('move', id, index),
  start: () => { closeContextMenu(); closeAddMenu(); },
  external: {
    hover: (x, y, id) => (isMovableTerminal(id) ? bottomPanelDropTargets.hover(x, y) : null),
    clear: () => bottomPanelDropTargets.clear(),
    commit: (id, index) => emit('moveToBottom', id, index),
  },
});
function activateFromClick(id: string): void {
  if (!drag.consumeClick()) emit('activate', id);
}
watch(
  () => props.activeTabId,
  async () => {
    await nextTick();
    tabsEl.value
      ?.querySelector('.ptb-tab.on')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  },
);

const tabEls = new Map<string, HTMLElement>();
function setTabRef(id: string): (el: unknown) => void {
  return (el: unknown) => {
    if (el instanceof HTMLElement) {
      tabEls.set(id, el);
    } else {
      tabEls.delete(id);
    }
  };
}

const enteringTabIds = ref<ReadonlySet<string>>(new Set());
watch(
  () => props.revealedTabId,
  async (id) => {
    if (id === null || id === undefined) return;
    enteringTabIds.value = new Set([...enteringTabIds.value, id]);
    await nextTick();
    tabEls.get(id)?.closest('.ptb-tab')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  },
);
function onTabAnimationEnd(id: string, event: AnimationEvent): void {
  if (event.target !== event.currentTarget || event.pseudoElement !== '' || !enteringTabIds.value.has(id)) return;
  const next = new Set(enteringTabIds.value);
  next.delete(id);
  enteringTabIds.value = next;
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  const tabs = props.tabs;
  if (event.isComposing) return;
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const tab = tabs[index];
    if (!tab) return;
    event.preventDefault();
    emit('move', tab.id, index + (event.key === 'ArrowLeft' ? -1 : 1));
    void nextTick(() => tabEls.get(tab.id)?.focus());
    return;
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const tab = tabs[index];
    const rect = tab && tabEls.get(tab.id)?.getBoundingClientRect();
    if (tab && rect) {
      event.preventDefault();
      openContextMenu(tab, rect.x, rect.bottom, true);
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
  emit('activate', next.id);
  tabEls.get(next.id)?.focus();
}

const contextMenu = usePanelTabContextMenu({
  id: 'panel-tabs.context',
  items: (tabId) => panelTabContextItems(t, {
    index: props.tabs.findIndex(tab => tab.id === tabId),
    count: props.tabs.length,
    move: tabId !== null && isMovableTerminal(tabId) ? 'bottom' : undefined,
  }),
  select: selectContextAction,
  trigger: (tabId) => tabEls.get(tabId),
});
const contextMenuRef = contextMenu.menuRef;
function selectContextAction(action: string, id: string): void {
  if (!props.tabs.some(tab => tab.id === id)) return;
  if (action === 'move') { if (isMovableTerminal(id)) emit('moveToBottom', id, terminalStore.tabs.value.length); return; }
  if (action === 'close') emit('close', id);
  else if (action === 'close-others') emit('closeOthers', id);
  else if (action === 'close-to-right') emit('closeToRight', id);
  else if (action === 'close-all') emit('closeAll');
  focusAfterTabClose();
}
function openContextMenu(tab: PanelTab, x: number, y: number, keyboard = false): void {
  if (tab.type === 'browser') { openBrowserTabMenu(tab, { x, y }, keyboard ? 'first-item' : 'none'); return; }
  closeAddMenu();
  contextMenu.show(tab.id, x, y, keyboard);
}
function closeContextMenu(): void {
  contextMenu.close();
}
watch(() => props.tabs.map(tab => tab.id).join(','), closeContextMenu);

const fallbackAddOpen = ref(false);
const addBtnRef = ref<InstanceType<typeof IconButton> | null>(null);
const addMenuRef = ref<InstanceType<typeof Menu> | null>(null);

const addOverlayMenu = registerBrowserOverlayMenu({
  id: 'panel-tabs.add',
  width: 220,
  placement: 'bottom-end',

  offset: 4,
  items: () =>
    addItems.value.map((item) => ({
      kind: 'item',
      id: item.type,
      label: item.label,
      icon: item.icon,
      shortcut: item.keys,
      disabled: item.disabled,
    })),
  onSelect: (itemId) => {
    const item = addItems.value.find((candidate) => candidate.type === itemId);
    if (item !== undefined) pickAdd(item.type);
  },
});
const addOpen = computed(() =>
  addOverlayMenu.available ? addOverlayMenu.open.value : fallbackAddOpen.value,
);

let browserContextTabId: string | null = null;
const browserTabOverlayMenu = registerBrowserOverlayMenu({
  id: 'panel-tabs.browser-context',
  width: 280,
  placement: 'bottom-start',
  offset: 0,
  items: () => browserTabMenuItems(t, {
    canOpen: props.canOpenBrowser,
    canFork: props.canForkBrowser,
    hasUrl: Boolean(browserContextTabId && props.browserStates[browserContextTabId]?.url),
    hasWebUrl: browserContextTabId !== null && /^https?:/i.test(props.browserStates[browserContextTabId]?.url ?? ''),
    canCopyUrl: browserContextTabId !== null && /^(https?|file):/i.test(props.browserStates[browserContextTabId]?.url ?? ''),
    muted: Boolean(browserContextTabId && props.browserStates[browserContextTabId]?.muted),
    index: props.tabs.findIndex(tab => tab.id === browserContextTabId), count: props.tabs.length,
  }),
  onSelect: itemId => {
    const tabId = browserContextTabId;
    browserContextTabId = null;
    if (tabId !== null && isBrowserTabAction(itemId)) emit('browserTabAction', tabId, itemId);
  },
});

function openBrowserTabMenu(
  tab: PanelTab,
  point: { x: number; y: number },
  initialFocus: 'none' | 'first-item' = 'none',
): void {
  if (tab.type !== 'browser' || !browserTabOverlayMenu.available) return;
  closeAddMenu();
  browserContextTabId = tab.id;
  const focusReturn = tabEls.get(tab.id);
  browserTabOverlayMenu.showAt(
    { x: Math.max(0, point.x), y: Math.max(0, point.y), width: 0, height: 0 },
    {
      placement: 'bottom-start',
      offset: 0,
      initialFocus,
      ...(focusReturn === undefined ? {} : { focusReturn }),
    },
  );
}

function onTabContextMenu(event: MouseEvent, tab: PanelTab): void {
  if (tab.type !== 'browser' || !browserTabOverlayMenu.available) return;
  event.preventDefault();
  event.stopPropagation();
  openBrowserTabMenu(tab, { x: event.clientX, y: event.clientY });
}

function onDocMousedown(e: MouseEvent): void {
  const target = e.target as Node;
  if (addMenuRef.value?.el?.contains(target) || addBtnRef.value?.el?.contains(target)) return;
  closeAddMenu();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  e.preventDefault();
  closeAddMenu({ refocus: true });
}

function openAddMenu(initialFocus: 'none' | 'first-item' = 'none'): void {
  closeContextMenu();
  if (addOpen.value) return;
  const trigger = addBtnRef.value?.el;
  if (addOverlayMenu.available && trigger !== undefined) {
    addOverlayMenu.show(trigger, { initialFocus });
    return;
  }
  fallbackAddOpen.value = true;
  document.addEventListener('mousedown', onDocMousedown);
  window.addEventListener('keydown', onDocKeydown, true);
  if (initialFocus === 'first-item') {
    void nextTick(() => {
      addMenuRef.value?.el
        ?.querySelector<HTMLElement>('.ui-menu-item:not(:disabled)')
        ?.focus();
    });
  }
}

function openAddMenuFromKeyboard(): void {
  openAddMenu('first-item');
}

function toggleAddMenu(e: MouseEvent): void {
  e.stopPropagation();
  if (addOpen.value) {
    closeAddMenu();
    return;
  }
  openAddMenu();
}

function closeAddMenu(opts?: { refocus?: boolean }): void {
  if (addOverlayMenu.available) {
    addOverlayMenu.close(opts);
    return;
  }
  fallbackAddOpen.value = false;
  document.removeEventListener('mousedown', onDocMousedown);
  window.removeEventListener('keydown', onDocKeydown, true);
  if (opts?.refocus) addBtnRef.value?.el?.focus();
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = Array.from(
    addMenuRef.value?.el?.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)') ?? [],
  );
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

function onMenuFocusLeave(e: FocusEvent): void {
  if (addOverlayMenu.available) return;
  const next = e.relatedTarget as Node | null;
  if (next && (addMenuRef.value?.el?.contains(next) || addBtnRef.value?.el?.contains(next))) return;
  closeAddMenu();
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      closeAddMenu();
      browserTabOverlayMenu.close(); closeContextMenu();
    }
  },
);

watch(
  () => props.activeTabId,
  () => {
    closeAddMenu();
    browserTabOverlayMenu.close(); closeContextMenu();
  },
);

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMousedown);
  window.removeEventListener('keydown', onDocKeydown, true);
});

function pickAdd(type: PanelLauncherType): void {
  closeAddMenu({ refocus: true });
  emit('add', type);
}

function onCloseTab(id: string): void {
  emit('close', id);
  focusAfterTabClose();
}

function onHide(): void {
  emit('hide');
  void nextTick(focusClosedPanelToggle);
}

const openSingletonTypes = computed(
  () => new Set(props.tabs.filter((tab) => panelRegistry[tab.type].policy === 'singleton').map((tab) => tab.type)),
);

const addItems = computed(() =>
  panelLauncherItems(
    {
      diff: props.canOpenDiff,
      files: props.canOpenFiles,
      browser: props.canOpenBrowser,
      term: props.canOpenTerm,
      btw: props.canOpenBtw,
    },
    t,
  ),
);
const addMenuItems = computed(() =>
  addItems.value.filter((item) => panelRegistry[item.type].policy !== 'singleton' || !openSingletonTypes.value.has(item.type)),
);
</script>

<template>
  <div ref="rootEl" class="panel-tab-bar" :class="{ 'is-drop-target': externalDropLeft !== null }">
    <PanelContextMenu ref="contextMenuRef" :items="contextMenu.items.value" @select="contextMenu.select" />
    <div ref="tabsEl" class="ptb-tabs" :class="{ 'is-reordering': drag.draggingId.value !== null }" role="tablist">
      <span v-if="drag.indicatorLeft.value !== null" class="ptb-drop-indicator" :style="{ left: `${drag.indicatorLeft.value}px` }" aria-hidden="true" />
      <span v-if="externalDropLeft !== null" class="ptb-drop-indicator" :style="{ left: `${externalDropLeft}px` }" aria-hidden="true" />
      <div
        v-for="(tab, index) in tabs"
        :key="tab.id"
        class="ptb-tab"
        :class="{ on: tab.id === activeTabId, 'awaiting-permission': awaitsPermission(tab), 'is-dragging': tab.id === drag.draggingId.value, 'is-entering': enteringTabIds.has(tab.id) }"
        :data-panel-tab-id="tab.id"
        :style="drag.styleFor(tab.id)"
        @contextmenu.prevent.stop="openContextMenu(tab, $event.clientX, $event.clientY)"
        @animationend="onTabAnimationEnd(tab.id, $event)"
      >
        <Tooltip :text="drag.draggingId.value === null ? tabTooltipText(tab) : null">
        <button
          :ref="setTabRef(tab.id)"
          type="button"
          class="ptb-tab-main"
          :data-tab-id="tab.id"
          role="tab"
          :aria-selected="tab.id === activeTabId"
          :aria-busy="browserLoading(tab) || undefined"
          :tabindex="tab.id === activeTabId ? 0 : -1"
          :aria-label="awaitsPermission(tab) ? `${tab.title} — ${t('browser.permissionPending')}` : tab.presentation?.title ?? tab.title"
          @click="activateFromClick(tab.id)"
          @pointerdown="drag.onPointerDown($event, tab.id)"
          @dragstart.prevent
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
          @contextmenu="onTabContextMenu($event, tab)"
          @keydown="onTabKeydown($event, index)"
        >
          <template v-if="tab.type === 'browser'">
          <Spinner v-if="browserLoading(tab)" size="sm" :label="t('common.loading')" />
          <Favicon
            v-else-if="visibleFaviconOf(tab)"
            class="ptb-favicon"
            :key="`${tab.id}:${visibleFaviconOf(tab)}`"
            :src="visibleFaviconOf(tab)!"
            draggable="false"
            @load="onFaviconLoad(tab.id, $event)"
            @error="onFaviconError(tab.id, $event)"
          />
          <Icon v-else :name="iconOf(tab)" size="sm" />
          <span class="ptb-t">{{ tab.title }}</span>
          <Tooltip v-if="awaitsPermission(tab)" :text="t('browser.permissionPending')">
            <span class="ptb-permission" role="img" :aria-label="t('browser.permissionPending')">
              <Icon name="alert-triangle" size="sm" aria-hidden="true" />
            </span>
          </Tooltip>
          <Tooltip v-if="controlStatus(tab)" :text="controlLabel(tab)">
            <span class="ptb-control" role="img" :aria-label="controlLabel(tab)">
              <Icon :name="controlStatus(tab) === 'paused' ? 'pause' : controlStatus(tab) === 'unknown' ? 'help-circle' : 'robot'" size="sm" aria-hidden="true" />
            </span>
          </Tooltip>
          </template>
          <PanelTabLabel v-else :title="tab.title" :icon="iconOf(tab)" :presentation="tab.presentation" />
        </button>
        </Tooltip>
        <button
          type="button"
          class="ptb-x"
          :aria-label="t('panel.closeTab')"
          :tabindex="tab.id === activeTabId ? 0 : -1"
          @click="onCloseTab(tab.id)"
        >
          <Icon name="close" size="sm" />
        </button>
      </div>
      <span class="ptb-drag-fill" aria-hidden="true" />
    </div>
    <div class="ptb-tail">
      <IconButton
        ref="addBtnRef"
        size="sm"
        :label="t('panel.newTab')"
        :tooltip="t('panel.newTab')"
        aria-haspopup="menu"
        :aria-expanded="addOpen"
        @click="toggleAddMenu"
        @keydown.down.prevent="openAddMenuFromKeyboard"
        @keydown.up.prevent="openAddMenuFromKeyboard"
        @focusout="onMenuFocusLeave"
      >
        <Icon name="plus" />
      </IconButton>
      <IconButton
        v-if="canExpand && tabs.length > 0"
        size="sm"
        :label="expanded ? t('panel.collapse') : t('panel.expand')"
        :tooltip="expanded ? t('panel.collapse') : t('panel.expand')"
        @click="emit('toggleExpanded')"
      >
        <Icon :name="expanded ? 'collapse' : 'expand'" />
      </IconButton>
      <IconButton
        class="ptb-hide"
        size="sm"
        :label="t('panel.hide')"
        :tooltip="t('panel.hide')"
        @click="onHide"
      >
        <Icon :name="isMobile ? 'close' : 'panel-collapse-right'" />
      </IconButton>
    </div>
    <Menu
      v-if="addOpen && !addOverlayMenu.available"
      ref="addMenuRef"
      class="panel-add-menu"
      @keydown="onMenuKeydown"
      @focusout="onMenuFocusLeave"
    >
      <MenuItem
        v-for="item in addMenuItems"
        :key="item.type"
        :disabled="item.disabled"
        :size="isMobile ? 'lg' : 'md'"
        @click="pickAdd(item.type)"
      >
        <Icon :name="item.icon" />
        {{ item.label }}
        <Kbd v-if="item.keys.length > 0" class="ptb-kbd" :keys="item.keys" />
      </MenuItem>
    </Menu>
  </div>
</template>

<style scoped>
.ptb-control {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--color-text-muted);
}

.panel-tab-bar {
  position: relative;
  height: var(--panel-head-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-05);
  padding: 0 var(--space-4) 0 var(--space-2);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.panel-tab-bar.is-drop-target {
  background: var(--color-hover);
}
.ptb-tabs {
  position: relative;
  isolation: isolate;
  overflow-anchor: none;
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-05);
  padding-inline: var(--browser-permission-glow-gutter);
  overflow-x: auto;
  scrollbar-width: none;
}
.ptb-tabs::-webkit-scrollbar {
  display: none;
}
.ptb-drag-fill {
  flex: 1;
  min-width: 0;
  align-self: stretch;
}
.ptb-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--panel-tab-h);
  padding: 0 var(--space-1-5) 0 var(--panel-tab-pad-x);
  max-width: var(--panel-tab-max-w);
  min-width: 0;
  flex: none;
  border-radius: var(--radius-md);
  background: var(--color-hover);
  color: var(--color-text-muted);
  transition: background var(--duration-fast) var(--ease-out);
}
.ptb-tab:hover {
  background: var(--color-selected);
  color: var(--color-text);
}
.ptb-tab.is-entering {
  animation: ptb-tab-enter var(--duration-base) var(--ease-out);
}
@keyframes ptb-tab-enter {
  from { opacity: 0; transform: translateY(var(--space-1)); }
  to { opacity: 1; transform: none; }
}
.ptb-tab.on {
  background: var(--panel-tab-selected-bg);
  color: var(--color-text);
}
.ptb-tab.awaiting-permission::before {
  content: '';
  position: absolute;
  inset: 0;
  border: var(--browser-permission-border-width) solid var(--browser-permission-border-color);
  border-radius: inherit;
  pointer-events: none;
  animation: browser-permission-breathe var(--browser-permission-breathe-duration) var(--ease-in-out) infinite;
}
.ptb-permission {
  display: inline-flex;
  flex: none;
  color: var(--color-warning);
}
@keyframes browser-permission-breathe {
  0%, 100% { box-shadow: var(--browser-permission-glow-rest); }
  50% { box-shadow: var(--browser-permission-glow-peak); }
}
@media (prefers-reduced-motion: reduce) {
  .ptb-tab.awaiting-permission::before { animation: none; box-shadow: none; }
}
.ptb-tab.on .ptb-tab-main {
  font-weight: var(--weight-medium);
}
.ptb-tab-main {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  white-space: nowrap;
  user-select: none;
  cursor: pointer;
}
.ptb-t {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ptb-favicon {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  flex: none;
  object-fit: contain;
}
.ptb-tabs.is-reordering .ptb-tab {
  transition: transform var(--duration-fast) var(--ease-in-out), background var(--duration-fast) var(--ease-out);
}
.ptb-tabs.is-reordering .ptb-tab.is-dragging {
  z-index: var(--z-dropdown);
  background: var(--color-selected-hover);
  transition: none;
}
.ptb-drop-indicator {
  position: absolute;
  top: 50%;
  width: var(--space-05);
  height: var(--panel-tab-h);
  border-radius: var(--radius-full);
  background: var(--color-text-muted);
  transform: translate(-50%, -50%);
  transition: left var(--duration-fast) var(--ease-in-out);
  z-index: var(--z-sticky);
  pointer-events: none;
}
.ptb-tab.is-dragging .ptb-tab-main {
  cursor: grabbing;
}
.ptb-tab.is-drag-ghost {
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: var(--shadow-md);
}
.ptb-tab-main {
  touch-action: pan-x;
}
.ptb-tab-main:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}
.ptb-x {
  width: var(--panel-tab-x-size);
  height: var(--panel-tab-x-size);
  flex: none;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  color: var(--color-text-faint);
  cursor: pointer;
}
.ptb-x:hover {
  background: var(--color-well);
  color: var(--color-text);
}
.ptb-x:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.ptb-tail {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-05);
  padding-left: var(--space-1);
}
.panel-add-menu {
  position: absolute;
  top: calc(var(--panel-head-h) - var(--space-1-5));
  right: var(--space-4);
  z-index: var(--z-dropdown);
}
.app:not(.mobile) .panel-add-menu {
  right: var(--panel-head-inset);
}
.ptb-kbd {
  margin-left: auto;
  padding-left: var(--space-4);
}
@media (hover: none), (max-width: 640px) {
  .ptb-x,
  .ptb-tail :deep(.ui-icon-button) {
    position: relative;
  }
  .ptb-x::after {
    content: '';
    position: absolute;
    inset: calc(-1 * (var(--touch-target-min) - var(--panel-tab-x-size)) / 2);
  }
  .ptb-tail :deep(.ui-icon-button)::after {
    content: '';
    position: absolute;
    inset: calc(-1 * (var(--touch-target-min) - var(--icon-button-sm)) / 2);
  }
}
</style>
