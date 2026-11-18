<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Button,
  Dialog,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Spinner,
  StatusDot,
} from '@moonshot-ai/app-ui';
import { isImeKeyEvent } from '@moonshot-ai/app-client/lib';
import {
  deactivateRcDevice,
  deleteRcDevice,
  deviceUrl,
  fetchRcDevices,
  renameRcDevice,
  RcDevicesFetchError,
  type RcDevice,
} from '@moonshot-ai/app-core/lib';
import type { SessionInfo } from './session';
import LoginFlow from './LoginFlow.vue';

const props = defineProps<{
  session: SessionInfo | null;
  sessionChecking: boolean;
}>();

const { t } = useI18n();

const DOCS_URL = 'https://www.kimi.com/code/docs/kimi-code-cli/guides/remote-control.html';

type PageState = 'checking' | 'login' | 'list';
const state = computed<PageState>(() => {
  if (props.sessionChecking) return 'checking';
  return props.session ? 'list' : 'login';
});

const devices = ref<RcDevice[] | null>(null);
const maxDevices = ref<number | undefined>(undefined);
const loadFailed = ref(false);
const refreshing = ref(false);
let loadGeneration = 0;

const onlineDevices = computed(() => (devices.value ?? []).filter((d) => d.status === 'online'));
const offlineDevices = computed(() => (devices.value ?? []).filter((d) => d.status !== 'online'));
const allOffline = computed(
  () => (devices.value?.length ?? 0) > 0 && onlineDevices.value.length === 0,
);

const emit = defineEmits<{
  allOfflineChange: [value: boolean];
  authenticated: [];
  sessionExpired: [];
}>();

watch(allOffline, (value) => emit('allOfflineChange', value), { immediate: true });

watch(() => props.session, (current, previous) => {
  if (!current) {
    loadGeneration += 1;
    devices.value = null;
    maxDevices.value = undefined;
    loadFailed.value = false;
    refreshing.value = false;
    return;
  }
  if (current !== previous) void loadDevices();
});

onMounted(() => {
  if (props.session) void loadDevices();
});

async function loadDevices(): Promise<void> {
  const generation = ++loadGeneration;
  refreshing.value = true;
  try {
    const list = await fetchRcDevices();
    if (generation !== loadGeneration || !props.session) return;
    devices.value = list.devices;
    maxDevices.value = list.max_devices;
    loadFailed.value = false;
  } catch (err) {
    if (generation !== loadGeneration) return;
    if (err instanceof RcDevicesFetchError && err.status === 401) {
      emit('sessionExpired');
      return;
    }
    loadFailed.value = true;
  } finally {
    if (generation === loadGeneration) refreshing.value = false;
  }
}

function onAuthenticated(): void {
  emit('authenticated');
}

function connect(device: RcDevice): void {
  if (device.status !== 'online') return;
  location.assign(`${deviceUrl(device.device_id)}?rc=1&from=kimi_code_cli`);
}

const menuDevice = ref<RcDevice | null>(null);
const menuStyle = ref<Record<string, string>>({});
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
let menuTrigger: HTMLElement | null = null;

function onDocMousedown(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.device-menu-pop') || target.closest('.device-menu-btn')) return;
  closeMenu();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeMenu();
}

async function toggleMenu(device: RcDevice, event: MouseEvent): Promise<void> {
  if (menuDevice.value?.device_id === device.device_id) {
    closeMenu();
    return;
  }
  closeMenu();
  menuDevice.value = device;
  menuTrigger = event.currentTarget as HTMLElement;
  document.addEventListener('mousedown', onDocMousedown);
  document.addEventListener('keydown', onDocKeydown, true);
  window.addEventListener('resize', closeMenu);
  await nextTick();
  positionMenu();
}

function positionMenu(): void {
  const menu = menuRef.value?.el;
  if (!menuTrigger || !menu) return;
  const r = menuTrigger.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  const left = Math.max(margin, Math.min(r.right - menuW, window.innerWidth - menuW - margin));
  const roomBelow = window.innerHeight - r.bottom - gap - margin;
  const roomAbove = r.top - gap - margin;
  if (menuH > roomBelow && roomAbove > roomBelow) {
    menuStyle.value = {
      left: `${Math.round(left)}px`,
      top: 'auto',
      bottom: `${Math.round(window.innerHeight - r.top + gap)}px`,
      maxHeight: `${Math.round(roomAbove)}px`,
      transformOrigin: 'bottom right',
    };
  } else {
    menuStyle.value = {
      left: `${Math.round(left)}px`,
      top: `${Math.round(r.bottom + gap)}px`,
      bottom: 'auto',
      maxHeight: `${Math.round(roomBelow)}px`,
      transformOrigin: 'top right',
    };
  }
}

function closeMenu(): void {
  menuDevice.value = null;
  menuTrigger = null;
  document.removeEventListener('mousedown', onDocMousedown);
  document.removeEventListener('keydown', onDocKeydown, true);
  window.removeEventListener('resize', closeMenu);
}

onBeforeUnmount(closeMenu);

const renameTarget = ref<RcDevice | null>(null);
const renameValue = ref('');
const renameError = ref(false);
const renameInputRef = ref<InstanceType<typeof Input> | null>(null);
const confirmTarget = ref<RcDevice | null>(null);
const confirmError = ref(false);
const submitting = ref(false);
const confirmOffline = computed(
  () => confirmTarget.value !== null && confirmTarget.value.status !== 'online',
);

watch(renameTarget, async (target) => {
  if (!target) return;
  await nextTick();
  renameInputRef.value?.focus();
  renameInputRef.value?.select();
});

function openRename(device: RcDevice): void {
  closeMenu();
  renameValue.value = device.alias;
  renameError.value = false;
  renameTarget.value = device;
}

function openConfirm(device: RcDevice): void {
  closeMenu();
  confirmError.value = false;
  confirmTarget.value = device;
}

function closeConfirm(): void {
  confirmTarget.value = null;
}

function onRenameEnter(event: KeyboardEvent): void {
  if (isImeKeyEvent(event)) return;
  void submitRename();
}

async function submitRename(): Promise<void> {
  const device = renameTarget.value;
  const alias = renameValue.value.trim();
  if (!device || !alias || submitting.value) return;
  submitting.value = true;
  renameError.value = false;
  try {
    await renameRcDevice(device.device_id, alias);
    location.reload();
  } catch (err) {
    if (err instanceof RcDevicesFetchError && err.status === 401) {
      renameTarget.value = null;
      emit('sessionExpired');
    } else {
      renameError.value = true;
    }
  } finally {
    submitting.value = false;
  }
}

async function submitConfirm(): Promise<void> {
  const device = confirmTarget.value;
  if (!device || submitting.value) return;
  submitting.value = true;
  confirmError.value = false;
  try {
    await (confirmOffline.value
      ? deleteRcDevice(device.device_id)
      : deactivateRcDevice(device.device_id));
    location.reload();
  } catch (err) {
    if (err instanceof RcDevicesFetchError && err.status === 401) {
      closeConfirm();
      emit('sessionExpired');
    } else {
      confirmError.value = true;
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Transition name="step" mode="out-in">
    <div v-if="state === 'checking'" key="checking" class="center-body">
      <Spinner size="md" />
      <span class="center-text">{{ t('login.rcChecking') }}</span>
    </div>

    <LoginFlow v-else-if="state === 'login'" key="login" :redirect-uri="null" @authenticated="onAuthenticated" />

    <div v-else key="list" class="devices-body">
      <div class="devices-toolbar">
        <span v-if="maxDevices !== undefined" class="devices-count">
          {{ t('devices.deviceCount', { count: devices?.length ?? 0, max: maxDevices }) }}
        </span>
        <Button variant="text" class="refresh-btn" :disabled="refreshing" @click="loadDevices">
          <Icon name="refresh" size="sm" :class="{ 'is-spinning': refreshing }" />
          {{ t('devices.refresh') }}
        </Button>
      </div>

      <div v-if="devices === null && !loadFailed" class="center-body">
        <Spinner size="md" />
      </div>

      <div v-else-if="loadFailed" class="center-body">
        <span class="center-text warn-text">{{ t('devices.loadFailed') }}</span>
        <span class="center-hint">{{ t('login.rcConnectionErrorHint') }}</span>
        <Button variant="primary" class="retry-btn" @click="loadDevices">{{ t('login.retry') }}</Button>
      </div>

      <div v-else-if="devices!.length === 0" class="center-body empty-body">
        <Icon name="device-desktop" size="lg" class="empty-icon" />
        <span class="center-text">{{ t('devices.emptyTitle') }}</span>
        <span class="center-hint">{{ t('devices.emptyHint') }}</span>
        <a class="docs-link" :href="DOCS_URL" target="_blank" rel="noopener noreferrer">
          {{ t('devices.docsLink') }}
        </a>
      </div>

      <template v-else>
        <div v-if="onlineDevices.length > 0" class="device-group">
          <div class="group-caption">{{ t('devices.connectable') }}</div>
          <div v-for="d in onlineDevices" :key="d.device_id" class="device-row">
            <button type="button" class="device-connect" @click="connect(d)">
              <Icon name="device-desktop" size="sm" class="device-icon" />
              <span class="device-main">
                <span class="device-name">{{ d.alias }}</span>
                <span class="device-meta">{{ d.platform }}</span>
              </span>
              <span class="device-status">
                <StatusDot status="ok" />{{ t('devices.online') }}
              </span>
            </button>
            <IconButton class="device-menu-btn" size="sm" :label="t('devices.menuLabel')" @click="toggleMenu(d, $event)">
              <Icon name="dots-horizontal" size="sm" />
            </IconButton>
          </div>
        </div>

        <div v-if="offlineDevices.length > 0" class="device-group">
          <div class="group-caption">{{ t('devices.unavailable') }}</div>
          <div v-for="d in offlineDevices" :key="d.device_id" class="device-row is-offline">
            <div class="device-connect is-static">
              <Icon name="device-desktop" size="sm" class="device-icon" />
              <span class="device-main">
                <span class="device-name">{{ d.alias }}</span>
                <span class="device-meta">{{ d.platform }}</span>
              </span>
              <span class="device-status">
                <StatusDot />{{ t('devices.offline') }}
              </span>
            </div>
            <IconButton class="device-menu-btn" size="sm" :label="t('devices.menuLabel')" @click="toggleMenu(d, $event)">
              <Icon name="dots-horizontal" size="sm" />
            </IconButton>
          </div>
        </div>
      </template>
    </div>
  </Transition>

  <Teleport to="body">
    <Transition name="menu-pop">
      <Menu
        v-if="menuDevice"
        ref="menuRef"
        class="device-menu-pop"
        role="dialog"
        :style="menuStyle"
        @click.stop
      >
        <MenuItem role="button" @click="openRename(menuDevice)">{{ t('devices.rename') }}</MenuItem>
        <MenuItem v-if="menuDevice.status === 'online'" role="button" @click="openConfirm(menuDevice)">
          {{ t('devices.deactivate') }}
        </MenuItem>
        <MenuItem v-else role="button" @click="openConfirm(menuDevice)">
          {{ t('devices.delete') }}
        </MenuItem>
      </Menu>
    </Transition>
  </Teleport>

  <Dialog
    :open="renameTarget !== null"
    size="sm"
    :title="t('devices.renameTitle')"
    initial-focus="input"
    @update:open="renameTarget = null"
  >
    <Input ref="renameInputRef" v-model="renameValue" maxlength="50" :placeholder="t('devices.renamePlaceholder')" @keydown.enter="onRenameEnter" />
    <p v-if="renameError" class="dialog-error">{{ t('devices.actionFailed') }}</p>
    <template #foot>
      <Button variant="secondary" :disabled="submitting" @click="renameTarget = null">{{ t('common.cancel') }}</Button>
      <Button variant="primary" :loading="submitting" :disabled="!renameValue.trim()" @click="submitRename">
        {{ t('common.confirm') }}
      </Button>
    </template>
  </Dialog>

  <Dialog
    :open="confirmTarget !== null"
    size="sm"
    :title="confirmOffline
      ? t('devices.deleteTitle', { name: confirmTarget?.alias ?? '' })
      : t('devices.deactivateTitle', { name: confirmTarget?.alias ?? '' })"
    @update:open="closeConfirm"
  >
    <p class="confirm-hint">{{ confirmOffline ? t('devices.deleteHint') : t('devices.deactivateHint') }}</p>
    <p v-if="confirmError" class="dialog-error">{{ t('devices.actionFailed') }}</p>
    <template #foot>
      <Button variant="secondary" :disabled="submitting" @click="closeConfirm">{{ t('common.cancel') }}</Button>
      <Button variant="danger" :loading="submitting" @click="submitConfirm">
        {{ confirmOffline ? t('devices.delete') : t('devices.deactivate') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.devices-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.devices-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  min-height: 24px;
}
.devices-count {
  margin-right: auto;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  text-decoration: none;
}
.refresh-btn:hover {
  color: var(--color-text);
  text-decoration: none;
}
.refresh-btn .is-spinning {
  animation: refresh-spin 1s linear infinite;
}
@keyframes refresh-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .refresh-btn .is-spinning { animation: none; }
}

.device-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.group-caption {
  padding: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  color: var(--color-text-faint);
}

.device-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: var(--space-2) 0;
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}
.device-row.is-offline {
  color: var(--color-text-muted);
}
.device-connect {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 calc(-1 * var(--space-2));
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
}
button.device-connect {
  cursor: pointer;
}
button.device-connect:hover,
button.device-connect:active {
  background: var(--color-hover);
}
button.device-connect:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.device-icon {
  flex: none;
}
.device-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.device-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-medium);
}
.device-meta {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.device-status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.device-menu-btn {
  flex: none;
}

.device-menu-pop {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 160px;
  overflow-y: auto;
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
  transform: scale(0.97);
}
@media (prefers-reduced-motion: reduce) {
  .menu-pop-enter-active,
  .menu-pop-leave-active { transition: none; }
}

.confirm-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.dialog-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.empty-body {
  gap: var(--space-3);
}
.empty-icon {
  color: var(--color-text-faint);
}
.docs-link {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.docs-link:hover {
  color: var(--color-text);
}
</style>
