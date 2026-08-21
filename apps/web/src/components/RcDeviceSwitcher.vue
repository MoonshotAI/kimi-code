<!-- apps/web/src/components/RcDeviceSwitcher.vue -->
<!-- rc (remote control) device switcher for rc mode (URL carries ?rc=1).
     Mounts: desktop — the sidebar's top row; mobile — the top of
     MobileSwitcherSheet (the switcher bottom sheet). Shows the current device
     and opens a menu listing GET /v1/remote/devices grouped into 可连接
     (online) / 不可用 (offline). Picking another online device is a full-page
     navigation to /devices/<id>/ (the relay routes API traffic from there).
     Web-only — desktop's sidebar fork has no rc mode. URL/query helpers live
     in app-core's lib/rcDevices.ts. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem, Spinner, StatusDot } from '@moonshot-ai/app-ui';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import {
  deviceUrl,
  isRcLocation,
  readRcDeviceId,
  withRcQuery,
} from '@moonshot-ai/app-core/lib';
import { fetchRcDevices, type RcDevice } from '../lib/rcDevicesApi';

const { t } = useI18n();

// Mobile switches the menu from a fixed body-teleported popover to an inline
// block inside the switcher sheet (see the rc-dev-menu--mobile styles) and
// bumps rows to touch geometry.
const isMobile = useIsMobile();

// The rc query persists across in-site navigation (writeUrl carries it), so
// one read at mount settles the mode for this page's lifetime.
const rcMode = isRcLocation(window.location);
// On any /devices/<id>/… page this also persists the id for later navigations.
const currentDeviceId = readRcDeviceId(window.location);

const devices = ref<RcDevice[] | null>(null);
// The account's device cap, parsed from the same response. Held here for the
// upcoming capacity UI — intentionally not rendered yet.
const maxDevices = ref<number | undefined>(undefined);
// Popover-visible states, used only while there is nothing cached to show;
// once a list exists, opens refresh it silently in the background.
const loading = ref(false);
const loadFailed = ref(false);

const onlineDevices = computed(() => (devices.value ?? []).filter((d) => d.status === 'online'));
const offlineDevices = computed(() => (devices.value ?? []).filter((d) => d.status !== 'online'));
const currentLabel = computed(
  () => devices.value?.find((d) => d.device_id === currentDeviceId)?.platform ?? t('sidebar.rcSelectDevice'),
);

// Monotonic request tag: mount-load and every menu-open load can overlap, so
// only the latest request may commit state — an older response landing last
// must not rewind the list to a stale snapshot.
let loadGeneration = 0;

async function loadDevices(): Promise<void> {
  const generation = ++loadGeneration;
  if (devices.value === null) loading.value = true;
  try {
    const list = await fetchRcDevices();
    if (generation !== loadGeneration) return;
    devices.value = list.devices;
    maxDevices.value = list.max_devices;
    loadFailed.value = false;
  } catch {
    if (generation !== loadGeneration) return;
    if (devices.value === null) loadFailed.value = true;
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
  // The list height changed under the open popover — re-anchor it.
  if (menuOpen.value) {
    await nextTick();
    positionMenu();
  }
}

onMounted(() => {
  // Only rc pages ever show the switcher — don't hit the relay-only endpoint
  // on ordinary web loads (it 404s against a plain daemon).
  if (rcMode) void loadDevices();
});

// ---------------------------------------------------------------------------
// Popover open state + fixed positioning (UserMenu recipe): anchored below
// the trigger, flipping up when the viewport has no room below.
// ---------------------------------------------------------------------------
const menuOpen = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
let triggerObserver: ResizeObserver | null = null;

function onDocMousedown(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.rc-dev-menu') || target.closest('.rc-dev-trigger')) return;
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
  // The list refreshes on every open (no polling while closed).
  void loadDevices();
  await nextTick();
  positionMenu();
  const btn = triggerRef.value;
  if (btn && !isMobile.value) {
    triggerObserver = new ResizeObserver(() => positionMenu());
    triggerObserver.observe(btn);
  }
}

function positionMenu(): void {
  // The mobile menu is anchored by CSS inside the sheet — no JS positioning.
  if (isMobile.value) return;
  const btn = triggerRef.value;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu.offsetHeight;
  const box = { left: `${Math.round(r.left)}px`, width: `${Math.round(r.width)}px` };
  // Cap max-height to the chosen side's actual room so the fixed menu never
  // extends past the viewport (its own scroll stays reachable).
  const roomBelow = window.innerHeight - r.bottom - gap - margin;
  const roomAbove = r.top - gap - margin;
  if (menuH > roomBelow && roomAbove > roomBelow) {
    // Below doesn't fit and above is roomier: open upward.
    menuStyle.value = {
      ...box,
      top: 'auto',
      bottom: `${Math.round(window.innerHeight - r.top + gap)}px`,
      maxHeight: `${Math.round(roomAbove)}px`,
      transformOrigin: 'bottom left',
      '--menu-pop-shift': '2px',
    };
  } else {
    // Default: open below.
    menuStyle.value = {
      ...box,
      top: `${Math.round(r.bottom + gap)}px`,
      bottom: 'auto',
      maxHeight: `${Math.round(roomBelow)}px`,
      transformOrigin: 'top left',
      '--menu-pop-shift': '-2px',
    };
  }
}

function closeMenu(): void {
  menuOpen.value = false;
  triggerObserver?.disconnect();
  triggerObserver = null;
  document.removeEventListener('mousedown', onDocMousedown);
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', closeMenu);
}

onBeforeUnmount(closeMenu);

function onPick(device: RcDevice): void {
  if (device.device_id === currentDeviceId) return;
  // Full-page switch: the relay routes the fresh page (and its API traffic)
  // to the picked device; the rc query rides along.
  window.location.assign(withRcQuery(deviceUrl(device.device_id), window.location.search));
}
</script>

<template>
  <div v-if="rcMode" class="rc-dev" :class="{ 'rc-dev--mobile': isMobile }">
    <button
      ref="triggerRef"
      class="rc-dev-trigger"
      type="button"
      :aria-label="t('sidebar.rcCurrentDevice', { name: currentLabel })"
      aria-haspopup="dialog"
      :aria-expanded="menuOpen"
      @click.stop="toggleMenu"
    >
      <Icon name="device-desktop" size="sm" />
      <span class="rc-dev-name">{{ currentLabel }}</span>
      <Icon class="rc-dev-chevron" name="chevron-down" size="sm" />
    </button>

    <!-- Teleport: the sidebar column's container-type would capture position:fixed
         and mis-anchor the menu. Disabled on mobile, where the menu renders
         inline and is CSS-anchored under the trigger inside the switcher
         sheet's own stacking context (body-teleported would sit under the
         sheet's --z-overlay). -->
    <Teleport to="body" :disabled="isMobile">
      <Transition name="menu-pop">
        <Menu
          v-if="menuOpen"
          ref="menuRef"
          class="rc-dev-menu"
          :class="{ 'rc-dev-menu--mobile': isMobile }"
          role="dialog"
          :style="isMobile ? undefined : menuStyle"
          @click.stop
        >
          <div v-if="loading" class="rc-dev-state">
            <Spinner size="sm" />
          </div>
          <div v-else-if="loadFailed" class="rc-dev-state rc-dev-failed">
            {{ t('sidebar.rcDevicesLoadFailed') }}
          </div>
          <template v-else>
            <template v-if="onlineDevices.length > 0">
              <div class="rc-dev-caption">{{ t('sidebar.rcConnectable') }}</div>
              <MenuItem
                v-for="d in onlineDevices"
                :key="d.device_id"
                role="button"
                :size="isMobile ? 'lg' : 'md'"
                :active="d.device_id === currentDeviceId"
                :aria-current="d.device_id === currentDeviceId ? 'true' : undefined"
                @click="onPick(d)"
              >
                <Icon name="device-desktop" size="sm" />
                <span class="rc-dev-item-name">{{ d.platform }}</span>
                <span class="rc-dev-item-status"><StatusDot status="ok" />{{ t('sidebar.rcOnline') }}</span>
                <!-- The check slot is reserved on every row (sized like the
                     icons) so the status text aligns whether or not a check
                     is present. -->
                <span class="rc-dev-item-check">
                  <Icon v-if="d.device_id === currentDeviceId" name="check" size="sm" />
                </span>
              </MenuItem>
            </template>
            <template v-if="offlineDevices.length > 0">
              <div class="rc-dev-caption">{{ t('sidebar.rcUnavailable') }}</div>
              <!-- Offline rows are informational, not actions — plain blocks
                   with the online rows' geometry, not MenuItems. The current
                   device keeps its selection marker here too: it can land in
                   this group when it drops offline while the page is open. -->
              <div
                v-for="d in offlineDevices"
                :key="d.device_id"
                class="rc-dev-offline"
                :class="{ 'is-current': d.device_id === currentDeviceId }"
                :aria-current="d.device_id === currentDeviceId ? 'true' : undefined"
              >
                <div class="rc-dev-offline-row">
                  <Icon name="device-desktop" size="sm" />
                  <span class="rc-dev-item-name">{{ d.platform }}</span>
                  <span class="rc-dev-item-status"><StatusDot />{{ t('sidebar.rcOffline') }}</span>
                  <span class="rc-dev-item-check">
                    <Icon v-if="d.device_id === currentDeviceId" name="check" size="sm" />
                  </span>
                </div>
              </div>
            </template>
          </template>
        </Menu>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* Row geometry matches .sidebar-actions (inset from the sidebar edge); the
   trigger itself is the design's bordered field box. The --sb-* row tokens
   are Sidebar-scoped — restate them here so the component is self-sufficient
   when mounted in MobileSwitcherSheet (same values, so the Sidebar mount is
   unaffected). */
.rc-dev {
  --sb-inset: var(--space-2);
  --sb-pad-x: var(--space-4);
  --sb-gap: var(--space-2);
  --sb-hover: var(--color-hover);
  /* Anchors the inline mobile menu (desktop's popover is body-teleported). */
  position: relative;
  padding: 0 var(--sb-inset) var(--space-1);
}
/* Mobile (inside the switcher bottom sheet): breathe a little more around
   the row and give the trigger a touch-height box. */
.rc-dev--mobile {
  padding: var(--space-1) var(--sb-inset) var(--space-2);
}
.rc-dev--mobile .rc-dev-trigger {
  min-height: 44px;
}
.rc-dev-trigger {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  width: 100%;
  min-width: 0;
  padding: 6px calc(var(--sb-pad-x) - var(--sb-inset));
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  cursor: pointer;
  text-align: left;
}
.rc-dev-trigger:hover,
.rc-dev-trigger[aria-expanded='true'] {
  background: var(--sb-hover);
}
.rc-dev-trigger:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.rc-dev-trigger svg {
  flex: none;
}
.rc-dev-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-dev-chevron {
  margin-left: auto;
  color: var(--color-text-faint);
}

/* Class-level top:0 is only the pre-positioning frame — menuStyle always sets both vertical axes. */
.rc-dev-menu {
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
/* Mobile: Teleport is disabled, so the menu lives inline in the sheet's
   stacking context and anchors under the trigger (the sheet's kebab menus
   use the same inline-absolute pattern). .rc-dev's bottom padding is the
   gap between the trigger and the menu. */
.rc-dev-menu--mobile {
  position: absolute;
  top: 100%;
  left: var(--sb-inset);
  right: var(--sb-inset);
  bottom: auto;
  max-height: min(50vh, 320px);
  transform-origin: top center;
}
/* Touch geometry for the offline rows, mirroring MenuItem--lg. */
.rc-dev-menu--mobile .rc-dev-offline {
  min-height: 44px;
  padding: 12px 14px;
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

.rc-dev-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
}
.rc-dev-failed {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.rc-dev-caption {
  padding: var(--space-2) var(--menu-item-padding-inline) 2px;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.rc-dev-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-dev-item-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--color-text-muted);
}
/* Trailing slot for the current-device check, reserved on every device row
   (online MenuItem and offline row alike) at the icons' --p-ic-md size. */
.rc-dev-item-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  flex: none;
}

.rc-dev-offline {
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
  border-radius: var(--radius-menu-item);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-tight);
}
/* Current-but-offline keeps the same neutral wash as the online MenuItem. */
.rc-dev-offline.is-current {
  background: var(--color-hover);
  color: var(--color-text);
}
.rc-dev-offline-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.rc-dev-offline-row svg {
  display: block;
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  flex: none;
}
</style>
