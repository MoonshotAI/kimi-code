<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { serverEndpointLabel } from '../api/config';
import {
  fetchDevBackendState,
  initialDevBackendState,
  shortOrigin,
  switchDevBackend,
  type BackendName,
  type DevBackendState,
} from '../api/devBackend';
import { logWarn } from '@moonshot-ai/app-core/lib';
import {
  openTabAttention,
  canDropWorkspaceFolders,
  extractDroppedFolderPaths,
  looksLikeFolderDrag,
} from '@moonshot-ai/app-core/lib';
import { SearchSessionsDialog } from '@moonshot-ai/app-components';
import UpdateIndicator from './UpdateIndicator.vue';
import DebugMenu from './DebugMenu.vue';
import UserMenu from './UserMenu.vue';
import { RcDeviceSwitcher, SessionListPanel, useAnchoredMenu } from '@moonshot-ai/app-components';
import { hasCustomTitleBar, hasDesktopBridge, isMacosDesktop } from '@moonshot-ai/app-core/lib';
import type { WorkspaceView } from '../types';
import { useVibrancy } from '../composables/useVibrancy';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import { resolvedBindingKeys, shortcutTooltip } from '../composables/useShortcuts';
import { canOpenDirectoryInNative, openDirectoryInNative } from '../lib/nativeOpenIn';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { sessionViewsStore, sessionsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { track } from '@moonshot-ai/app-client/contracts';
import type { SessionCreatedSource } from '../../shared/track-events';
import { Icon, IconButton, Kbd, Menu, MenuItem, Pill, SegmentedControl } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const { vibrancy } = useVibrancy();

const desktopBridge = hasDesktopBridge();
const isDev = import.meta.env.DEV && desktopBridge;
const devBackend = ref<DevBackendState | null>(isDev ? initialDevBackendState() : null);
if (isDev) {
  onMounted(async () => {
    const live = await fetchDevBackendState();
    if (live) devBackend.value = live;
  });
}
const endpoint = computed(() => {
  if (!isDev) return '';
  const current = devBackend.value?.current;
  return current ? shortOrigin(current) : serverEndpointLabel();
});
const backendNames: BackendName[] = ['default', 'multi'];
function presetUrl(name: BackendName): string {
  const url = devBackend.value?.presets[name] ?? '';
  return url ? shortOrigin(url) : '';
}
function isCurrentBackend(name: BackendName): boolean {
  const state = devBackend.value;
  return state !== null && state.current === state.presets[name];
}

withDefaults(
  defineProps<{
    colWidth?: number;
    collapsed?: boolean;
    dragging?: boolean;
    feedbackEnabled?: boolean;
  }>(),
  {
    colWidth: 220,
    collapsed: false,
    dragging: false,
  },
);

const emit = defineEmits<{
  select: [selection: { sessionId: string; source: SessionCreatedSource }];
  create: [];
  createInWorkspace: [workspaceId: string];
  addWorkspace: [];
  editWorkspace: [workspace: WorkspaceView];
  addWorkspacePaths: [paths: string[]];
  generateTitle: [id: string, done: (title: string | null) => void];
  deleteWorkspace: [id: string];
  openSettings: [];
  openFeedback: [];
  login: [];
  collapse: [];
}>();

const client = useKimiWebClient();
const sessionViews = sessionViewsStore();
const workspaces = workspacesStore();
const sessionStore = sessionsStore();

const sessions = computed(() => sessionViews.sessionsForView);
const pinnedSessions = computed(() => sessionViews.pinnedSessions);
const pendingBySession = computed(() => sessionViews.pendingBySession);
const unreadBySession = computed(() => sessionViews.unreadBySession);
const activeWorkspaceId = computed(() => workspaces.activeWorkspaceId);
const activeId = computed(() => sessionStore.activeSessionId ?? '');
const flatSessions = client.flatSessions;
const doneSessions = client.doneSessions;
const backend = client.backend;

const panelRef = ref<InstanceType<typeof SessionListPanel> | null>(null);

const showSearch = ref(false);
const sessionSearchKeys = computed(() => resolvedBindingKeys('searchSessions'));
const newChatKeys = computed(() => resolvedBindingKeys('newSession'));
const settingsTooltip = computed(() => shortcutTooltip(t('settings.title'), 'openSettings'));
const collapseTooltip = computed(() => shortcutTooltip(t('sidebar.collapseSidebar'), 'toggleSidebar'));

function openSearch(): void {
  void client.loadAllSessions();
  showSearch.value = true;
}

function toggleSearch(): void {
  if (showSearch.value) {
    showSearch.value = false;
  } else {
    openSearch();
  }
}

function onSearchButtonClick(): void {
  track('action_invoked', { action: 'searchSessions', source: 'button' });
  openSearch();
}

const searchWorkspaces = computed(() => sessionViews.workspaceGroups.map((g) => g.workspace));

function onSearchSelectSession(sessionId: string): void {
  emit('select', { sessionId, source: 'search' });
  panelRef.value?.locateSession(sessionId);
}

function onSearchSelectWorkspace(workspaceId: string): void {
  panelRef.value?.locateWorkspace(workspaceId);
}

const statusTab = ref<'open' | 'done' | 'workspaces'>('open');

const { sidebarTabs } = useSidebarTabs();
watch(sidebarTabs, (on) => {
  if (!on && statusTab.value !== 'open') statusTab.value = 'open';
});

const openAttention = computed(() =>
  openTabAttention(
    [...pinnedSessions.value, ...flatSessions.value].map((s) => ({
      busy: s.busy,
      unread: unreadBySession.value[s.id] ?? false,
      questionCount: pendingBySession.value[s.id]?.questions ?? 0,
      approvalCount: pendingBySession.value[s.id]?.approvals ?? 0,
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    })),
  ),
);

const doneAttention = computed(() =>
  openTabAttention(
    doneSessions.value.map((s) => ({
      busy: s.busy,
      unread: unreadBySession.value[s.id] ?? false,
      questionCount: pendingBySession.value[s.id]?.questions ?? 0,
      approvalCount: pendingBySession.value[s.id]?.approvals ?? 0,
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    })),
  ),
);

const TAB_ATTENTION_SWATCH = 'var(--color-accent)';

const statusTabOptions = computed(() => [
  {
    value: 'open',
    label: t('sidebar.tabOpen'),
    swatch: openAttention.value === null ? undefined : TAB_ATTENTION_SWATCH,
  },
  {
    value: 'done',
    label: t('sidebar.tabDone'),
    swatch: doneAttention.value === null ? undefined : TAB_ATTENTION_SWATCH,
  },
  { value: 'workspaces', label: t('sidebar.tabWorkspaces') },
]);

function setStatusTab(tab: string): void {
  if (!sidebarTabs.value) return;
  statusTab.value = tab as 'open' | 'done' | 'workspaces';
  if (tab === 'done') void client.ensureDoneSessions();
}

function selectSibling(delta: 1 | -1): void {
  const panel = panelRef.value;
  if (!panel) return;
  const ids = panel.getSiblingOrder();
  if (ids.length === 0) return;
  const currentId = statusTab.value === 'workspaces' ? (activeWorkspaceId.value ?? '') : activeId.value;
  const idx = ids.findIndex((id) => id === currentId);
  const nextIdx =
    idx === -1 ? (delta > 0 ? 0 : ids.length - 1) : (idx + delta + ids.length) % ids.length;
  const id = ids[nextIdx];
  if (id === undefined) return;
  if (statusTab.value === 'workspaces') {
    panel.expandGroupIfCollapsed(null);
    emit('createInWorkspace', id);
    return;
  }
  const wsId = panel.groupOfSession(id);
  panel.expandGroupIfCollapsed(wsId, id);
  emit('select', { sessionId: id, source: 'sidebar' });
}

function onSelectSession(sessionId: string): void {
  emit('select', { sessionId, source: 'sidebar' });
}

const canOpenWorkspaceDirectory = computed(() => canOpenDirectoryInNative());

async function onOpenWorkspaceDirectory(path: string): Promise<void> {
  const opened = await openDirectoryInNative(path);
  if (!opened) client.notify({ severity: 'warning', title: t('sidebar.openDirectoryFailed') });
}

function revealPinnedSection(): void {
  panelRef.value?.revealPinnedSection();
}

defineExpose({ openSearch, toggleSearch, isSearchOpen: () => showSearch.value, setStatusTab, selectSibling, revealPinnedSection });

const folderDropDepth = ref(0);
const folderDropActive = ref(false);

function folderDropReset(): void {
  folderDropDepth.value = 0;
  folderDropActive.value = false;
}

function onFolderDragEnter(event: DragEvent): void {
  if (!canDropWorkspaceFolders() || !looksLikeFolderDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  folderDropDepth.value += 1;
  folderDropActive.value = true;
}

function onFolderDragOver(event: DragEvent): void {
  if (!canDropWorkspaceFolders() || !looksLikeFolderDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onFolderDragLeave(event: DragEvent): void {
  if (!canDropWorkspaceFolders() || !looksLikeFolderDrag(event)) return;
  folderDropDepth.value = Math.max(0, folderDropDepth.value - 1);
  if (folderDropDepth.value === 0) folderDropActive.value = false;
}

function onFolderDrop(event: DragEvent): void {
  folderDropReset();
  if (!canDropWorkspaceFolders()) return;
  const paths = extractDroppedFolderPaths(event);
  if (paths.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  emit('addWorkspacePaths', paths);
}

const backendMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const {
  open: backendMenuOpen,
  menuStyle: backendMenuStyle,
  toggleAnchored: toggleBackendMenuAnchored,
  close: closeBackendMenu,
} = useAnchoredMenu(backendMenuRef);

function toggleBackendMenu(e: MouseEvent): void {
  if (devBackend.value === null) return;
  void toggleBackendMenuAnchored(e, 'left');
}

async function chooseBackend(name: BackendName): Promise<void> {
  if (isCurrentBackend(name)) {
    closeBackendMenu();
    return;
  }
  const next = await switchDevBackend(name);
  if (next === null) {
    logWarn('[kimi-code] dev backend switch failed:', name);
    closeBackendMenu();
    return;
  }
  window.location.reload();
}

const logoRef = ref<SVGSVGElement | null>(null);
let blinkTimer: ReturnType<typeof setTimeout> | undefined;

function blinkOnce(): void {
  const el = logoRef.value;
  if (!el) return;
  el.classList.remove('blink-now');
  void el.getBoundingClientRect();
  el.classList.add('blink-now');
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => el.classList.remove('blink-now'), 300);
}

function onLogoClick(): void {
  blinkOnce();
}
</script>

<template>
  <aside
    class="side"
    :class="{
      'macos-desktop': isMacosDesktop,
      'custom-titlebar': hasCustomTitleBar,
      vibrancy,
      collapsed,
      'no-anim': dragging,
    }"
    :style="{ width: collapsed ? '0px' : colWidth + 'px' }"
  >
    <div
      class="col"
      :style="{ width: colWidth + 'px' }"
      @dragenter="onFolderDragEnter"
      @dragover="onFolderDragOver"
      @dragleave="onFolderDragLeave"
      @drop="onFolderDrop"
    >
      <div v-if="!hasCustomTitleBar" class="ch">
        <div class="ch-brand">
          <template v-if="!isMacosDesktop">
            <!-- brand-mark:start — generated by scripts/icon-tools/build-brand-icons.mjs from
                 KIMI CODE LOGO/Original Logo.svg; do not edit by hand -->
            <svg ref="logoRef" class="ch-logo" viewBox="0 0 32 28.2791" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="onLogoClick">
              <defs>
                <radialGradient id="chLogoFace" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(14.5195 12.5993) scale(14.1117)">
                  <stop stop-color="#117DFB" />
                  <stop offset="0.759254" stop-color="#449BFF" />
                  <stop offset="1" stop-color="#77B6FF" />
                </radialGradient>
              </defs>
              <path d="M 14.5195 0.3556 C 22.2186 0.3556 28.4601 6.5969 28.4601 14.2961 C 28.4601 21.9952 22.2186 28.2366 14.5195 28.2366 C 6.8204 28.2366 0.579 21.9952 0.579 14.2961 C 0.579 6.5969 6.8204 0.3556 14.5195 0.3556 Z" fill="#2389FF" />
              <path d="M 14.5195 0.3556 C 22.2186 0.3556 28.4601 6.5969 28.4601 14.2961 C 28.4601 21.9952 22.2186 28.2366 14.5195 28.2366 C 6.8204 28.2366 0.579 21.9952 0.579 14.2961 C 0.579 6.5969 6.8204 0.3556 14.5195 0.3556 Z" fill="url(#chLogoFace)" />
              <g class="ch-eyes" fill="#fff">
                <path class="ch-eye" d="M 12.8637 8.8339 C 12.7301 7.8611 13.4042 6.965 14.3693 6.8324 C 15.3344 6.6999 16.2251 7.3811 16.3587 8.3539 L 16.7656 11.3165 C 16.8992 12.2893 16.2251 13.1854 15.26 13.318 C 14.2949 13.4505 13.4042 12.7693 13.2706 11.7965 L 12.8637 8.8339 Z" />
                <path class="ch-eye" d="M 20.1974 7.8996 C 20.0705 6.9754 20.6717 6.1295 21.5403 6.0102 C 22.4089 5.8909 23.216 6.5434 23.3429 7.4676 L 23.7295 10.282 C 23.8564 11.2062 23.2551 12.0521 22.3865 12.1714 C 21.5179 12.2907 20.7109 11.6382 20.5839 10.714 L 20.1974 7.8996 Z" />
              </g>
              <rect x="0" y="17.8221" width="31.9124" height="10.4405" rx="1.158" fill="#002E58" />
              <path d="M 2.6265 21.0396 L 5.5577 22.7318 C 5.7989 22.8711 5.7989 23.2193 5.5577 23.3586 L 2.6265 25.0509" stroke="#fff" stroke-width="1.3133" stroke-linecap="round" />
              <path d="M 8.7332 25.439 H 11.6282" stroke="#007CFF" stroke-width="1.3133" stroke-linecap="round" />
              <path d="M 28.9734 0 C 30.2364 0 31.2604 1.0239 31.2604 2.287 C 31.2604 3.55 30.2364 4.574 28.9734 4.574 L 26.9555 4.574 C 26.8068 4.574 26.6864 4.4535 26.6864 4.3049 L 26.6864 2.287 C 26.6864 1.0239 27.7103 0 28.9734 0 Z" fill="#1783FF" />
            </svg>
            <!-- brand-mark:end -->
            <span class="ch-name">Kimi Code</span>
            <Pill
              v-if="isDev"
              class="ch-backend"
              :clickable="devBackend !== null"
              :title="t('sidebar.backendTitle', { backend, endpoint })"
              @click="toggleBackendMenu"
            >
              <span class="ch-backend-kind" :class="`is-${backend}`">{{ backend }}</span>
              <span class="ch-backend-ep"> · {{ endpoint }}</span>
              <Icon v-if="devBackend !== null" name="chevron-down" size="sm" />
            </Pill>
          </template>
        </div>
        <div class="ch-tail">
          <!-- Desktop-only 分叉块（与 UpdateIndicator 同块，docs/native-divergence.md）：
               统一的 debug 入口（原 Canary 徽章），
               dev / canary 构建才渲染。 -->
          <DebugMenu />
          <IconButton
            v-if="!isMacosDesktop"
            class="ch-collapse"
            size="sm"
            :label="t('sidebar.collapseSidebar')"
            :tooltip="collapseTooltip.text"
            :keys="collapseTooltip.keys"
            @click.stop="emit('collapse')"
          >
            <Icon name="panel-collapse" />
          </IconButton>
          <UpdateIndicator />
        </div>
      </div>

      <RcDeviceSwitcher />

      <!-- Sidebar actions share one container so New chat and Search are true
           sibling controls. The optional workspace action occupies column 2. -->
      <div class="sidebar-actions">
        <button class="btn-new-chat" type="button" @click.stop="emit('create')">
          <Icon name="chat-new" />
          <span>{{ t('sidebar.newChat') }}</span>
          <Kbd :keys="newChatKeys" />
        </button>
        <button class="search" type="button" @click="onSearchButtonClick">
          <Icon class="search-icon" name="search" />
          <span class="search-input">{{ t('sidebar.search') }}</span>
          <Kbd :keys="sessionSearchKeys" />
        </button>
      </div>

      <!-- The 进行中 / 已完成 / 工作空间 tabs are the sidebar's top level when
           the 实验室 multi-tab toggle is on; the single-list form (toggle off)
           skips them and pins statusTab to 'open'. Flat/grouped is a display
           switch inside the two session tabs (the section label's switcher
           below). -->
      <div v-if="sidebarTabs" class="status-tabs">
        <SegmentedControl
          class="status-seg"
          size="sm"
          :model-value="statusTab"
          :options="statusTabOptions"
          @update:model-value="setStatusTab"
        />
      </div>

      <SessionListPanel
        ref="panelRef"
        :status-tab="statusTab"
        :can-edit-workspace="true"
        :workspace-hover-enabled="desktopBridge"
        :can-open-workspace-directory="canOpenWorkspaceDirectory"
        @open-workspace-directory="onOpenWorkspaceDirectory"
        @update:status-tab="setStatusTab"
        @select="onSelectSession"
        @create-in-workspace="(id) => emit('createInWorkspace', id)"
        @add-workspace="emit('addWorkspace')"
        @edit-workspace="emit('editWorkspace', $event)"
        @generate-title="(id, done) => emit('generateTitle', id, done)"
        @delete-workspace="(id) => emit('deleteWorkspace', id)"
      />

      <!-- Footer: account area (user menu) pinned under the session list, with
           the settings entry pinned at its right edge. -->
      <div class="side-footer" :class="{ 'side-footer--shadowed': panelRef?.sessionsCanScrollDown }">
        <div class="side-footer-account">
          <UserMenu @login="emit('login')" @open-settings="emit('openSettings')" />
        </div>
        <IconButton
          v-if="feedbackEnabled"
          class="side-feedback"
          size="sm"
          :label="t('feedback.send')"
          :tooltip="t('feedback.send')"
          tooltip-arrow
          @click.stop="emit('openFeedback')"
        >
          <span class="side-feedback-icon" aria-hidden="true" />
        </IconButton>
        <IconButton
          class="side-footer-settings"
          size="sm"
          :label="t('settings.title')"
          :tooltip="settingsTooltip.text"
          :keys="settingsTooltip.keys"
          @click.stop="emit('openSettings')"
        >
          <Icon name="settings" />
        </IconButton>
      </div>

      <!-- Folder-drop affordance (desktop only): shown while a folder drag
           hovers the sidebar. Purely visual (pointer-events none) — the
           handlers on .col receive the drop. Pure CSS show/hide like the
           composer's drop overlay (a <Transition> can strand an invisible
           node when the drag ends before the enter transition starts). -->
      <div class="folder-drop-overlay" :class="{ show: folderDropActive }" aria-hidden="true">
        <div class="folder-drop-card">
          <Icon name="folder" size="lg" />
          <span>{{ t('sidebar.dropToAddWorkspace') }}</span>
        </div>
      </div>
    </div>

    <!-- Dev backend switcher menu (position:fixed, anchored to the brand pill) -->
    <Transition name="menu-pop">
      <Menu
        v-if="backendMenuOpen"
        ref="backendMenuRef"
        class="backend-menu"
        :style="backendMenuStyle"
        @click.stop
      >
        <MenuItem v-for="name in backendNames" :key="name" @click="chooseBackend(name)">
          <span class="section-menu-check">
            <Icon v-if="isCurrentBackend(name)" name="check" size="sm" />
          </span>
          <span class="backend-menu-name">{{ name }}</span>
          <span class="backend-menu-url">{{ presetUrl(name) }}</span>
        </MenuItem>
      </Menu>
    </Transition>
    <!-- Session search dialog (Cmd/Ctrl+K) -->
    <SearchSessionsDialog
      v-if="showSearch"
      :sessions="sessions"
      :workspaces="searchWorkspaces"
      :active-id="activeId"
      @select="onSearchSelectSession"
      @select-workspace="onSearchSelectWorkspace"
      @close="showSearch = false"
    />
  </aside>
</template>

<style scoped>
.side {
  background: var(--color-sidebar-bg);
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  overflow: hidden;
  min-width: 0;
  height: 100%;
  transition:
    var(--side-width-anim),
    visibility 0.28s;
  --sb-inset: var(--space-2);
  --sb-pad-x: var(--space-4);
  --sb-gutter: 16px;
  --sb-gap: var(--space-2);
  --sb-action-inset: calc((max(var(--ui-font-size-sm) * var(--leading-tight), var(--p-ic-md)) + 2 * var(--space-2) - var(--icon-button-sm)) / 2);
  --sb-hover: var(--color-hover);
  --sb-selected: color-mix(in srgb, var(--color-selected) 75%, transparent);
  user-select: none;
}
.side :deep(:is(input, textarea, [contenteditable='true'])) {
  user-select: text;
}
.side.macos-desktop.vibrancy { background: var(--color-sidebar-tint, transparent); }
.side.macos-desktop.vibrancy .ch,
.side.macos-desktop.vibrancy .sidebar-actions,
.side.macos-desktop.vibrancy .side-footer {
  background: transparent;
}
.side.no-anim,
.side.no-anim .col {
  transition: none;
}
.side.collapsed {
  visibility: hidden;
}

.col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  border-right: var(--p-hairline) solid var(--line);
  container-type: inline-size;
  container-name: sidebar-col;
  position: relative;
  transition: var(--side-width-anim);
}

.ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: var(--space-3);
  min-height: calc(26px + 2 * var(--space-3));
  width: 100%;
  box-sizing: border-box;
  container-type: inline-size;
  container-name: sidebar-header;
}
.side.macos-desktop .ch {
  padding-left: 80px;
  -webkit-app-region: drag;
}
.side.macos-desktop .ch-brand {
  display: none;
}
.ch-logo {
  height: 22px;
  width: auto;
  flex: none;
  display: block;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  transition: transform 0.18s ease;
}
.ch-logo:hover {
  transform: scale(1.08);
}
.ch-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  user-select: none;
  touch-action: none;
}
.ch-tail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  min-width: 0;
  margin-left: auto;
}
.ch-name {
  font-size: var(--ui-font-size);
  font-weight: 500;
  line-height: 22px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-backend {
  flex: none;
  min-width: 0;
  font-family: var(--font-ui);
}
.ch-backend-kind {
  font-family: inherit;
  font-weight: 500;
  color: var(--color-text-muted);
}
.ch-backend-kind.is-v2 {
  color: var(--color-accent);
}
.ch-backend-ep {
  font-family: inherit;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
}

@container sidebar-col (max-width: 320px) {
  .ch-backend-ep { display: none; }
}
@container sidebar-col (max-width: 250px) {
  .ch-name { display: none; }
}

.sidebar-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 var(--space-2);
  padding: 0 var(--sb-inset) var(--space-1);
  position: relative;
  z-index: 1;
  background: var(--color-sidebar-bg);
}
.side.custom-titlebar .sidebar-actions {
  padding-top: var(--space-2);
}

.btn-new-chat {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  width: 100%;
  min-width: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  cursor: pointer;
  text-align: left;
}
.btn-new-chat:hover { background: var(--sb-hover); }
.btn-new-chat:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.btn-new-chat svg { flex: none; }
.btn-new-chat span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-new-chat :deep(.ui-kbd) { margin-left: auto; }

.btn-new-chat :deep(.ui-kbd),
.search :deep(.ui-kbd) {
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.btn-new-chat:hover :deep(.ui-kbd),
.btn-new-chat:focus-visible :deep(.ui-kbd),
.search:hover :deep(.ui-kbd),
.search:focus-visible :deep(.ui-kbd) {
  opacity: 1;
}

.search {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  width: 100%;
  margin: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.search:hover { background: var(--sb-hover); }
.search:focus-visible {
  background: var(--sb-hover);
  color: var(--color-text);
  outline: 2px solid var(--color-accent-bd);
  outline-offset: -2px;
}
.search-icon {
  flex: none;
  transform: translateY(-0.5px);
}
.search-input {
  flex: 1;
  min-width: 0;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-tabs {
  padding: var(--space-2) var(--sb-inset) 0;
}
.status-seg {
  width: 100%;
  display: flex;
}
.status-seg :deep(.ui-seg__item) {
  flex: 1;
  min-width: 0;
  justify-content: center;
  padding: 0 var(--space-1);
  overflow: hidden;
}
.side.macos-desktop.vibrancy .status-seg {
  background: var(--color-selected);
}
.side.macos-desktop.vibrancy .status-seg :deep(.ui-seg__item.is-on) {
  background: color-mix(in srgb, var(--color-surface-raised) 72%, transparent);
}

.side-footer {
  flex: none;
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) calc(var(--sb-inset) + var(--sb-action-inset)) var(--space-2) var(--sb-inset);
  border-top: var(--p-hairline) solid var(--line);
  background: var(--color-sidebar-bg);
}
.side-footer-account {
  flex: 1 1 auto;
  min-width: 0;
}
.side-footer-settings {
  flex: none;
}
.side-feedback { width: 24px; height: 24px; color: var(--color-send-bg); }
.side-feedback-icon {
  width: 16px; height: 16px;
  background: currentColor;
  mask: url('./feedback/assets/sidebar-feedback.svg') center / contain no-repeat;
}
.side-footer::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--p-sidebar-seam-h);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  bottom: 100%;
  background:
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%),
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%),
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  transition-duration: var(--duration-slow);
}
.side-footer--shadowed::before { opacity: 1; }

.folder-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
  box-sizing: border-box;
  background: color-mix(in srgb, var(--color-sidebar-bg) 72%, transparent);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-base) ease,
    visibility var(--duration-base);
}
.folder-drop-overlay.show {
  opacity: 1;
  visibility: visible;
}
.folder-drop-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: 100%;
  box-sizing: border-box;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: var(--p-hairline) dashed var(--color-accent);
  background: var(--color-bg);
  color: var(--color-accent);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-md);
}
.folder-drop-card svg {
  flex: none;
}
.folder-drop-card span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backend-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
.section-menu-check {
  display: inline-flex;
  flex: none;
  width: 14px;
}
.backend-menu-name {
  font-family: var(--mono);
  font-weight: 500;
}
.backend-menu-url {
  margin-left: 8px;
  font-family: var(--mono);
  color: var(--color-text-muted);
}
.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
