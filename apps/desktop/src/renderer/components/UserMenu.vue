<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ManagedQuotaResult } from '../api/types';
import { useKimiWebClient, type ColorScheme } from '@moonshot-ai/app-client/client';
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
import { Badge, Button, Icon, Kbd, Menu, MenuItem, Spinner } from '@moonshot-ai/app-ui';

defineProps<{ feedbackEnabled?: boolean }>();
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
const nickname = computed(() => userInfo.value?.nickname || t('sidebar.defaultUserName'));
const showUpgrade = computed(() => membership.value === 'free' || shouldShowUpgrade(userInfo.value?.userLevel));
const showUsageRow = computed(() => membership.value !== 'free');
const accountLevel = computed(() => userInfo.value?.userLevelName?.trim() ?? '');

const avatarLoadFailed = ref(false);
watch(
  () => userInfo.value?.avatar,
  () => {
    avatarLoadFailed.value = false;
  },
);
const showAvatar = computed(() => Boolean(userInfo.value?.avatar) && !avatarLoadFailed.value);

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
  e.stopPropagation();
  closeMenu();
}

async function toggleMenu(): Promise<void> {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocMousedown);
  document.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', closeMenu);
  if (signedIn.value) void loadUsage();
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
  cancelSubmenuClose();
  triggerObserver?.disconnect();
  triggerObserver = null;
  document.removeEventListener('mousedown', onDocMousedown);
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', closeMenu);
}

onBeforeUnmount(closeMenu);

type SubmenuTarget = 'usage' | 'theme' | 'language';

const openSubmenu = ref<SubmenuTarget | null>(null);
const submenuStyle = ref<Record<string, string>>({});
const submenuRef = ref<InstanceType<typeof Menu> | null>(null);
const rowEls: Record<SubmenuTarget, HTMLElement | null> = { usage: null, theme: null, language: null };
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
  void nextTick(positionSubmenu);
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
    type="button"
    aria-haspopup="menu"
    :aria-expanded="menuOpen"
    @click.stop="toggleMenu"
  >
    <template v-if="signedIn">
      <span class="user-menu-avatar" aria-hidden="true">
        <img v-if="showAvatar" :src="userInfo?.avatar" alt="" @error="avatarLoadFailed = true" />
        <Icon v-else name="user" size="sm" />
      </span>
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
    <Transition name="menu-pop">
      <Menu v-if="menuOpen" ref="menuRef" class="user-menu" :style="menuStyle" @click.stop>
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
        <MenuItem v-if="feedbackEnabled" @click="onOpenFeedback" @mouseenter="scheduleSubmenuClose">
          <span class="user-menu-feedback-icon" aria-hidden="true" />
          <span class="user-menu-item-label">{{ t('feedback.menuLabel') }}</span>
        </MenuItem>
        <template v-if="signedIn && !rcMode">
          <MenuItem separator />
          <MenuItem @click="void onLogout()" @mouseenter="scheduleSubmenuClose">
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
    <Transition name="menu-pop">
      <Menu
        v-if="openSubmenu !== null"
        ref="submenuRef"
        class="user-submenu"
        :style="submenuStyle"
        :role="openSubmenu === 'usage' ? 'dialog' : 'menu'"
        @click.stop
        @mouseenter="cancelSubmenuClose"
        @mouseleave="scheduleSubmenuClose"
        @focusin="cancelSubmenuClose"
        @focusout="scheduleSubmenuClose"
      >
        <template v-if="openSubmenu === 'usage'">
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
.user-menu-trigger:hover,
.user-menu-trigger[aria-expanded='true'] {
  background: var(--sb-hover);
}
.user-menu-trigger:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
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
.user-menu-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  overflow: hidden;
}
.user-menu-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
html.macos-desktop.vibrancy .user-menu-avatar {
  background: var(--color-selected);
}
.user-menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
}
.user-submenu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
  width: max-content;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
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
  transform: scale(0.97) translateY(var(--menu-pop-shift, 2px));
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
.user-menu-feedback-icon {
  flex: none;
  width: 16px;
  height: 16px;
  background: currentColor;
  mask: url('./feedback/assets/sidebar-feedback.svg') center / contain no-repeat;
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
