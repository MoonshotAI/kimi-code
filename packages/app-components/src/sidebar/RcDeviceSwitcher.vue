<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu, MenuItem, Spinner, StatusDot } from '@moonshot-ai/app-ui';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import {
  deviceUrl,
  fetchRcDevices,
  isRcLocation,
  readRcDeviceId,
  withRcQuery,
  type RcDevice,
} from '@moonshot-ai/app-core/lib';

const { t } = useI18n();

const isMobile = useIsMobile();

const rcMode = isRcLocation(window.location);
const currentDeviceId = readRcDeviceId(window.location);

const devices = ref<RcDevice[] | null>(null);
const maxDevices = ref<number | undefined>(undefined);
const loading = ref(false);
const loadFailed = ref(false);

const onlineDevices = computed(() => (devices.value ?? []).filter((d) => d.status === 'online'));
const offlineDevices = computed(() => (devices.value ?? []).filter((d) => d.status !== 'online'));
const currentLabel = computed(
  () => devices.value?.find((d) => d.device_id === currentDeviceId)?.alias ?? t('sidebar.rcSelectDevice'),
);

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
  if (menuOpen.value) {
    await nextTick();
    positionMenu();
  }
}

onMounted(() => {
  if (rcMode) void loadDevices();
});

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
  if (isMobile.value) return;
  const btn = triggerRef.value;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu.offsetHeight;
  const box = { left: `${Math.round(r.left)}px`, width: `${Math.round(r.width)}px` };
  const roomBelow = window.innerHeight - r.bottom - gap - margin;
  const roomAbove = r.top - gap - margin;
  if (menuH > roomBelow && roomAbove > roomBelow) {
    menuStyle.value = {
      ...box,
      top: 'auto',
      bottom: `${Math.round(window.innerHeight - r.top + gap)}px`,
      maxHeight: `${Math.round(roomAbove)}px`,
      transformOrigin: 'bottom left',
      '--menu-pop-shift': '2px',
    };
  } else {
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

    <Teleport to="body" :disabled="isMobile">
      <Transition name="ui-menu-pop">
        <Menu
          v-if="menuOpen"
          ref="menuRef"
          class="ui-menu-floating rc-dev-menu"
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
                <span class="rc-dev-item-name">{{ d.alias }}</span>
                <span class="rc-dev-item-status"><StatusDot status="ok" />{{ t('sidebar.rcOnline') }}</span>
                <span class="rc-dev-item-check">
                  <Icon v-if="d.device_id === currentDeviceId" name="check" size="sm" />
                </span>
              </MenuItem>
            </template>
            <template v-if="offlineDevices.length > 0">
              <div class="rc-dev-caption">{{ t('sidebar.rcUnavailable') }}</div>
              <div
                v-for="d in offlineDevices"
                :key="d.device_id"
                class="rc-dev-offline"
                :class="{ 'is-current': d.device_id === currentDeviceId }"
                :aria-current="d.device_id === currentDeviceId ? 'true' : undefined"
              >
                <div class="rc-dev-offline-row">
                  <Icon name="device-desktop" size="sm" />
                  <span class="rc-dev-item-name">{{ d.alias }}</span>
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
.rc-dev {
  --sb-inset: var(--space-2);
  --sb-pad-x: var(--space-4);
  --sb-gap: var(--space-2);
  --sb-hover: var(--color-hover);
  position: relative;
  padding: 0 var(--sb-inset) var(--space-1);
}
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
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
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

.rc-dev-menu {
  --menu-pop-shift: 2px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
}
.rc-dev-menu--mobile {
  position: absolute;
  top: 100%;
  left: var(--sb-inset);
  right: var(--sb-inset);
  bottom: auto;
  max-height: min(50vh, 320px);
  transform-origin: top center;
}
.rc-dev-menu--mobile .rc-dev-offline {
  min-height: 44px;
  padding: 12px 14px;
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
