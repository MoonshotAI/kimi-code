<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import FeedbackIcon from '~icons/kimi/feedback';
import UserMenuWorkspaceItem from './UserMenuWorkspaceItem.vue';
import type { ManagedQuotaResult, ManagedWorkspace } from '../api/types';
import { toast, useKimiWebClient, type ColorScheme } from '@moonshot-ai/app-client/client';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { availableLocales, setLocale, type LocaleCode } from '../i18n';
import { resolvedBindingKeys } from '../composables/useShortcuts';
import {
  formatQuotaLabel,
  formatResetAt,
  isRcLocation,
  quotaUsageRows,
  resolveSubmenuPlacement,
  shouldShowUpgrade,
  usagePercent,
} from '@moonshot-ai/app-core/lib';
import { track } from '@moonshot-ai/app-client/contracts';
import { openUpgrade } from '@moonshot-ai/app-core/lib';
import {
  Avatar,
  Badge,
  Button,
  focusMenuContainerItem,
  Icon,
  Kbd,
  Menu,
  MenuItem,
  MenuSearch,
  ScrollArea,
  Spinner,
} from '@moonshot-ai/app-ui';

const INLINE_WORKSPACE_LIMIT = 3;

const emit = defineEmits<{
  login: [];
  openSettings: [];
  openFeedback: [];
}>();

const { t, locale } = useI18n();
const client = useKimiWebClient();
const { confirm } = useConfirmDialog();

const signedIn = computed(() => client.managedProviderStatus.value === 'authenticated');
const rcMode = isRcLocation(window.location);
const userInfo = client.managedUserInfo;
const membership = client.managedMembership;
const managedWorkspaces = client.managedWorkspaces;
const workspacesLoading = client.managedWorkspacesLoading;
const workspacesError = client.managedWorkspacesError;
const hasBusinessWorkspace = client.hasBusinessWorkspace;
const currentWorkspace = client.currentManagedWorkspace;
const recentWorkspaceKeys = client.recentWorkspaceKeys;
const switchingKey = client.switchingWorkspaceKey;
const switchingName = client.switchingWorkspaceName;
const isSwitchingWorkspace = computed(() => switchingKey.value !== null);

const nickname = computed(() => userInfo.value?.nickname || t('sidebar.defaultUserName'));
const showUpgrade = computed(() => membership.value === 'free' || shouldShowUpgrade(userInfo.value?.userLevel));
const showUsageRow = computed(() => membership.value !== 'free');
const accountLevel = computed(() => userInfo.value?.userLevelName?.trim() ?? '');

const activeWorkspaceSubtitle = computed(() => {
  if (!hasBusinessWorkspace.value) return '';
  const serverWorkspaceName = userInfo.value?.workspaceName?.trim();
  if (currentWorkspace.value?.kind === 'business') {
    return serverWorkspaceName || currentWorkspace.value.name;
  }
  if (currentWorkspace.value?.kind === 'personal') {
    return t('account.personalWorkspace');
  }
  return serverWorkspaceName || t('account.personalWorkspace');
});

const duplicateBusinessNames = computed(() => {
  const counts = new Map<string, number>();
  for (const ws of managedWorkspaces.value) {
    if (ws.kind !== 'business') continue;
    counts.set(ws.name, (counts.get(ws.name) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) duplicates.add(name);
  }
  return duplicates;
});

const primaryWorkspaces = computed<readonly ManagedWorkspace[]>(() => {
  const all = managedWorkspaces.value;
  if (all.length <= INLINE_WORKSPACE_LIMIT) return all;
  const picked: ManagedWorkspace[] = [];
  const pickedKeys = new Set<string>();
  const add = (entry: ManagedWorkspace | undefined): void => {
    if (!entry || pickedKeys.has(entry.key) || picked.length >= INLINE_WORKSPACE_LIMIT) return;
    picked.push(entry);
    pickedKeys.add(entry.key);
  };
  add(all.find((entry) => entry.current));
  for (const key of recentWorkspaceKeys.value) {
    add(all.find((entry) => entry.key === key));
  }
  for (const entry of all) {
    add(entry);
  }
  return picked;
});

const overflowWorkspaces = computed<readonly ManagedWorkspace[]>(() => {
  const all = managedWorkspaces.value;
  if (all.length <= INLINE_WORKSPACE_LIMIT) return [];
  const primaryKeys = new Set(primaryWorkspaces.value.map((entry) => entry.key));
  return all.filter((entry) => !primaryKeys.has(entry.key));
});

const workspaceQuery = ref('');
const workspaceSearchRef = ref<InstanceType<typeof MenuSearch> | null>(null);

const filteredOverflowWorkspaces = computed<readonly ManagedWorkspace[]>(() => {
  const q = workspaceQuery.value.trim().toLowerCase();
  if (!q) return overflowWorkspaces.value;
  return overflowWorkspaces.value.filter((entry) => {
    if (entry.name.toLowerCase().includes(q)) return true;
    if (entry.kind === 'business' && entry.businessId.toLowerCase().includes(q)) return true;
    return false;
  });
});

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'W';
  const first = Array.from(trimmed)[0] ?? 'W';
  return first.toUpperCase();
}

function workspaceSubtitle(ws: ManagedWorkspace): string {
  if (ws.kind === 'personal') return t('account.personalWorkspace');
  if (ws.disabled) return t('account.workspaceDisabledHint');
  if (duplicateBusinessNames.value.has(ws.name)) {
    return `${t('account.businessWorkspace')} · #${ws.businessId.slice(-4)}`;
  }
  return t('account.businessWorkspace');
}

function workspaceTooltip(ws: ManagedWorkspace): string {
  const kindText =
    ws.kind === 'personal' ? t('account.personalWorkspace') : t('account.businessWorkspace');
  if (ws.kind === 'business' && ws.disabled) {
    return `${ws.name} · ${t('account.workspaceDisabledTitle')} (${t('account.workspaceDisabledHint')})`;
  }
  return `${ws.name} · ${kindText}`;
}

async function onSelectWorkspace(ws: ManagedWorkspace): Promise<void> {
  if (ws.disabled || isSwitchingWorkspace.value) return;
  if (ws.current) {
    closeMenu();
    return;
  }
  const target =
    ws.kind === 'personal'
      ? ({ kind: 'personal' } as const)
      : ({ kind: 'business', businessId: ws.businessId } as const);
  const outcome = await client.switchManagedWorkspace(target, ws.name);
  if (outcome.ok) {
    usageResult.value = null;
    closeMenu();
    toast({
      variant: 'info',
      position: 'bottom-right',
      title: t('account.switchSuccessToast', { name: ws.name }),
    });
    if (outcome.warning) {
      client.notify({ severity: 'warning', title: outcome.warning });
    }
    return;
  }
  if (!outcome.revoked && outcome.message) {
    toast({
      variant: 'danger',
      position: 'bottom-right',
      title: t('account.switchFailedTitle'),
      message: outcome.message,
    });
  }
}

function clearWorkspaceSearch(): void {
  workspaceQuery.value = '';
  void nextTick(() => workspaceSearchRef.value?.focus());
}

const colorScheme = client.colorScheme;
const themeLabel = computed(() => t(`theme.${colorScheme.value}`));
const themeIcon = computed(() =>
  colorScheme.value === 'light' ? 'light-mode' : colorScheme.value === 'dark' ? 'dark-mode' : 'follow-system',
);
const themeOptions: readonly { value: ColorScheme; labelKey: string; icon: string }[] = [
  { value: 'light', labelKey: 'theme.light', icon: 'light-mode' },
  { value: 'dark', labelKey: 'theme.dark', icon: 'dark-mode' },
  { value: 'system', labelKey: 'theme.system', icon: 'follow-system' },
];

function chooseColorScheme(scheme: ColorScheme): void {
  client.setColorScheme(scheme);
  track('settings_changed', { key: 'theme', value: scheme, source_panel: 'user_menu' });
}

const currentLanguageLabel = computed(
  () => availableLocales.find((l) => l.code === locale.value)?.label ?? locale.value,
);

function chooseLanguage(code: LocaleCode): void {
  if (locale.value !== code) {
    setLocale(code);
    track('settings_changed', { key: 'language', value: code, source_panel: 'user_menu' });
  }
}

const settingsShortcutKeys = computed(() => resolvedBindingKeys('openSettings'));

const menuOpen = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
let triggerObserver: ResizeObserver | null = null;

function onDocMousedown(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.user-menu') || target.closest('.user-menu-trigger') || target.closest('.user-submenu')) return;
  closeMenu();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  if (openSubmenu.value === 'workspaces') {
    closeWorkspacesSubmenu();
  } else {
    closeMenu();
  }
}

async function toggleMenu(): Promise<void> {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  if (signedIn.value) void loadUsage();
  document.addEventListener('mousedown', onDocMousedown);
  document.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', closeMenu);
  await nextTick();
  positionMenu();
  const btn = triggerRef.value;
  if (btn) {
    triggerObserver = new ResizeObserver(syncMenuBox);
    triggerObserver.observe(btn);
  }
}

function positionMenu(): void {
  const btn = triggerRef.value;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu.offsetHeight;
  const box = { left: `${Math.round(r.left)}px`, width: `${Math.round(r.width)}px` };
  if (r.top - menuH - gap < margin) {
    menuStyle.value = {
      ...box,
      top: `${Math.round(Math.min(r.bottom + gap, window.innerHeight - menuH - margin))}px`,
      bottom: 'auto',
      transformOrigin: 'top left',
      '--menu-pop-shift': '-2px',
    };
  } else {
    menuStyle.value = {
      ...box,
      top: 'auto',
      bottom: `${Math.round(window.innerHeight - r.top + gap)}px`,
      transformOrigin: 'bottom left',
      '--menu-pop-shift': '2px',
    };
  }
}

function syncMenuBox(): void {
  const btn = triggerRef.value;
  if (!btn) return;
  openSubmenu.value = null;
  const r = btn.getBoundingClientRect();
  menuStyle.value = {
    ...menuStyle.value,
    left: `${Math.round(r.left)}px`,
    width: `${Math.round(r.width)}px`,
  };
}

function closeMenu(): void {
  menuOpen.value = false;
  openSubmenu.value = null;
  workspaceQuery.value = '';
  cancelSubmenuClose();
  triggerObserver?.disconnect();
  triggerObserver = null;
  document.removeEventListener('mousedown', onDocMousedown);
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', closeMenu);
}

onBeforeUnmount(closeMenu);

type SubmenuTarget = 'workspaces' | 'usage' | 'theme' | 'language';

const openSubmenu = ref<SubmenuTarget | null>(null);
const submenuStyle = ref<Record<string, string>>({});
const submenuRef = ref<InstanceType<typeof Menu> | null>(null);
const rowEls: Record<SubmenuTarget, HTMLElement | null> = {
  workspaces: null,
  usage: null,
  theme: null,
  language: null,
};
let submenuCloseTimer: ReturnType<typeof setTimeout> | null = null;

function setRowRef(target: SubmenuTarget) {
  return (el: Element | ComponentPublicInstance | null): void => {
    rowEls[target] =
      el instanceof HTMLElement ? el : (((el as ComponentPublicInstance | null)?.$el as HTMLElement | undefined) ?? null);
  };
}

function openSubmenuFor(target: SubmenuTarget): void {
  cancelSubmenuClose();
  if (openSubmenu.value === target) return;
  openSubmenu.value = target;
  void nextTick(() => {
    positionSubmenu();
    if (target === 'workspaces') {
      workspaceSearchRef.value?.focus();
    }
  });
}

function closeWorkspacesSubmenu(): void {
  openSubmenu.value = null;
  workspaceQuery.value = '';
  rowEls.workspaces?.focus();
}

function onWorkspacesSubmenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.value.length > 0) return;
    e.preventDefault();
    closeWorkspacesSubmenu();
    return;
  }
  if (e.key === 'Tab') return;
  if (focusMenuContainerItem(submenuRef.value?.el, e.key, e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function onSubmenuFocusOut(e: FocusEvent): void {
  const target = e.target;
  if (target instanceof Node && !submenuRef.value?.el?.contains(target)) {
    return;
  }
  const related = e.relatedTarget;
  if (related instanceof Node && submenuRef.value?.el?.contains(related)) {
    return;
  }
  scheduleSubmenuClose();
}

function onParentRowKeydown(e: KeyboardEvent, target: SubmenuTarget): void {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  openSubmenuFor(target);
}

function scheduleSubmenuClose(): void {
  cancelSubmenuClose();
  submenuCloseTimer = setTimeout(() => {
    openSubmenu.value = null;
    submenuCloseTimer = null;
  }, 250);
}

function cancelSubmenuClose(): void {
  if (submenuCloseTimer !== null) {
    clearTimeout(submenuCloseTimer);
    submenuCloseTimer = null;
  }
}

function positionSubmenu(): void {
  const target = openSubmenu.value;
  const menu = menuRef.value?.el;
  const submenu = submenuRef.value?.el;
  const row = target !== null ? rowEls[target] : null;
  if (!menu || !submenu || !row) return;
  const gap = 4;
  const margin = 8;
  const menuR = menu.getBoundingClientRect();
  const rowR = row.getBoundingClientRect();
  submenu.style.maxWidth = 'none';
  const subH = submenu.offsetHeight;
  const subW = submenu.offsetWidth;
  const { left, maxWidth, flipped } = resolveSubmenuPlacement(subW, menuR, window.innerWidth, gap, margin);
  const top = Math.max(margin, Math.min(rowR.top, window.innerHeight - subH - margin));
  submenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    maxWidth: `${Math.round(maxWidth)}px`,
    transformOrigin: flipped ? 'top right' : 'top left',
    '--menu-pop-shift': '-2px',
  };
}

const usageLoading = ref(false);
const usageResult = ref<ManagedQuotaResult | null>(null);
let usageFetchGeneration = 0;

async function loadUsage(): Promise<void> {
  const generation = ++usageFetchGeneration;
  usageLoading.value = true;
  try {
    const result = await client.getUsage();
    if (generation === usageFetchGeneration) usageResult.value = result;
  } finally {
    if (generation === usageFetchGeneration) usageLoading.value = false;
  }
}

watch([usageLoading, usageResult], async () => {
  if (openSubmenu.value !== 'usage') return;
  await nextTick();
  positionSubmenu();
});

watch(menuOpen, (open) => {
  workspaceQuery.value = '';
  if (open && signedIn.value && !isSwitchingWorkspace.value) {
    void client.probeManagedMembership();
  }
});

watch(overflowWorkspaces, (items) => {
  if (openSubmenu.value === 'workspaces' && items.length === 0 && !workspacesLoading.value && !workspacesError.value) {
    openSubmenu.value = null;
    workspaceQuery.value = '';
  }
});

watch([signedIn, client.businessMembershipRevokedOpen], ([nextSignedIn, revokedOpen]) => {
  if (menuOpen.value && (!nextSignedIn || revokedOpen)) {
    closeMenu();
  }
});

watch([managedWorkspaces, switchingName], async () => {
  if (!menuOpen.value) return;
  await nextTick();
  positionMenu();
  if (openSubmenu.value !== null) positionSubmenu();
});

watch([workspaceQuery, workspacesLoading, workspacesError], async () => {
  if (openSubmenu.value !== 'workspaces') return;
  await nextTick();
  positionSubmenu();
});

const usageRows = computed(() => {
  if (usageResult.value?.kind !== 'ok') return [];
  return quotaUsageRows(usageResult.value.quota);
});

const usageErrorMessage = computed(() =>
  usageResult.value?.kind === 'error' ? usageResult.value.message : t('settings.planUsage.loadFailed'),
);

function resetHint(resetAt: string | undefined): string {
  return resetAt === undefined ? '' : formatResetAt(resetAt, t);
}

function onUpgrade(): void {
  closeMenu();
  openUpgrade();
  track('upgrade_clicked', {});
}

function onLogin(): void {
  closeMenu();
  emit('login');
}

function onOpenSettings(): void {
  closeMenu();
  emit('openSettings');
}

function onOpenFeedback(): void {
  closeMenu();
  emit('openFeedback');
}

async function onLogout(): Promise<void> {
  closeMenu();
  await confirm({
    title: t('sidebar.logoutConfirmTitle'),
    message: t('sidebar.logoutConfirmMessage'),
    variant: 'danger',
    action: () => client.logout(),
  });
}
</script>

<template>
  <button
    ref="triggerRef"
    class="user-menu-trigger"
    :class="{ 'user-menu-trigger--stacked': signedIn && hasBusinessWorkspace }"
    type="button"
    aria-haspopup="menu"
    :aria-expanded="menuOpen"
    @click.stop="toggleMenu"
  >
    <template v-if="signedIn && hasBusinessWorkspace">
      <Avatar :src="userInfo?.avatar" size="sm" shape="circle" aria-hidden="true">
        <template v-if="!userInfo?.avatar">{{ workspaceInitial(nickname) }}</template>
      </Avatar>
      <span class="user-menu-identity">
        <span class="user-menu-identity-top">
          <span class="user-menu-name">{{ nickname }}</span>
          <Badge v-if="accountLevel" variant="neutral" size="sm">{{ accountLevel }}</Badge>
        </span>
        <span class="user-menu-workspace-sub">{{ activeWorkspaceSubtitle }}</span>
      </span>
    </template>
    <template v-else-if="signedIn">
      <Avatar :src="userInfo?.avatar" size="sm" shape="circle" aria-hidden="true" />
      <span class="user-menu-name">{{ nickname }}</span>
      <Badge v-if="accountLevel" variant="neutral" size="sm">{{ accountLevel }}</Badge>
    </template>
    <template v-else>
      <Icon name="user" />
      <span class="user-menu-name">{{ t('sidebar.notSignedIn') }}</span>
    </template>
  </button>

  <!-- Teleport: the sidebar column's container-type would capture position:fixed and mis-anchor the menu. -->
  <Teleport to="body">
    <Transition name="ui-menu-pop">
      <Menu v-if="menuOpen" ref="menuRef" class="ui-menu-floating user-menu" :style="menuStyle" @click.stop>
        <template v-if="signedIn && hasBusinessWorkspace">
          <div class="user-menu-section-title">{{ t('account.workspaceSection') }}</div>
          <template v-if="primaryWorkspaces.length > 0">
            <UserMenuWorkspaceItem
              v-for="ws in primaryWorkspaces"
              :key="ws.key"
              :workspace="ws"
              :avatar-src="userInfo?.avatar"
              :initial="workspaceInitial(ws.name)"
              :subtitle="workspaceSubtitle(ws)"
              :tooltip="workspaceTooltip(ws)"
              :disabled="ws.disabled || isSwitchingWorkspace"
              :switching="switchingKey === ws.key"
              @mouseenter="scheduleSubmenuClose"
              @select="void onSelectWorkspace($event)"
            />
          </template>
          <div v-else-if="workspacesLoading" class="user-menu-ws-inline-state">
            <Spinner size="sm" />
            <span>{{ t('account.loadingWorkspaces') }}</span>
          </div>
          <div v-if="workspacesError && !workspacesLoading" class="user-menu-ws-inline-state user-menu-ws-inline-state--error">
            <span>{{ t('account.loadWorkspacesFailed') }}</span>
            <Button variant="ghost" size="sm" @click="void client.reloadManagedWorkspaces()">
              {{ t('account.retryWorkspaces') }}
            </Button>
          </div>

          <div v-if="switchingName" class="user-menu-ws-progress" role="status">
            {{ t('account.switchingTo', { name: switchingName }) }}
          </div>

          <MenuItem
            v-if="overflowWorkspaces.length > 0"
            :ref="setRowRef('workspaces')"
            has-popup="dialog"
            :expanded="openSubmenu === 'workspaces'"
            @mouseenter="openSubmenuFor('workspaces')"
            @mouseleave="scheduleSubmenuClose"
            @click="openSubmenuFor('workspaces')"
            @keydown="onParentRowKeydown($event, 'workspaces')"
          >
            <Icon name="view-switch" size="sm" />
            <span class="user-menu-item-label">{{ t('account.moreWorkspaces') }}</span>
            <span v-if="!workspacesLoading" class="user-menu-row-value">{{ overflowWorkspaces.length }}</span>
            <Icon name="chevron-right" size="sm" />
          </MenuItem>

          <MenuItem separator />
        </template>

        <template v-if="signedIn">
          <MenuItem
            v-if="showUsageRow"
            :ref="setRowRef('usage')"
            aria-haspopup="true"
            :aria-expanded="openSubmenu === 'usage'"
            @mouseenter="openSubmenuFor('usage')"
            @mouseleave="scheduleSubmenuClose"
            @focus="openSubmenuFor('usage')"
            @blur="scheduleSubmenuClose"
            @click="openSubmenuFor('usage')"
            @keydown="onParentRowKeydown($event, 'usage')"
          >
            <Icon name="histogram" size="sm" />
            <span class="user-menu-item-label">{{ t('settings.planUsage.title') }}</span>
            <Icon name="chevron-right" size="sm" />
          </MenuItem>
          <MenuItem v-if="showUpgrade" @click="onUpgrade" @mouseenter="scheduleSubmenuClose">
            <Icon name="music" size="sm" />
            <span class="user-menu-item-label">{{ t('sidebar.upgradeMembership') }}</span>
            <Icon name="external-link" size="sm" />
          </MenuItem>
          <MenuItem separator />
        </template>

        <MenuItem @click="onOpenSettings" @mouseenter="scheduleSubmenuClose">
          <Icon name="settings" size="sm" />
          <span class="user-menu-item-label">{{ t('settings.title') }}</span>
          <Kbd v-if="settingsShortcutKeys.length > 0" :keys="settingsShortcutKeys" />
        </MenuItem>
        <MenuItem
          :ref="setRowRef('theme')"
          aria-haspopup="true"
          :aria-expanded="openSubmenu === 'theme'"
          @mouseenter="openSubmenuFor('theme')"
          @mouseleave="scheduleSubmenuClose"
          @focus="openSubmenuFor('theme')"
          @blur="scheduleSubmenuClose"
          @click="openSubmenuFor('theme')"
          @keydown="onParentRowKeydown($event, 'theme')"
        >
          <Icon :name="themeIcon" size="sm" />
          <span class="user-menu-item-label">{{ t('theme.colorSchemeLabel') }}</span>
          <span class="user-menu-row-value">{{ themeLabel }}</span>
          <Icon name="chevron-right" size="sm" />
        </MenuItem>
        <MenuItem
          :ref="setRowRef('language')"
          aria-haspopup="true"
          :aria-expanded="openSubmenu === 'language'"
          @mouseenter="openSubmenuFor('language')"
          @mouseleave="scheduleSubmenuClose"
          @focus="openSubmenuFor('language')"
          @blur="scheduleSubmenuClose"
          @click="openSubmenuFor('language')"
          @keydown="onParentRowKeydown($event, 'language')"
        >
          <Icon name="translate" size="sm" />
          <span class="user-menu-item-label">{{ t('sidebar.language') }}</span>
          <span class="user-menu-row-value">{{ currentLanguageLabel }}</span>
          <Icon name="chevron-right" size="sm" />
        </MenuItem>
        <MenuItem @click="onOpenFeedback" @mouseenter="scheduleSubmenuClose">
          <FeedbackIcon aria-hidden="true" />
          <span class="user-menu-item-label">{{ t('feedback.menuLabel') }}</span>
        </MenuItem>
        <template v-if="signedIn && !rcMode">
          <MenuItem separator />
          <MenuItem :disabled="isSwitchingWorkspace" @click="void onLogout()" @mouseenter="scheduleSubmenuClose">
            <Icon name="log-out" size="sm" />
            {{ t('sidebar.signOut') }}
          </MenuItem>
        </template>
        <template v-else-if="!signedIn">
          <MenuItem separator />
          <MenuItem class="user-menu-login" @click="onLogin" @mouseenter="scheduleSubmenuClose">
            <Icon name="log-in" size="sm" />
            <span class="user-menu-item-label user-menu-login-label">{{ t('sidebar.signIn') }}</span>
          </MenuItem>
        </template>
      </Menu>
    </Transition>
  </Teleport>

  <!-- Sibling teleport: stacks above the parent menu by DOM order at the same --z-dropdown tier. -->
  <Teleport to="body">
    <Transition name="ui-menu-pop">
      <Menu
        v-if="openSubmenu !== null"
        ref="submenuRef"
        class="ui-menu-floating user-submenu"
        :class="{ 'user-submenu--workspaces': openSubmenu === 'workspaces' }"
        :style="submenuStyle"
        :role="openSubmenu === 'usage' || openSubmenu === 'workspaces' ? 'dialog' : 'menu'"
        @click.stop
        @mouseenter="cancelSubmenuClose"
        @mouseleave="scheduleSubmenuClose"
        @focusin="cancelSubmenuClose"
        @focusout="onSubmenuFocusOut"
        @keydown="openSubmenu === 'workspaces' ? onWorkspacesSubmenuKeydown($event) : undefined"
      >
        <template v-if="openSubmenu === 'workspaces'">
          <MenuSearch
            ref="workspaceSearchRef"
            v-model="workspaceQuery"
            :placeholder="t('account.searchWorkspaces')"
            divider
            @escape="closeWorkspacesSubmenu"
          />
          <ScrollArea class="user-menu-ws-scroll">
            <div v-if="workspacesLoading && overflowWorkspaces.length === 0" class="user-menu-ws-panel-state">
              <Spinner size="sm" />
              <span>{{ t('account.loadingWorkspaces') }}</span>
            </div>
            <div v-else-if="workspacesError && overflowWorkspaces.length === 0" class="user-menu-ws-panel-state">
              <Icon name="warning" size="md" />
              <span>{{ t('account.loadWorkspacesFailed') }}</span>
              <Button variant="secondary" size="sm" @click="void client.reloadManagedWorkspaces()">
                {{ t('account.retryWorkspaces') }}
              </Button>
            </div>
            <div v-else-if="filteredOverflowWorkspaces.length === 0" class="user-menu-ws-panel-state">
              <span>{{ t('account.noMatchingWorkspaces') }}</span>
              <Button variant="secondary" size="sm" @click="clearWorkspaceSearch">
                {{ t('account.clearSearch') }}
              </Button>
            </div>
            <template v-else>
              <UserMenuWorkspaceItem
                v-for="ws in filteredOverflowWorkspaces"
                :key="ws.key"
                role="button"
                :workspace="ws"
                :avatar-src="userInfo?.avatar"
                :initial="workspaceInitial(ws.name)"
                :subtitle="workspaceSubtitle(ws)"
                :tooltip="workspaceTooltip(ws)"
                :disabled="ws.disabled || isSwitchingWorkspace"
                :switching="switchingKey === ws.key"
                @select="void onSelectWorkspace($event)"
              />
            </template>
          </ScrollArea>
        </template>
        <template v-else-if="openSubmenu === 'usage'">
          <div class="user-menu-usage">
            <div v-if="usageLoading" class="user-menu-usage-state">
              <Spinner size="sm" />
            </div>
            <div v-else-if="usageResult?.kind !== 'ok'" class="user-menu-usage-state">
              <span class="user-menu-usage-error">{{ usageErrorMessage }}</span>
              <Button variant="ghost" size="sm" @click="void loadUsage()">{{ t('settings.planUsage.retry') }}</Button>
            </div>
            <span v-else-if="usageRows.length === 0" class="user-menu-usage-state user-menu-usage-empty">
              {{ t('settings.planUsage.empty') }}
            </span>
            <div v-for="row in usageRows" v-else :key="row.key" class="user-menu-usage-row">
              <span class="user-menu-usage-label">{{ formatQuotaLabel(row.key, t) }}</span>
              <span class="user-menu-usage-value">
                {{ t('settings.planUsage.usedPct', { pct: usagePercent(row.entry.usedRatio) }) }}
              </span>
              <span v-if="resetHint(row.entry.resetAt)" class="user-menu-usage-hint">{{ resetHint(row.entry.resetAt) }}</span>
            </div>
          </div>
        </template>
        <template v-else-if="openSubmenu === 'theme'">
          <MenuItem v-for="opt in themeOptions" :key="opt.value" @click="chooseColorScheme(opt.value)">
            <Icon :name="opt.icon" size="sm" />
            <span class="user-menu-item-label">{{ t(opt.labelKey) }}</span>
            <Icon v-if="colorScheme === opt.value" name="check" size="sm" />
          </MenuItem>
        </template>
        <template v-else>
          <MenuItem v-for="opt in availableLocales" :key="opt.code" @click="chooseLanguage(opt.code)">
            <span class="user-menu-item-label">{{ opt.label }}</span>
            <Icon v-if="locale === opt.code" name="check" size="sm" />
          </MenuItem>
        </template>
      </Menu>
    </Transition>
  </Teleport>
</template>

<style scoped>
.user-menu-trigger {
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border: none;
  border-radius: var(--radius-sm);
}
.user-menu-trigger--stacked {
  padding-top: 6px;
  padding-bottom: 6px;
}
.user-menu-trigger:hover,
.user-menu-trigger[aria-expanded='true'] {
  background: var(--sb-hover);
}
html.macos-desktop .user-menu-trigger {
  border-bottom-left-radius: var(--radius-window-chip);
}
html.macos-desktop.vibrancy .user-menu-trigger :deep(.ui-badge--neutral) {
  background: var(--color-selected);
}
.user-menu-trigger svg {
  flex: none;
}
html.macos-desktop.vibrancy .user-menu-trigger :deep(.ui-avatar) {
  background: var(--color-selected);
}
.user-menu-identity {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
}
.user-menu-identity-top {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}
.user-menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-menu-workspace-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
}

.user-menu {
  --menu-pop-shift: 2px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
}
.user-submenu {
  --menu-pop-shift: 2px;
  width: max-content;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
}
.user-submenu--workspaces {
  width: 220px;
  overflow: hidden;
}
.user-menu-section-title {
  padding: 4px var(--menu-item-padding-inline);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: 18px;
  color: var(--color-text-faint);
}
.user-menu-ws-progress {
  padding: 4px var(--menu-item-padding-inline);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  line-height: 18px;
  color: var(--color-text-muted);
}
.user-menu-ws-inline-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--menu-item-padding-inline);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.user-menu-ws-inline-state--error {
  justify-content: space-between;
}
.user-menu-ws-scroll {
  max-height: min(392px, calc(100vh - 68px));
}
.user-menu-ws-panel-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2-5);
  padding: var(--space-6) var(--space-3);
  text-align: center;
  font-size: var(--text-xs);
  line-height: 18px;
  color: var(--color-text-muted);
}
.user-menu-usage {
  display: flex;
  flex-direction: column;
  gap: calc(var(--menu-item-padding-block) * 2);
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
}
.user-menu-usage-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.user-menu-usage-error {
  flex: 1;
  min-width: 0;
}
.user-menu-usage-empty {
  color: var(--color-text-faint);
}
.user-menu-usage-row {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: var(--space-3);
  row-gap: var(--space-05);
}
.user-menu-usage-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
  color: var(--color-text);
}
.user-menu-usage-hint {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--color-text-faint);
}
.user-menu-usage-value {
  justify-self: end;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.user-menu-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-menu-item-label:has(+ .user-menu-row-value) {
  flex: 1 0 auto;
}
.user-menu-login-label {
  color: var(--color-accent);
}

.user-menu-row-value {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
</style>

<style scoped src="@moonshot-ai/app-components/sidebar-row-button.css"></style>
