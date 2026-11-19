<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Spinner } from '@moonshot-ai/app-ui';
import { openDeviceSettings, useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { devicesStore, warningsStore, type DeviceDisplayState } from '@moonshot-ai/app-client/stores';
import { useDeviceFailureText } from './composables/useDeviceFailureText';

type NoticeState = DeviceDisplayState | 'upgrading' | 'restarting' | 'upgradeFailed';

const props = defineProps<{ deviceId?: string }>();

const emit = defineEmits<{ login: [] }>();

const VISIBLE_STATES: ReadonlySet<NoticeState> = new Set(['disabled', 'missing', 'failed', 'offline', 'outdated', 'signedOut', 'duplicate', 'self', 'upgrading', 'restarting', 'upgradeFailed']);
const ALERT_STATES: ReadonlySet<NoticeState> = new Set(['failed', 'outdated', 'signedOut', 'duplicate', 'upgradeFailed']);
const RECONNECT_STATES: ReadonlySet<NoticeState> = new Set(['failed', 'offline', 'outdated']);
const SETTINGS_STATES: ReadonlySet<NoticeState> = new Set(['failed', 'disabled', 'missing']);

const { t } = useI18n();
const { confirm } = useConfirmDialog();
const failureText = useDeviceFailureText();
const store = devicesStore();
const canUpgrade = computed(() => store.canUpgrade(props.deviceId));
const device = computed(() => store.deviceFor(props.deviceId));
const error = computed(() => device.value?.connectError);
const displayState = computed(() => store.displayState(props.deviceId));
const upgradeStatus = computed(() => store.upgradeStatus(props.deviceId));
const retrying = computed(() => upgradeStatus.value !== 'installing'
  && upgradeStatus.value !== 'restarting'
  && displayState.value === 'connecting'
  && (error.value !== undefined || device.value?.connectFailure !== undefined));
const state = computed<NoticeState>(() => {
  if (upgradeStatus.value === 'installing') return 'upgrading';
  if (upgradeStatus.value === 'restarting') return 'restarting';
  if (upgradeStatus.value === 'failed' && displayState.value === 'outdated' && canUpgrade.value) return 'upgradeFailed';
  return retrying.value ? 'failed' : displayState.value;
});
const visible = computed(() => VISIBLE_STATES.has(state.value));
const upgrading = computed(() => state.value === 'upgrading' || state.value === 'restarting');
const name = computed(() => props.deviceId === undefined ? '' : store.displayName(props.deviceId) ?? '');
const duplicateName = computed(() => {
  const other = device.value?.duplicateOf;
  return other === undefined ? '' : store.displayName(other) ?? other;
});
const title = computed(() => retrying.value
  ? t('workspace.deviceState.retrying')
  : t(`workspace.deviceNotice.${state.value}`, { name: name.value, other: duplicateName.value }));
const icon = computed(() => {
  if (ALERT_STATES.has(state.value)) return 'alert-triangle';
  return device.value?.connection === 'account' ? 'device-desktop' : 'server';
});
const install = computed(() => (props.deviceId === undefined ? undefined : store.install(props.deviceId)));
const failureContext = computed(() => ({ host: device.value?.host, name: name.value, install: install.value }));
const knownReason = computed(() => {
  if (state.value === 'failed') return failureText.label(device.value?.connectFailure, device.value?.remoteVersion);
  if (state.value === 'offline') return t('workspace.deviceNotice.offlineHint');
  if (state.value === 'outdated' && !canUpgrade.value && install.value !== undefined) return failureText.hint('outdated', failureContext.value);
  return '';
});
const reasonTitle = computed(() => {
  if (state.value === 'outdated') return [failureText.label('outdated', device.value?.remoteVersion), error.value].filter(Boolean).join('\n\n');
  if (state.value === 'failed') return [failureText.hint(device.value?.connectFailure, failureContext.value), error.value].filter(Boolean).join('\n\n');
  return knownReason.value;
});
const rawReason = computed(() => {
  if (state.value === 'failed') return error.value ?? '';
  if (state.value === 'upgradeFailed') return device.value?.upgradeError ?? '';
  return '';
});
const connecting = computed(() => props.deviceId !== undefined && store.connecting[props.deviceId] === true);
const reconnectBusy = computed(() => connecting.value || retrying.value);

async function reconnect(): Promise<void> {
  if (props.deviceId === undefined) return;
  await store.connect(props.deviceId).catch(() => undefined);
}

function upgrade(): void {
  if (props.deviceId !== undefined) void store.upgrade(props.deviceId);
}

function openSettings(): void {
  openDeviceSettings(props.deviceId);
}

async function removeEntry(): Promise<void> {
  const deviceId = props.deviceId;
  if (deviceId === undefined) return;
  await confirm({
    title: t('settings.devices.deleteTitle'),
    message: state.value === 'duplicate'
      ? t('workspace.deviceNotice.duplicateDeleteMessage', { other: duplicateName.value })
      : t('workspace.deviceNotice.selfDeleteMessage'),
    confirmLabel: t('settings.devices.delete'),
    variant: 'danger',
    action: () => store.remove(deviceId),
  }).catch((err: unknown) => {
    warningsStore().pushOperationFailure('deleteDevice', err);
  });
}
</script>

<template>
  <div v-if="visible" class="device-notice" :class="`device-notice--${state}`" role="status">
    <Spinner v-if="upgrading" size="sm" />
    <Icon v-else class="device-notice-icon" :name="icon" size="sm" />
    <span class="device-notice-copy">
      <span class="device-notice-title" :title="title">{{ title }}</span>
      <span v-if="knownReason" class="device-notice-reason device-notice-reason--known" :title="reasonTitle">{{ knownReason }}</span>
      <span v-else-if="rawReason" class="device-notice-reason" :title="rawReason">{{ rawReason.split('\n', 1)[0] }}</span>
    </span>
    <button v-if="state === 'outdated' && canUpgrade" type="button" class="device-notice-action device-notice-upgrade" @click="upgrade">
      {{ t('workspace.deviceNotice.upgrade') }}
    </button>
    <button v-else-if="state === 'upgradeFailed'" type="button" class="device-notice-action device-notice-retry" @click="upgrade">
      {{ t('workspace.deviceNotice.retry') }}
    </button>
    <button
      v-if="RECONNECT_STATES.has(state)"
      type="button"
      class="device-notice-action device-notice-reconnect"
      :disabled="reconnectBusy"
      :aria-busy="reconnectBusy || undefined"
      @click="reconnect"
    >
      {{ t('workspace.deviceNotice.reconnect') }}
    </button>
    <button v-else-if="state === 'signedOut'" type="button" class="device-notice-action device-notice-log-in" @click="emit('login')">
      {{ t('workspace.deviceNotice.logIn') }}
    </button>
    <button v-else-if="state === 'duplicate' || state === 'self'" type="button" class="device-notice-action device-notice-delete" @click="removeEntry">
      {{ t(state === 'duplicate' ? 'workspace.deviceNotice.deleteDuplicate' : 'workspace.deviceNotice.deleteDevice') }}
    </button>
    <button v-if="SETTINGS_STATES.has(state)" type="button" class="device-notice-action device-notice-settings" @click="openSettings">
      {{ t('workspace.deviceNotice.settings') }}
    </button>
  </div>
</template>

<style scoped>
.device-notice {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  box-sizing: border-box;
  min-width: 0;
  min-height: 28px;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.device-notice-icon { flex: none; color: var(--color-text-faint); }
.device-notice--failed .device-notice-icon,
.device-notice--upgradeFailed .device-notice-icon { color: var(--color-danger); }
.device-notice--outdated .device-notice-icon,
.device-notice--signedOut .device-notice-icon,
.device-notice--duplicate .device-notice-icon { color: var(--color-warning); }
.device-notice-copy {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  overflow: hidden;
}
.device-notice-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-notice-reason {
  flex: 0 1 auto;
  overflow: hidden;
  min-width: 0;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-notice-reason--known { font-family: var(--font-ui); }
.device-notice-reason::before { content: '·'; margin-right: var(--space-1-5); font-family: var(--font-ui); }
.device-notice-action {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-muted);
  font: inherit;
  white-space: nowrap;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.device-notice-action:hover:not(:disabled) { color: var(--color-text); }
.device-notice-action:disabled { opacity: 0.5; cursor: not-allowed; }
.device-notice-action:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: var(--p-focus-ring); }
.device-notice-action + .device-notice-action { margin-inline-start: var(--space-1); }
</style>
