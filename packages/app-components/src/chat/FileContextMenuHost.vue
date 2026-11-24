<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  InsertPathMentionKey,
  OpenInServiceKey,
  OpenWithDefaultAppKey,
  RevealInFolderKey,
  type OpenInAppEntry,
} from '@moonshot-ai/app-client/contracts';
import { useWarningsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import {
  closeFileContextMenu,
  isAbsoluteFilePath,
  resolveFileMenuPath,
  useFileContextMenuState,
} from './fileContextMenu';

const { t } = useI18n();
const warningsStore = useWarningsStore();
const revealInFolder = inject(RevealInFolderKey, undefined);
const openWithDefaultApp = inject(OpenWithDefaultAppKey, undefined);
const openInService = inject(OpenInServiceKey, undefined);
const insertPathMention = inject(InsertPathMentionKey, undefined);
const localWorkspace = computed(() => workspacesStore().isLocalWorkspace);

const state = useFileContextMenuState();
const homePath = ref('');
const homePending = ref(false);
let homeSeq = 0;

watch(
  () => [state.open, state.path] as const,
  async ([open, path]) => {
    const seq = ++homeSeq;
    homePath.value = '';
    homePending.value = open && (path === '~' || path.startsWith('~/'));
    if (!homePending.value) return;
    try {
      const { home } = await workspacesStore().getFsHome(workspacesStore().visibleWorkspace?.hostId);
      if (seq === homeSeq) homePath.value = home;
    } finally {
      if (seq === homeSeq) homePending.value = false;
    }
  },
  { immediate: true },
);

const targetPath = computed(() => resolveFileMenuPath(state.path, state.cwd, homePath.value));
const canReveal = computed(
  () => revealInFolder !== undefined && localWorkspace.value && !state.deleted && isAbsoluteFilePath(targetPath.value),
);
const canOpenWith = computed(
  () =>
    openWithDefaultApp !== undefined &&
    openInService !== undefined &&
    localWorkspace.value &&
    state.kind === 'file' &&
    !state.deleted &&
    !state.symlink &&
    isAbsoluteFilePath(targetPath.value) &&
    /\.(md|markdown|mdx)$/i.test(targetPath.value),
);
const canAddToChat = computed(() => insertPathMention !== undefined && !state.deleted);
const canCopyPath = computed(() => !homePending.value);

const catalog = ref<OpenInAppEntry[]>([]);
const availableApps = computed(() => catalog.value.filter((app) => app.id !== 'finder' && app.id !== 'explorer'));
let catalogSeq = 0;
watch(
  () => [state.open, targetPath.value, canOpenWith.value] as const,
  async ([open, path, canLoad]) => {
    const seq = ++catalogSeq;
    catalog.value = [];
    if (!open || !canLoad || openInService === undefined) return;
    try {
      const apps = await openInService.catalog('file', path);
      if (seq === catalogSeq) {
        catalog.value = apps;
        if (openWithMenuOpen.value) void openOpenWithMenu();
      }
    } catch {
      if (seq === catalogSeq) catalog.value = [];
    }
  },
  { immediate: true },
);

const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});
const openWithAnchorRef = ref<HTMLElement | null>(null);
const openWithMenuOpen = ref(false);
const subMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const subMenuStyle = ref<Record<string, string>>({});

function closeOpenWithMenu(): void {
  openWithMenuOpen.value = false;
}

async function openOpenWithMenu(focusFirst = false): Promise<void> {
  if (!canOpenWith.value) return;
  openWithMenuOpen.value = true;
  await nextTick();
  const anchor = openWithAnchorRef.value;
  const menu = subMenuRef.value?.el;
  if (!anchor || !menu) return;
  const rect = anchor.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  let left = rect.right + gap;
  if (left + menuWidth > window.innerWidth - margin) {
    left = Math.max(margin, rect.left - menuWidth - gap);
  }
  left = Math.min(left, Math.max(margin, window.innerWidth - menuWidth - margin));
  let top = rect.top - gap;
  if (top + menuHeight > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - menuHeight - margin);
  }
  subMenuStyle.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
  if (focusFirst) menu.querySelector<HTMLElement>('.ui-menu-item:not(:disabled)')?.focus();
}

function onDocPointer(event: MouseEvent): void {
  const target = event.target as Node;
  if (menuRef.value?.el?.contains(target)) return;
  if (subMenuRef.value?.el?.contains(target)) return;
  closeFileContextMenu();
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  if (openWithMenuOpen.value) {
    closeOpenWithMenu();
    openWithAnchorRef.value?.querySelector<HTMLElement>('.ui-menu-item')?.focus();
    return;
  }
  closeFileContextMenu();
}

function moveFocus(container: HTMLElement | undefined, event: KeyboardEvent): void {
  if (!container || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)'));
  if (items.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowDown'
        ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

function onParentMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight' && (event.target as Element).closest('.file-context-open-with')) {
    event.preventDefault();
    event.stopPropagation();
    void openOpenWithMenu(true);
    return;
  }
  moveFocus(menuRef.value?.el, event);
}

function onSubmenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    event.stopPropagation();
    closeOpenWithMenu();
    openWithAnchorRef.value?.querySelector<HTMLElement>('.ui-menu-item')?.focus();
    return;
  }
  moveFocus(subMenuRef.value?.el, event);
}

function detach(): void {
  document.removeEventListener('mousedown', onDocPointer);
  window.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', closeFileContextMenu);
  window.removeEventListener('blur', closeFileContextMenu);
}

watch(
  () => [state.open, state.x, state.y, state.path] as const,
  async ([open]) => {
    detach();
    closeOpenWithMenu();
    if (!open) return;
    document.addEventListener('mousedown', onDocPointer);
    window.addEventListener('keydown', onDocKeydown, true);
    window.addEventListener('resize', closeFileContextMenu);
    window.addEventListener('blur', closeFileContextMenu);
    await nextTick();
    const menu = menuRef.value?.el;
    if (!menu) return;
    const margin = 8;
    let top = state.y;
    if (top + menu.offsetHeight > window.innerHeight - margin) {
      top = Math.max(margin, state.y - menu.offsetHeight);
    }
    let left = state.x;
    if (left + menu.offsetWidth > window.innerWidth - margin) {
      left = Math.max(margin, state.x - menu.offsetWidth);
    }
    menuStyle.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
    menu.querySelector<HTMLElement>('.ui-menu-item:not(:disabled)')?.focus();
  },
);

onUnmounted(detach);

async function reveal(): Promise<void> {
  closeFileContextMenu();
  if (revealInFolder === undefined) return;
  const ok = await revealInFolder(targetPath.value);
  if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.revealFailed') });
}

async function openDefault(): Promise<void> {
  closeFileContextMenu();
  if (openWithDefaultApp === undefined) return;
  try {
    const ok = await openWithDefaultApp(targetPath.value);
    if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.openFailed') });
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.openFailed') });
  }
}

async function openApp(appId: string): Promise<void> {
  closeFileContextMenu();
  if (openInService === undefined) return;
  try {
    const ok = await openInService.open(appId, { path: targetPath.value });
    if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.openFailed') });
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.openFailed') });
  }
}

function addToChat(): void {
  closeFileContextMenu();
  insertPathMention?.(state.path, state.kind);
}

async function copyPath(): Promise<void> {
  closeFileContextMenu();
  const ok = await copyTextToClipboard(targetPath.value);
  if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.copyFailed') });
}
</script>

<template>
  <Teleport to="body">
    <Menu
      v-if="state.open"
      ref="menuRef"
      class="file-context-menu"
      :style="menuStyle"
      @click.stop
      @contextmenu.prevent
      @keydown="onParentMenuKeydown"
    >
      <div
        v-if="canOpenWith"
        ref="openWithAnchorRef"
        class="file-context-open-with"
        @mouseenter="openOpenWithMenu()"
      >
        <MenuItem
          :active="openWithMenuOpen"
          has-popup="menu"
          :expanded="openWithMenuOpen"
          @click="openOpenWithMenu($event.detail === 0)"
        >
          <Icon name="grid-dots" size="sm" />
          {{ t('conversation.openWith') }}
          <template #action><Icon name="chevron-right" size="sm" /></template>
        </MenuItem>
      </div>
      <MenuItem v-if="canAddToChat" @mouseenter="closeOpenWithMenu" @focusin="closeOpenWithMenu" @click="addToChat">
        <Icon name="at" size="sm" />
        {{ t('selection.addToChat') }}
      </MenuItem>
      <MenuItem v-if="canReveal" @mouseenter="closeOpenWithMenu" @focusin="closeOpenWithMenu" @click="reveal">
        <Icon name="folder" size="sm" />
        {{ t('conversation.revealInFolder') }}
      </MenuItem>
      <MenuItem v-if="canCopyPath" @mouseenter="closeOpenWithMenu" @focusin="closeOpenWithMenu" @click="copyPath">
        <Icon name="copy" size="sm" />
        {{ t('conversation.copyPath') }}
      </MenuItem>
    </Menu>
    <Menu
      v-if="state.open && openWithMenuOpen"
      ref="subMenuRef"
      class="file-context-submenu"
      :style="subMenuStyle"
      @click.stop
      @contextmenu.prevent
      @keydown="onSubmenuKeydown"
    >
      <MenuItem @click="openDefault">
        <Icon name="external-link" size="sm" />
        {{ t('conversation.openInDefaultApp') }}
      </MenuItem>
      <MenuItem v-if="availableApps.length > 0" separator />
      <MenuItem v-for="app in availableApps" :key="app.id" @click="openApp(app.id)">
        <img v-if="openInService?.icon(app.id)" class="fc-app-icon" :src="openInService?.icon(app.id)" alt="" />
        <Icon v-else name="file-text" size="sm" />
        {{ app.label }}
      </MenuItem>
    </Menu>
  </Teleport>
</template>

<style scoped>
.file-context-menu,
.file-context-submenu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
.file-context-submenu {
  z-index: calc(var(--z-dropdown) + 1);
}
.fc-app-icon {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: var(--radius-xs);
}
</style>
