<!-- Sidebar footer account area. Signed in: avatar + nickname; signed out: a
     plain sign-in hint. The trigger opens an upward fixed menu — plan usage
     (weekly + 5h rows, refreshed on every open), the upgrade entry below the
     top plan level, theme / language switches, settings, and sign-out (which
     confirms through the shared modal). -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ManagedUsageResult, UsageRow } from '../api/types';
import { useKimiWebClient, type ColorScheme } from '@moonshot-ai/app-client/client';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { availableLocales, setLocale, type LocaleCode } from '../i18n';
import { resolvedBindingKeys } from '../composables/useShortcuts';
import {
  findUsageByWindow,
  formatResetAt,
  formatUsageLabel,
  resolveSubmenuPlacement,
  shouldShowUpgrade,
  usagePercent,
  usageSeverity,
} from '@moonshot-ai/app-core/lib';
import { isDesktop } from '@moonshot-ai/app-core/lib';
import { track } from '@moonshot-ai/app-client/contracts';
import { openUpgrade } from '@moonshot-ai/app-core/lib';
import { Badge, Button, Icon, Kbd, Menu, MenuItem, Spinner } from '@moonshot-ai/app-ui';

const emit = defineEmits<{
  login: [];
  openSettings: [];
}>();

const { t, locale } = useI18n();
const client = useKimiWebClient();
const { confirm } = useConfirmDialog();

const isProd = import.meta.env.PROD;

const signedIn = computed(() => client.managedProviderStatus.value === 'authenticated');
const userInfo = client.managedUserInfo;
const membership = client.managedMembership;
const nickname = computed(() => userInfo.value?.nickname || t('sidebar.defaultUserName'));
// Free accounts (userinfo 402) have no readable level at all — show the
// upgrade entry for them too, not just for members below the top level.
const showUpgrade = computed(() => membership.value === 'free' || shouldShowUpgrade(userInfo.value?.userLevel));
// Free accounts can't call usages — the usage row would only ever show the
// fetch error, so the menu hides it outright.
const showUsageRow = computed(() => membership.value !== 'free');

// A broken avatar URL falls back to the placeholder glyph; a new avatar URL re-arms the <img>.
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

// Locale names stay in their own language.
const currentLanguageLabel = computed(
  () => availableLocales.find((l) => l.code === locale.value)?.label ?? locale.value,
);

function chooseLanguage(code: LocaleCode): void {
  if (locale.value !== code) {
    setLocale(code);
    track('settings_changed', { key: 'language', value: code, source_panel: 'user_menu' });
  }
}

// Settings-row keycap hint: live resolved binding (follows user overrides); hidden when unassigned.
const settingsShortcutKeys = computed(() => resolvedBindingKeys('openSettings'));

// ---------------------------------------------------------------------------
// Menu open state + fixed positioning: bottom-anchored so expanded usage rows grow the panel upward.
// ---------------------------------------------------------------------------
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

// Capture-phase Escape: ConversationPane's document-level bubble listener
// reads any Escape during a running turn as "interrupt the prompt".
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
  // top and bottom are always set as a pair ('auto' for the unused one): the
  // .user-menu class pins top:0 for the pre-positioning frame, and a leftover
  // top alongside bottom would stretch the menu to full height.
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
  // The flyout is anchored to the parent menu's old box; close it rather than chasing the resize.
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

// ---------------------------------------------------------------------------
// Flyout submenu (macOS-style) — single-value state, at most one open at a time.
// ---------------------------------------------------------------------------
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

// preventDefault keeps Space from scrolling and Enter from re-triggering a click.
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
  // Measure free of the previous inline cap: switching targets reuses this
  // element, and a stale maxWidth would shrink the natural-width read.
  submenu.style.maxWidth = 'none';
  const subH = submenu.offsetHeight;
  const subW = submenu.offsetWidth;
  // Content-sized up to the open side's viewport room — usage hints only
  // ellipsize when the window itself is too narrow.
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

// ---------------------------------------------------------------------------
// Plan usage (signed-in only), rendered inside the usage flyout.
// ---------------------------------------------------------------------------
const usageLoading = ref(false);
const usageResult = ref<ManagedUsageResult | null>(null);
// Generation guard: a superseded fetch's late answer must not overwrite the newest one's state.
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

// The usage fetch can land while the flyout is already open on the narrow
// loading state (same on retry) — re-measure once the new content renders,
// or the stale inline cap keeps truncating the real rows.
watch([usageLoading, usageResult], async () => {
  if (openSubmenu.value !== 'usage') return;
  await nextTick();
  positionSubmenu();
});

const usageRows = computed<UsageRow[]>(() => {
  if (usageResult.value?.kind !== 'ok') return [];
  const { summary, limits } = usageResult.value;
  const fiveHour = findUsageByWindow(limits, 5, 'hour');
  return [summary, fiveHour].filter((row): row is UsageRow => row != null);
});

const usageErrorMessage = computed(() =>
  usageResult.value?.kind === 'error' ? usageResult.value.message : t('settings.planUsage.loadFailed'),
);

function resetHint(row: UsageRow): string {
  return row.resetAt === undefined ? '' : formatResetAt(row.resetAt, t);
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
    </template>
    <template v-else>
      <Icon name="user" />
      <span class="user-menu-name">{{ t('sidebar.notSignedIn') }}</span>
    </template>
    <Badge v-if="isDesktop && isProd" class="user-menu-badge" variant="warning" size="sm">
      {{ t('settings.internalTest') }}
    </Badge>
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
        <template v-else>
          <MenuItem class="user-menu-login" @click="onLogin" @mouseenter="scheduleSubmenuClose">
            <Icon name="log-in" size="sm" />
            <span class="user-menu-item-label user-menu-login-label">{{ t('sidebar.signIn') }}</span>
          </MenuItem>
          <MenuItem separator />
        </template>

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
        <MenuItem @click="onOpenSettings" @mouseenter="scheduleSubmenuClose">
          <Icon name="settings" size="sm" />
          <span class="user-menu-item-label">{{ t('settings.title') }}</span>
          <Kbd v-if="settingsShortcutKeys.length > 0" :keys="settingsShortcutKeys" />
        </MenuItem>
        <template v-if="signedIn">
          <MenuItem separator />
          <MenuItem @click="void onLogout()" @mouseenter="scheduleSubmenuClose">
            <Icon name="log-out" size="sm" />
            {{ t('sidebar.signOut') }}
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
            <div v-for="(row, index) in usageRows" v-else :key="index" class="user-menu-usage-row">
              <span class="user-menu-usage-label">{{ formatUsageLabel(row, t) }}</span>
              <span class="user-menu-usage-value" :class="`sev-${usageSeverity(row.used, row.limit)}`">
                {{ t('settings.planUsage.usedPct', { pct: usagePercent(row.used, row.limit) }) }}
              </span>
              <span v-if="resetHint(row)" class="user-menu-usage-hint">{{ resetHint(row) }}</span>
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
/* Trigger — same list-style control family as the sidebar's search / New chat rows (not a Button). */
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
/* macOS desktop: the sidebar footer pins the chip --sb-inset from the
   window's left edge and its --space-2 block padding (also 8px) from the
   bottom edge, so the chip's bottom-left arc shares the window corner's
   center — concentric via --radius-window-chip. Web and other platforms
   have no rounded container corner here and keep the uniform --radius-sm. */
html.macos-desktop .user-menu-trigger {
  border-bottom-left-radius: var(--radius-window-chip);
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
.user-menu-name {
  /* Explicit shrink floor for the trailing badge: overflow:hidden already zeroes
     the automatic minimum size, this just makes the intent obvious. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-menu-badge {
  flex: none;
}

/* Class-level top:0 is only the pre-positioning frame — menuStyle always sets both vertical axes. */
.user-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  /* Menu labels are chrome, not content — drag-selecting must not highlight them. */
  user-select: none;
}
/* Flyout — content-adaptive width; positionSubmenu caps it at the open side's viewport room via maxWidth. */
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

/* Rows ride the §03 MenuItem md density verbatim (7px icon gap, --text-sm
   labels on --leading-tight) — no local override. The usage flyout is custom
   content rather than MenuItems, so it reads the primitive's shared inset
   tokens and mirrors its line box, with the reset hint one rung down. Each row
   is a two-column grid — label + end-justified percent on the first line, the
   reset hint spanning both columns on the second — and stacked rows sit one
   menu-item rhythm apart (two adjacent items' block paddings add up). */
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
  /* label | percent (end-justified) on line 1; the reset hint spans both
     columns on line 2, free to run under the percent, so the top line's
     column split never squeezes it. */
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
.user-menu-usage-value.sev-warn {
  color: var(--color-warning);
}
.user-menu-usage-value.sev-danger {
  color: var(--color-danger);
}

.user-menu-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-menu-login-label {
  color: var(--color-accent);
}

.user-menu-row-value {
  flex: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
</style>
