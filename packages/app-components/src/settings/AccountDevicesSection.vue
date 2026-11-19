<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppDeviceUpgradeStatus } from '@moonshot-ai/app-core/api';
import { deviceInstall, isLongOffline, isRetryableDeviceFailure, LONG_OFFLINE_DAYS } from '@moonshot-ai/app-core/lib';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { track } from '@moonshot-ai/app-client/contracts';
import { authStore, devicesStore, type DeviceDisplayState, type MyDevice } from '@moonshot-ai/app-client/stores';
import { Button, Icon, IconButton, Input, Menu, MenuItem, Spinner, StatusDot, Switch, Tooltip } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';
import { useDeviceFailureText } from '../composables/useDeviceFailureText';

const props = defineProps<{
  createProject?: (deviceId: string) => void;
}>();

const emit = defineEmits<{
  login: [];
}>();

const DOTS: Partial<Record<DeviceDisplayState, string>> = {
  ready: 'ok',
  connecting: 'running',
  failed: 'error',
  outdated: 'error',
  signedOut: 'error',
};

const { t } = useI18n();
const store = devicesStore();
const { confirm } = useConfirmDialog();
const failureText = useDeviceFailureText();
const signedIn = computed(() => authStore().signedIn);
const now = ref(Date.now());
const foldOpen = ref(false);
const pendingId = ref('');
const actionError = ref('');
const renamingId = ref('');
const renameValue = ref('');
const renameSubmitting = ref(false);
const renameFailed = ref(false);
const renameInput = ref<InstanceType<typeof Input> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuId = ref('');
const rootEl = ref<HTMLElement>();
const flashId = ref('');
const { open: menuOpen, menuStyle, showAnchored, close: closeMenu } = useAnchoredMenu(menuRef);
let flashTimer = 0;

const rows = computed(() => store.myDevices);
const folded = computed(() => rows.value.filter((row) => row.device === undefined && row.registration !== undefined && isLongOffline(row.registration, now.value)));
const shown = computed(() => rows.value.filter((row) => !folded.value.includes(row)));
const listed = computed(() => (foldOpen.value ? [...shown.value, ...folded.value] : shown.value));
const menuRow = computed(() => rows.value.find((row) => row.id === menuId.value));
const loadFailed = computed(() => store.registrations === null && store.registrationsError !== null);
const usage = computed(() => {
  if (store.registrations === null || store.maxDevices === undefined || store.registrations.length < store.maxDevices) return '';
  return t('settings.devices.deviceLimit', { max: store.maxDevices });
});

onMounted(() => {
  if (signedIn.value) void store.loadRegistrations();
});

watch(signedIn, (value) => {
  if (value) void store.loadRegistrations();
});

watch(menuOpen, (open) => {
  if (!open) menuId.value = '';
});

onUnmounted(() => window.clearTimeout(flashTimer));

function applyFocusDevice(): void {
  const targetId = store.focusDeviceId;
  if (!targetId || store.deviceFor(targetId)?.connection !== 'account') return;
  store.requestFocus(null);
  const row = rows.value.find((item) => item.id === targetId);
  if (row === undefined) return;
  if (folded.value.includes(row)) foldOpen.value = true;
  flashId.value = row.id;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashId.value = '';
  }, 1200);
  void nextTick(() => {
    const el = [...(rootEl.value?.querySelectorAll<HTMLElement>('[data-device-id]') ?? [])]
      .find((item) => item.dataset.deviceId === row.id);
    el?.scrollIntoView?.({ block: 'nearest' });
  });
}

watch(() => store.focusDeviceId, applyFocusDevice, { immediate: true });

function added(row: MyDevice): boolean {
  return row.device !== undefined && row.device.enabled !== false;
}

function online(row: MyDevice): boolean {
  return row.registration?.status === 'online';
}

function rowName(row: MyDevice): string {
  if (row.device !== undefined) return store.displayName(row.id) ?? row.id;
  return row.registration?.alias || row.id;
}

function rowState(row: MyDevice): DeviceDisplayState | undefined {
  return row.device === undefined ? undefined : store.displayState(row.id);
}

function rowUpgrade(row: MyDevice): AppDeviceUpgradeStatus | undefined {
  const upgrade = row.device === undefined ? undefined : store.upgradeStatus(row.id);
  if (upgrade !== 'failed') return upgrade;
  const state = rowState(row);
  return state === 'ready' || state === 'outdated' ? upgrade : undefined;
}

function statusClass(row: MyDevice): string | undefined {
  const upgrade = rowUpgrade(row);
  if (upgrade !== undefined) return `ad-status--upgrade-${upgrade}`;
  const state = rowState(row);
  return state === undefined ? undefined : `ad-status--${state}`;
}

function stateLabel(row: MyDevice): string {
  const upgrade = rowUpgrade(row);
  if (upgrade !== undefined) return t(`workspace.deviceUpgrade.${upgrade}`);
  const state = rowState(row);
  if (state !== undefined) return t(`workspace.deviceState.${state}`);
  return t(online(row) ? 'remoteControl.online' : 'remoteControl.offline');
}

function dot(row: MyDevice): string {
  const upgrade = rowUpgrade(row);
  if (upgrade !== undefined) return upgrade === 'failed' ? 'error' : 'running';
  const state = rowState(row);
  if (state !== undefined) return DOTS[state] ?? 'idle';
  return online(row) ? 'ok' : 'idle';
}

function cli(row: MyDevice): boolean {
  if (row.device?.install !== undefined) return row.device.install === 'cli';
  return deviceInstall(row.registration?.client_version ?? '')?.install === 'cli';
}

function details(row: MyDevice): string[] {
  const upgrade = rowUpgrade(row);
  const device = row.device;
  if (upgrade === 'failed') {
    const reason = device?.upgradeError?.split('\n', 1)[0];
    return reason ? [reason] : [];
  }
  if (upgrade !== undefined) return [];
  const state = rowState(row);
  if (state === 'failed') {
    const reason = failureText.label(device?.connectFailure, device?.remoteVersion) || device?.connectError?.split('\n', 1)[0];
    return reason ? [reason] : [];
  }
  if (state === 'outdated') {
    const hint = store.canUpgrade(row.id) ? '' : failureText.hint('outdated', { install: store.install(row.id), name: rowName(row) });
    return hint ? [hint] : [];
  }
  if (state === 'duplicate' && device?.duplicateOf !== undefined) {
    return [t('settings.devices.duplicateOf', { name: store.displayName(device.duplicateOf) ?? device.duplicateOf })];
  }
  const offline = row.registration !== undefined && !online(row) && state !== 'ready' && state !== 'connecting';
  return cli(row) && offline ? [t('settings.devices.runCommand', { command: 'kimi rc' })] : [];
}

function upgradeInline(row: MyDevice): boolean {
  return store.canUpgrade(row.id) && rowState(row) === 'outdated';
}

function canReconnect(row: MyDevice): boolean {
  return rowUpgrade(row) === undefined && rowState(row) === 'failed' && isRetryableDeviceFailure(row.device?.connectFailure);
}

async function setAdded(row: MyDevice, value: boolean): Promise<void> {
  if (pendingId.value !== '' || value === added(row)) return;
  actionError.value = '';
  pendingId.value = row.id;
  try {
    if (value) await store.addAccountDevice(row.id);
    else await store.remove(row.id);
  } catch {
    actionError.value = t('settings.devices.saveFailed');
  } finally {
    pendingId.value = '';
  }
}

function refresh(): void {
  track('remote_control_action', { action: 'refresh_devices' });
  now.value = Date.now();
  void store.loadRegistrations();
  void store.load().catch(() => undefined);
}

async function toggleMenu(row: MyDevice, event: MouseEvent): Promise<void> {
  if (menuOpen.value && menuId.value === row.id) {
    closeMenu();
    return;
  }
  menuId.value = row.id;
  await showAnchored(event, 'right');
}

function startProject(row: MyDevice): void {
  closeMenu();
  props.createProject?.(row.id);
}

async function reconnect(row: MyDevice): Promise<void> {
  closeMenu();
  await store.connect(row.id).catch(() => undefined);
}

function upgradeRow(row: MyDevice): void {
  closeMenu();
  void store.upgrade(row.id);
}

async function startRename(row: MyDevice): Promise<void> {
  closeMenu();
  renamingId.value = row.id;
  renameValue.value = rowName(row);
  renameFailed.value = false;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

function resetRename(): void {
  renamingId.value = '';
  renameValue.value = '';
  renameFailed.value = false;
}

function cancelRename(): void {
  track('remote_control_action', { action: 'rename', outcome: 'cancelled' });
  resetRename();
}

async function submitRename(row: MyDevice): Promise<void> {
  const alias = renameValue.value.trim();
  if (renameSubmitting.value) return;
  if (alias.length === 0 || alias.length > 50) {
    renameFailed.value = true;
    return;
  }
  renameSubmitting.value = true;
  renameFailed.value = false;
  try {
    await store.renameRegistration(row.id, alias);
    track('remote_control_action', { action: 'rename', outcome: 'ok' });
    resetRename();
  } catch {
    track('remote_control_action', { action: 'rename', outcome: 'error' });
    renameFailed.value = true;
  } finally {
    renameSubmitting.value = false;
  }
}

async function removeFromAccount(row: MyDevice): Promise<void> {
  closeMenu();
  actionError.value = '';
  const name = rowName(row);
  const action = online(row) ? 'deactivate' : 'delete';
  try {
    const confirmed = await confirm({
      title: t(action === 'delete' ? 'remoteControl.deleteTitle' : 'remoteControl.deactivateTitle', { name }),
      message: t(action === 'delete' ? 'remoteControl.deleteHint' : 'remoteControl.deactivateHint', { name }),
      confirmLabel: t(action === 'delete' ? 'remoteControl.delete' : 'remoteControl.deactivate'),
      cancelLabel: t('remoteControl.cancel'),
      variant: 'danger',
      initialFocus: 'cancel',
      action: () => (action === 'delete' ? store.deleteRegistration(row.id) : store.deactivateRegistration(row.id)),
    });
    track('remote_control_action', { action, outcome: confirmed ? 'ok' : 'cancelled', target: 'other_device' });
  } catch (error) {
    track('remote_control_action', { action, outcome: 'error', target: 'other_device' });
    const message = error instanceof Error ? error.message.trim() : '';
    actionError.value = message || t('remoteControl.actionFailed');
  }
}
</script>

<template>
  <section ref="rootEl" class="ad" :aria-label="t('settings.devices.myDevices')">
    <div class="ad-head">
      <slot name="title">
        <h3 class="ad-title">{{ t('settings.devices.myDevices') }}</h3>
      </slot>
      <div v-if="signedIn" class="ad-head-actions">
        <span v-if="usage" class="ad-usage">{{ usage }}</span>
        <IconButton
          class="ad-refresh"
          size="sm"
          :label="t('remoteControl.refreshDevices')"
          :tooltip="t('remoteControl.refresh')"
          :disabled="store.registrationsLoading"
          @click="refresh"
        >
          <Icon name="refresh" :class="{ 'ad-refreshing': store.registrationsLoading }" />
        </IconButton>
      </div>
    </div>

    <div v-if="!signedIn" class="ad-card ad-center">
      <span class="ad-center-title">{{ t('settings.devices.myDevicesSignedOut') }}</span>
      <Button class="ad-log-in" variant="secondary" size="sm" @click="emit('login')">{{ t('settings.devices.logIn') }}</Button>
    </div>
    <template v-else-if="rows.length === 0">
      <div v-if="loadFailed" class="ad-card ad-center">
        <span class="ad-center-title">{{ t('remoteControl.devicesLoadFailed') }}</span>
        <span class="ad-center-detail">{{ store.registrationsError }}</span>
        <Button variant="secondary" size="sm" @click="refresh">{{ t('remoteControl.retry') }}</Button>
      </div>
      <div v-else-if="store.registrations === null" class="ad-card ad-center" role="status">
        <Spinner size="md" />
      </div>
      <div v-else class="ad-card ad-empty">{{ t('settings.devices.myDevicesEmpty', { command: 'kimi rc --background' }) }}</div>
    </template>

    <template v-if="rows.length > 0">
      <div v-if="signedIn && store.registrationsError !== null" class="ad-inline-error">
        <span>{{ t('remoteControl.devicesLoadFailed') }}</span>
        <Button variant="text" @click="refresh">{{ t('remoteControl.retry') }}</Button>
      </div>
      <div class="ad-card" role="list" :aria-label="t('settings.devices.myDevices')">
        <div v-if="shown.length === 0" class="ad-empty">{{ t('settings.devices.myDevicesEmpty', { command: 'kimi rc --background' }) }}</div>
        <div
          v-for="row in listed"
          :key="row.id"
          class="ad-row"
          :class="{ 'ad-row--offline': !online(row) && rowState(row) !== 'ready', 'ad-row--flash': flashId === row.id }"
          :data-device-id="row.id"
          role="listitem"
        >
          <form v-if="renamingId === row.id" class="ad-rename" @submit.prevent="void submitRename(row)">
            <Input
              :ref="(el) => { renameInput = el as InstanceType<typeof Input> | null; }"
              v-model="renameValue"
              size="sm"
              maxlength="50"
              :error="renameFailed"
              :disabled="renameSubmitting"
              :placeholder="t('remoteControl.renamePlaceholder')"
              :aria-label="t('remoteControl.rename')"
              @keydown.esc.prevent="cancelRename"
            />
            <IconButton size="sm" type="submit" :label="t('remoteControl.save')" :tooltip="t('remoteControl.save')" :disabled="renameSubmitting || renameValue.trim().length === 0">
              <Icon name="check" />
            </IconButton>
            <IconButton size="sm" :label="t('remoteControl.cancel')" :tooltip="t('remoteControl.cancel')" :disabled="renameSubmitting" @click="cancelRename">
              <Icon name="close" />
            </IconButton>
          </form>
          <template v-else>
            <span class="ad-copy">
              <span class="ad-name" :title="rowName(row)">{{ rowName(row) }}</span>
              <span class="ad-status" :class="statusClass(row)">
                <StatusDot :status="dot(row)" />
                <span class="ad-state">{{ stateLabel(row) }}</span>
                <span v-for="(detail, index) in details(row)" :key="index" class="ad-detail" :title="detail">{{ detail }}</span>
              </span>
            </span>
            <Button v-if="upgradeInline(row)" class="ad-action ad-upgrade" variant="secondary" size="xs" @click="upgradeRow(row)">{{ t('settings.devices.upgradeShort') }}</Button>
            <Button v-else-if="canReconnect(row)" class="ad-action ad-reconnect" variant="secondary" size="xs" @click="reconnect(row)">{{ t('settings.devices.reconnect') }}</Button>
            <Tooltip :text="t('settings.devices.useHere')">
              <Switch
                :model-value="added(row)"
                :label="t('settings.devices.enabledLabel', { name: rowName(row) })"
                :disabled="pendingId !== ''"
                @update:model-value="setAdded(row, $event)"
              />
            </Tooltip>
            <IconButton
              class="ad-more"
              :class="{ open: menuOpen && menuId === row.id }"
              size="sm"
              :label="t('remoteControl.deviceMenu')"
              :tooltip="t('remoteControl.deviceMenu')"
              aria-haspopup="menu"
              :aria-expanded="menuOpen && menuId === row.id"
              @click.stop="toggleMenu(row, $event)"
            >
              <Icon name="dots-horizontal" />
            </IconButton>
          </template>
        </div>
        <button v-if="folded.length > 0" type="button" class="ad-fold" :aria-expanded="foldOpen" @click="foldOpen = !foldOpen">
          <Icon :name="foldOpen ? 'chevron-down' : 'chevron-right'" size="sm" />
          <span>{{ t('settings.devices.longOffline', { n: folded.length, days: LONG_OFFLINE_DAYS }) }}</span>
        </button>
      </div>
    </template>

    <p v-if="renameFailed" class="ad-error" role="alert">{{ t('remoteControl.renameFailed') }}</p>
    <p v-if="actionError" class="ad-error" role="alert">{{ actionError }}</p>

    <Transition name="menu-pop">
      <Menu v-if="menuOpen && menuRow" ref="menuRef" class="ad-menu" :style="menuStyle" @click.stop>
        <MenuItem v-if="createProject && added(menuRow) && rowState(menuRow) === 'ready'" @click="startProject(menuRow)">
          <Icon name="folder-plus" size="sm" />{{ t('workspace.dialog.createTitle') }}
        </MenuItem>
        <MenuItem v-if="added(menuRow)" @click="reconnect(menuRow)">
          <Icon name="refresh" size="sm" />{{ t('settings.devices.reconnect') }}
        </MenuItem>
        <MenuItem v-if="store.canUpgrade(menuRow.id) && !upgradeInline(menuRow)" @click="upgradeRow(menuRow)">
          <Icon name="download" size="sm" />{{ t('settings.devices.upgrade') }}
        </MenuItem>
        <template v-if="menuRow.registration">
          <MenuItem v-if="added(menuRow)" separator />
          <MenuItem @click="startRename(menuRow)">
            <Icon name="pencil" size="sm" />{{ t('remoteControl.rename') }}
          </MenuItem>
          <MenuItem danger @click="removeFromAccount(menuRow)">
            <Icon :name="online(menuRow) ? 'close' : 'trash'" size="sm" />{{ t(online(menuRow) ? 'remoteControl.deactivate' : 'remoteControl.delete') }}
          </MenuItem>
        </template>
      </Menu>
    </Transition>
  </section>
</template>

<style scoped>
.ad { display: flex; flex-direction: column; gap: var(--space-3); }
.ad-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 28px; }
.ad-title { margin: 0; color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); }
.ad-head-actions { display: flex; flex: none; align-items: center; gap: var(--space-2); }
.ad-usage { color: var(--color-text-faint); font-family: var(--font-ui); font-size: var(--text-xs); }
.ad-refreshing { animation: ad-refresh-spin 700ms linear infinite; }
@keyframes ad-refresh-spin {
  to { transform: rotate(360deg); }
}
.ad-card { overflow: hidden; border-radius: var(--radius-xl); background: var(--color-surface); }
.ad-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); min-height: 120px; padding: var(--space-4); color: var(--color-text-faint); font-family: var(--font-ui); text-align: center; }
.ad-center-title { color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.ad-center-detail { overflow: hidden; max-width: 100%; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.ad-empty { padding: var(--space-4); color: var(--color-text-faint); font-family: var(--font-ui); font-size: var(--text-xs); line-height: var(--leading-normal); text-align: center; }
.ad-row { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: 0 var(--space-3) 0 var(--space-4); transition: background var(--duration-fast) var(--ease-out); }
.ad-row + .ad-row, .ad-row + .ad-fold, .ad-empty + .ad-row, .ad-empty + .ad-fold { border-top: var(--p-hairline) solid var(--color-line); }
.ad-row:hover { background: var(--color-hover); }
.ad-row--flash { animation: ad-flash 1.2s var(--ease-out); }
@keyframes ad-flash {
  0% { background: var(--color-accent-soft); }
  100% { background: transparent; }
}
.ad-action { flex: none; }
.ad-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; font-family: var(--font-ui); }
.ad-name { overflow: hidden; color: var(--color-text); font-size: var(--text-sm); font-weight: var(--weight-option-label); text-overflow: ellipsis; white-space: nowrap; }
.ad-status { display: flex; align-items: center; gap: var(--space-1-5); min-width: 0; color: var(--color-text-faint); font-size: var(--text-xs); }
.ad-state { flex: none; }
.ad-status--failed .ad-state,
.ad-status--outdated .ad-state,
.ad-status--signedOut .ad-state,
.ad-status--upgrade-failed .ad-state { color: var(--color-danger); }
.ad-detail { flex: none; white-space: nowrap; }
.ad-detail:last-child { flex: 0 1 auto; overflow: hidden; min-width: 0; text-overflow: ellipsis; }
.ad-detail::before { content: '·'; margin-right: var(--space-1-5); }
.ad-row--offline .ad-name { color: var(--color-text-muted); }
.ad-more { flex: none; color: var(--color-text-faint); }
.ad-more.open { background: var(--color-hover); color: var(--color-text); }
.ad-rename { display: flex; flex: 1; align-items: center; gap: var(--space-2); min-width: 0; }
.ad-fold { display: flex; align-items: center; gap: var(--space-1); width: 100%; min-height: 40px; padding: 0 var(--space-4); border: none; background: transparent; color: var(--color-text-muted); font-family: var(--font-ui); font-size: var(--text-xs); text-align: left; cursor: pointer; }
.ad-fold:hover { background: var(--color-hover); color: var(--color-text); }
.ad-fold:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ad-inline-error { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--color-danger); font-family: var(--font-ui); font-size: var(--text-xs); }
.ad-error { margin: 0; color: var(--color-danger); font-family: var(--font-ui); font-size: var(--text-xs); }
.ad-menu { position: fixed; top: 0; left: 0; z-index: var(--z-dropdown); }
@media (prefers-reduced-motion: reduce) {
  .ad-refreshing { animation: none; }
}
</style>
