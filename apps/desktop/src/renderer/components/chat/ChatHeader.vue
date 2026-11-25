<script setup lang="ts">
import { v4 as randomUUID } from 'uuid';
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue';
import { registerBrowserOverlayMenu } from '../../lib/browserOverlayMenu';
import type { BrowserOverlayMenuItem } from '../../../shared/browser-overlay';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard, sessionLink } from '@moonshot-ai/app-core/lib';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import { isMacosDesktop, sessionLinksSupported } from '@moonshot-ai/app-core/lib';
import { OpenInMenu } from '@moonshot-ai/app-components';
import { track } from '@moonshot-ai/app-client/contracts';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { sessionViewsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { Icon, IconButton, Menu, MenuItem, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import ViewToggles from './ViewToggles.vue';

const { t } = useI18n();

const { sidebarTabs } = useSidebarTabs();
const sessionLinkCopyable = sessionLinksSupported();

const client = useKimiWebClient();
const sessionViews = sessionViewsStore();

const props = withDefaults(defineProps<{
  sessionInfoEnabled?: boolean;
  sessionInfoDisabled?: boolean;
}>(), {
  sessionInfoEnabled: true,
  sessionInfoDisabled: false,
});

const emit = defineEmits<{
  copyAll: [onCopied: (ok: boolean) => void];
  copyFinalSummary: [onCopied: (ok: boolean) => void];
  togglePin: [id: string];
  toggleSessionInfo: [];
}>();

const sessionId = computed(() => client.activeSessionId.value);
const workspaceName = computed(() => client.visibleWorkspace.value?.name);
const workspaceRoot = computed(() => client.visibleWorkspace.value?.root ?? client.status.value.cwd);
const sessionTitle = computed(() => sessionViews.activeSessionTitle);
const archived = client.activeSessionArchived;
const pinned = computed(() => sessionViews.activeSessionPinned);
const sessionInfoTooltip = computed(() => {
  if (props.sessionInfoDisabled) return t('header.sessionInfoWideTable');
  return props.sessionInfoEnabled ? t('header.hideSessionInfo') : t('header.showSessionInfo');
});

const menuOpen = ref(false);
const kebabRef = ref<InstanceType<typeof IconButton> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});

type CopyAction = 'all' | 'summary' | 'id' | 'link';
const copiedAction = ref<CopyAction | null>(null);
let copyRequest = 0;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

function copyItem(action: CopyAction, idleLabel: string, idleIcon: string): { label: string; icon: string } {
  return copiedAction.value === action
    ? { label: t('header.copied'), icon: 'check' }
    : { label: idleLabel, icon: idleIcon };
}

let menuContext = randomUUID();
const nativeMenu = registerBrowserOverlayMenu({
  id: `session.header.${randomUUID()}`, autoWidth: true, placement: 'bottom-start',
  items: (): BrowserOverlayMenuItem[] => {
    const items: BrowserOverlayMenuItem[] = [
    ...(sessionId.value ? [
      { kind: 'item' as const, id: 'rename', label: t('header.renameSession'), icon: 'pencil' },
      ...(!archived.value ? [{ kind: 'item' as const, id: 'pin', label: t(pinned.value ? 'header.unpinSession' : 'header.pinSession'), icon: pinned.value ? 'unpin' : 'pin' }] : []),
      { kind: 'item' as const, id: 'fork', label: t('header.forkSession'), icon: 'git-fork' },
      { kind: 'separator' as const },
    ] : []),
    { kind: 'item', id: 'copy-all', ...copyItem('all', t('header.copyAll'), 'copy'), keepOpen: true },
    { kind: 'item', id: 'copy-summary', ...copyItem('summary', t('header.copyFinalSummary'), 'file-text'), keepOpen: true },
    ...(sessionId.value ? [
      { kind: 'item' as const, id: 'copy-id', ...copyItem('id', t('header.copySessionId'), 'copy'), keepOpen: true },
      ...(sessionLinkCopyable ? [{ kind: 'item' as const, id: 'copy-link', ...copyItem('link', t('header.copySessionLink'), 'link'), keepOpen: true }] : []),
      { kind: 'item' as const, id: 'export', label: t('header.exportSession'), icon: 'download' },
      ...(!archived.value ? [{ kind: 'item' as const, id: 'reload', label: t('header.reloadSession'), icon: 'refresh' }] : []),
      ...(!archived.value || sidebarTabs.value ? [{ kind: 'separator' as const }] : []),
      ...(archived.value && sidebarTabs.value ? [{ kind: 'item' as const, id: 'restore', label: t('header.reopenSession'), icon: 'undo' }] : []),
      ...(!archived.value ? [{ kind: 'item' as const, id: 'archive', label: t(sidebarTabs.value ? 'header.markSessionDone' : 'header.archiveSession'), icon: sidebarTabs.value ? 'state-done' : 'archive' }] : []),
    ] : []),
    ];
    return items.map(item => item.kind === 'item' ? { ...item, id: `${menuContext}:${item.id}` } : item);
  },
  onSelect: id => {
    const separator = id.indexOf(':');
    if (id.slice(0, separator) !== menuContext) return;
    const action = id.slice(separator + 1);
    const actions: Record<string, () => void> = {
      'copy-all': onCopyAll, 'copy-summary': onCopyFinalSummary, 'copy-id': copySessionId, 'copy-link': copySessionLink,
      pin: togglePin, rename: () => { void startRename(); }, fork: forkSession,
      export: exportSession, reload: reloadSession, restore: startRestore, archive: startArchive,
    };
    actions[action]?.();
  },
});
watch(nativeMenu.open, value => {
  if (!nativeMenu.available) return;
  menuOpen.value = value;
  if (!value) resetCopyFeedback();
});
watch([sessionId, workspaceRoot], () => { menuContext = randomUUID(); closeMenu(); }, { flush: 'sync' });

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || kebabRef.value?.el?.contains(target)) return;
  closeMenu();
}

function onResize(): void {
  closeMenu();
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !menuOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
}

function bindDomMenu(): void {
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onMenuKeydown, true);
  window.addEventListener('resize', onResize);
}

function unbindDomMenu(): void {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onMenuKeydown, true);
  window.removeEventListener('resize', onResize);
}

async function toggleMenu(e: Event): Promise<void> {
  e.stopPropagation();
  if (nativeMenu.available && kebabRef.value?.el) {
    nativeMenu.toggle(kebabRef.value.el);
    return;
  }
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  bindDomMenu();
  await nextTick();
  const btn = kebabRef.value?.el;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = r.bottom + gap;
  let flipped = false;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
    flipped = true;
  }
  let left = r.left;
  let alignRight = false;
  if (left + menuW > window.innerWidth - margin) {
    left = Math.max(margin, r.right - menuW);
    alignRight = true;
  }
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transformOrigin: `${flipped ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}`,
    '--menu-pop-shift': flipped ? '2px' : '-2px',
  };
}

function closeMenu(): void {
  nativeMenu.close();
  menuOpen.value = false;
  resetCopyFeedback();
  unbindDomMenu();
}

onUnmounted(closeMenu);

function resetCopyFeedback(): void {
  copyRequest += 1;
  clearTimeout(copiedTimer);
  copiedTimer = undefined;
  copiedAction.value = null;
  nativeMenu.refresh();
}

function copyFeedback(action: CopyAction): (ok: boolean) => void {
  resetCopyFeedback();
  const request = copyRequest;
  return (ok) => {
    if (!ok || !menuOpen.value || request !== copyRequest) return;
    copiedAction.value = action;
    copiedTimer = setTimeout(resetCopyFeedback, 2000);
    nativeMenu.refresh();
  };
}

function onCopyAll(): void {
  track('session_menu_action', { action: 'copyAll' });
  emit('copyAll', copyFeedback('all'));
}

function onCopyFinalSummary(): void {
  track('session_menu_action', { action: 'copyFinalSummary' });
  emit('copyFinalSummary', copyFeedback('summary'));
}

function copySessionId(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'copySessionId' });
  void copyTextToClipboard(sessionId.value).then(copyFeedback('id'));
}

function copySessionLink(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'copySessionLink' });
  void copyTextToClipboard(sessionLink(sessionId.value)).then(copyFeedback('link'));
}

const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

async function startRename(): Promise<void> {
  closeMenu();
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'rename' });
  renaming.value = true;
  renameValue.value = sessionViews.activeSessionTitle;
  await nextTick();
  try {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  } catch {
    // jsdom may not implement focus/select
  }
}

function commitRename(): void {
  const newTitle = renameValue.value.trim();
  if (newTitle && sessionId.value && newTitle !== sessionViews.activeSessionTitle.trim()) {
    void client.renameSession(sessionId.value, newTitle);
  }
  renaming.value = false;
}
function onRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  commitRename();
}

function cancelRename(): void {
  renaming.value = false;
}

function togglePin(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: pinned.value ? 'unpin' : 'pin' });
  closeMenu();
  emit('togglePin', sessionId.value);
}

function forkSession(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'fork' });
  closeMenu();
  void client.forkSession(sessionId.value);
}

function exportSession(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'export' });
  closeMenu();
  void client.exportSessionWithToast(sessionId.value);
}

function reloadSession(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'reload' });
  closeMenu();
  void client.reloadSession(sessionId.value);
}

function startArchive(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'archive' });
  closeMenu();
  void client.archiveSessionWithToast(sessionId.value);
}

function startRestore(): void {
  if (!sessionId.value) return;
  track('session_menu_action', { action: 'restore' });
  closeMenu();
  void client.restoreSessionWithToast(sessionId.value);
}

const isDev = import.meta.env.DEV;
</script>

<template>
  <header class="chat-header" :class="{ 'macos-desktop': isMacosDesktop }">
    <div class="ch-id">
      <span v-if="isDev" class="ch-dev" :title="t('header.devBadge')">DEV</span>
      <span v-if="workspaceName" class="ch-ws">{{ workspaceName }}</span>
      <span v-if="workspaceName && sessionTitle" class="ch-sep">/</span>
      <input
        v-if="renaming"
        ref="renameInputRef"
        v-model="renameValue"
        class="ch-rename"
        type="text"
        @keydown.enter.stop="onRenameEnter"
        @keydown.esc.stop="cancelRename"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @blur="commitRename"
        @click.stop
      />
      <Tooltip v-else-if="sessionTitle" :text="sessionTitle">
        <span class="ch-ses">{{ sessionTitle }}</span>
      </Tooltip>
    </div>

    <IconButton
      ref="kebabRef"
      class="ch-act-more"
      :class="{ open: menuOpen }"
      :label="t('header.options')"
      :tooltip="t('header.options')"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      @click.stop="toggleMenu($event)"
    >
      <Icon name="dots-horizontal" size="sm" />
    </IconButton>

    <Transition name="ui-menu-pop">
      <Menu
        v-if="menuOpen && !nativeMenu.available"
        ref="menuRef"
        class="ui-menu-floating ch-menu"
        :style="menuStyle"
        @click.stop
        @keydown.esc.stop="closeMenu"
      >
        <template v-if="sessionId">
          <MenuItem @click="startRename">
            <Icon name="pencil" size="sm" />
            {{ t('header.renameSession') }}
          </MenuItem>
          <MenuItem v-if="!archived" @click="togglePin">
            <Icon :name="pinned ? 'unpin' : 'pin'" size="sm" />
            {{ pinned ? t('header.unpinSession') : t('header.pinSession') }}
          </MenuItem>
          <MenuItem @click="forkSession">
            <Icon name="git-fork" size="sm" />
            {{ t('header.forkSession') }}
          </MenuItem>
          <MenuItem separator />
        </template>
        <MenuItem @click="onCopyAll">
          <Icon :name="copiedAction === 'all' ? 'check' : 'copy'" size="sm" />
          {{ copiedAction === 'all' ? t('header.copied') : t('header.copyAll') }}
        </MenuItem>
        <MenuItem @click="onCopyFinalSummary">
          <Icon :name="copiedAction === 'summary' ? 'check' : 'file-text'" size="sm" />
          {{ copiedAction === 'summary' ? t('header.copied') : t('header.copyFinalSummary') }}
        </MenuItem>
        <template v-if="sessionId">
          <MenuItem @click="copySessionId">
            <Icon :name="copiedAction === 'id' ? 'check' : 'copy'" size="sm" />
            {{ copiedAction === 'id' ? t('header.copied') : t('header.copySessionId') }}
          </MenuItem>
          <MenuItem v-if="sessionLinkCopyable" @click="copySessionLink">
            <Icon :name="copiedAction === 'link' ? 'check' : 'link'" size="sm" />
            {{ copiedAction === 'link' ? t('header.copied') : t('header.copySessionLink') }}
          </MenuItem>
          <MenuItem @click="exportSession">
            <Icon name="download" size="sm" />
            {{ t('header.exportSession') }}
          </MenuItem>
          <MenuItem v-if="!archived" @click="reloadSession">
            <Icon name="refresh" size="sm" />
            {{ t('header.reloadSession') }}
          </MenuItem>
          <MenuItem v-if="!archived || sidebarTabs" separator />
          <MenuItem v-if="archived && sidebarTabs" @click="startRestore">
            <Icon name="undo" size="sm" />
            {{ t('header.reopenSession') }}
          </MenuItem>
          <MenuItem v-if="!archived" @click="startArchive">
            <Icon :name="sidebarTabs ? 'state-done' : 'archive'" size="sm" />
            {{ sidebarTabs ? t('header.markSessionDone') : t('header.archiveSession') }}
          </MenuItem>
        </template>
      </Menu>
    </Transition>

    <div class="ch-spacer" />

    <!-- Open workspace in editor/terminal; the pill self-hides on an empty
         service catalog (the no-bridge degradation). -->
    <OpenInMenu v-if="workspaceRoot && workspacesStore().isLocalWorkspace" :work-dir="workspaceRoot" />

    <IconButton
      class="ch-session-info"
      :class="{ open: sessionInfoEnabled }"
      :label="sessionInfoTooltip"
      :tooltip="sessionInfoTooltip"
      :aria-pressed="sessionInfoEnabled"
      :disabled="sessionInfoDisabled"
      @click="emit('toggleSessionInfo')"
    >
      <Icon name="session-info" size="sm" />
    </IconButton>

    <ViewToggles />

  </header>
</template>

<style scoped>
.chat-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  height: var(--panel-head-h, 48px);
  padding: 0 16px;
  border-bottom: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
  font-family: var(--font-ui);
  min-width: 0;
  user-select: none;
  container-type: inline-size;
}
.chat-header.macos-desktop {
  -webkit-app-region: drag;
}
.chat-header.macos-desktop button,
.chat-header.macos-desktop input {
  -webkit-app-region: no-drag;
}
:global(.app:not(.mobile) .chat-header) {
  transition: padding-left 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
:global(.app.sidebar-collapsed .chat-header) {
  padding-left: 78px;
}
:global(.app.sidebar-collapsed.custom-titlebar .chat-header) {
  padding-left: var(--space-4);
}
:global(.app.sidebar-collapsed.macos-desktop .chat-header) {
  padding-left: 146px;
}
:global(.app.fullscreen.sidebar-collapsed.macos-desktop .chat-header) {
  padding-left: 78px;
}
.ch-id { display: flex; align-items: center; gap: 6px; min-width: 0; flex: none; max-width: 46%; }
.ch-ws { color: var(--color-text-muted); font-size: var(--text-base); font-weight: var(--weight-medium); flex: none; }
.ch-sep { color: var(--color-text-faint); flex: none; }
.ch-ses {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-rename {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  background: var(--color-bg);
  border: var(--p-hairline) solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 2px 5px;
  outline: none;
  user-select: text;
}

.chat-header .ch-session-info { width: var(--icon-button-sm); height: var(--icon-button-sm); border-radius: var(--radius-sm); }
.chat-header .ch-session-info :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ch-session-info.open { background: var(--color-well); color: var(--color-text); }
.ch-spacer { flex: 1; min-width: 0; }

@container (max-width: 720px) {
  .ch-ws,
  .ch-sep { display: none; }
  .ch-id { flex: 0 1 auto; max-width: none; }
}

.chat-header .ch-act-more { width: 24px; height: 24px; border-radius: var(--radius-sm); }
.chat-header .ch-act-more :deep(svg) { width: 14px; height: 14px; }
.ch-act-more.open { background: var(--color-well); color: var(--color-text); }

.ch-dev {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  flex: none;
  border: var(--p-hairline) solid var(--color-warning-bd);
  border-radius: var(--radius-full);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: var(--text-xs);
  font-weight: 500;
}

@media (max-width: 980px) {
  .ch-act-label { display: none; }
}
@media (max-width: 640px) {
  .chat-header { display: none; }
}
</style>
