<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type { RcDevice } from '@moonshot-ai/app-core/lib';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { Button, Dialog, Icon, Switch } from '@moonshot-ai/app-ui';

import {
  remoteControlErrorText,
  type RemoteControlConflictHolder,
  type RemoteControlController,
} from '../../composables/useRemoteControl';
import { track } from '../../lib/track';
import RemoteControlDeviceList from './RemoteControlDeviceList.vue';
import RemoteControlShare from './RemoteControlShare.vue';

const props = defineProps<{
  controller: RemoteControlController;
  signedIn: boolean;
}>();

const emit = defineEmits<{
  login: [];
}>();

const { t } = useI18n();

const status = computed(() => props.controller.status.value);
const statusError = computed(() => props.controller.statusError.value);
const enabled = computed(() => status.value?.enabled === true);
const opening = computed(() => props.controller.enabling.value || status.value?.state === 'starting');
const closing = computed(() => props.controller.disabling.value || status.value?.state === 'stopping');
const initialLoading = computed(() => props.controller.statusLoading.value && status.value === null);
const initialError = computed(() => status.value === null && statusError.value !== null);
const refreshError = computed(() => (status.value !== null ? statusError.value : null));
const conflict = computed(() => props.controller.conflict.value);
const toggleError = computed(
  () =>
    props.controller.toggleError.value ??
    (conflict.value === null ? (status.value?.error ?? null) : null),
);
const devices = computed(() => props.controller.devices.value);
const devicesLoading = computed(() => props.controller.devicesLoading.value);
const devicesRefreshing = computed(() => props.controller.devicesRefreshing.value);
const devicesError = computed(() => props.controller.devicesError.value);
const restoreEnabled = computed(() => props.controller.restoreEnabled.value);
const restoreStateLoading = computed(() => props.controller.restoreStateLoading.value);
const restoreStateSaving = computed(() => props.controller.restoreStateSaving.value);
const restoreStateError = computed(() => props.controller.restoreStateError.value);

onMounted(() => {
  void props.controller.open();
});

watch(
  () => props.signedIn,
  (signedIn) => {
    if (signedIn) void props.controller.refreshDevices();
  },
);

const takingOver = computed(() => props.controller.takingOver.value);
const takeoverError = ref<string | null>(null);
const conflictDialogOpen = props.controller.conflictDialogOpen;
const dialogHolder = ref<RemoteControlConflictHolder | null>(null);
const dialogTime = computed(() =>
  dialogHolder.value === null ? '' : new Date(dialogHolder.value.started_at).toLocaleString(),
);

let takeoverSettled = false;

function closeConflictDialog(): void {
  if (!takeoverSettled && !takingOver.value) {
    track('remote_control_action', { action: 'takeover', outcome: 'cancelled' });
  }
  takeoverSettled = false;
  conflictDialogOpen.value = false;
  dialogHolder.value = null;
}

async function onTakeover(): Promise<void> {
  takeoverError.value = null;
  try {
    await props.controller.takeover();
    takeoverSettled = true;
    if (conflict.value === null) {
      if (props.controller.toggleError.value !== null) {
        track('remote_control_action', { action: 'takeover', outcome: 'error' });
      } else {
        track('remote_control_action', { action: 'takeover', outcome: 'ok' });
      }
      closeConflictDialog();
    } else {
      track('remote_control_action', { action: 'takeover', outcome: 'error' });
      dialogHolder.value = conflict.value;
    }
  } catch (error) {
    takeoverSettled = true;
    track('remote_control_action', { action: 'takeover', outcome: 'error' });
    takeoverError.value = remoteControlErrorText(error, t('remoteControl.actionFailed'));
  }
}

function onSwitch(value: boolean): void {
  if (value) {
    if (!props.signedIn) {
      track('remote_control_action', { action: 'enable', outcome: 'login_required' });
      emit('login');
      return;
    }
    void enable();
    return;
  }
  void disable();
}

async function enable(): Promise<void> {
  await props.controller.setEnabled(true);
  if (conflict.value !== null) {
    track('remote_control_action', { action: 'enable', outcome: 'conflict' });
    takeoverError.value = null;
    dialogHolder.value = conflict.value;
    conflictDialogOpen.value = true;
    return;
  }
  track('remote_control_action', {
    action: 'enable',
    outcome: props.controller.toggleError.value === null ? 'ok' : 'error',
  });
}

async function disable(): Promise<void> {
  await props.controller.setEnabled(false);
  track('remote_control_action', {
    action: 'disable',
    outcome: props.controller.toggleError.value === null ? 'ok' : 'error',
  });
}

const { confirm } = useConfirmDialog();
const deactivateError = ref<string | null>(null);

function trackDeviceAction(
  action: 'deactivate' | 'delete',
  outcome: 'ok' | 'error' | 'cancelled',
  target: 'current_device' | 'other_device',
): void {
  if (action === 'delete') track('remote_control_action', { action: 'delete', outcome, target });
  else track('remote_control_action', { action: 'deactivate', outcome, target });
}

async function requestConfirm(device: RcDevice): Promise<void> {
  deactivateError.value = null;
  const offline = device.status === 'offline';
  const action = offline ? 'delete' : 'deactivate';
  const target =
    status.value?.device_id !== undefined && device.device_id === status.value.device_id
      ? 'current_device'
      : 'other_device';
  try {
    const confirmed = await confirm({
      title: t(offline ? 'remoteControl.deleteTitle' : 'remoteControl.deactivateTitle', {
        name: device.alias,
      }),
      message: t(offline ? 'remoteControl.deleteHint' : 'remoteControl.deactivateHint', {
        name: device.alias,
      }),
      confirmLabel: t(offline ? 'remoteControl.delete' : 'remoteControl.deactivate'),
      cancelLabel: t('remoteControl.cancel'),
      variant: 'danger',
      initialFocus: 'cancel',
      action: () =>
        offline
          ? props.controller.deleteDevice(device.device_id)
          : props.controller.deactivateDevice(device.device_id),
    });
    trackDeviceAction(action, confirmed ? 'ok' : 'cancelled', target);
  } catch (error) {
    trackDeviceAction(action, 'error', target);
    deactivateError.value = remoteControlErrorText(error, t('remoteControl.actionFailed'));
  }
}
</script>

<template>
  <div class="rcp">
    <section class="rcp-sec">
      <h3 class="rcp-title">{{ t('remoteControl.title') }}</h3>
      <div class="rcp-group">
        <div class="rcp-row">
          <div class="rcp-row__label">
            <span class="rcp-row__title">
              {{ enabled ? t('remoteControl.statusOn') : t('remoteControl.title') }}
            </span>
            <span class="rcp-row__desc">
              {{ t('remoteControl.enableHint') }}
            </span>
          </div>
          <Switch
            :model-value="enabled"
            :disabled="initialLoading || opening || closing"
            :label="enabled ? t('remoteControl.turnOff') : t('remoteControl.enable')"
            @update:model-value="onSwitch"
          />
        </div>
        <div v-if="enabled && status?.url" class="rcp-expand">
          <RemoteControlShare :url="status.url" source="panel" />
          <div class="rcp-note">
            <Icon name="info" size="sm" />
            <span>{{ t('remoteControl.securityNote') }}</span>
          </div>
        </div>
      </div>
      <div class="rcp-group rcp-restore">
        <div class="rcp-row">
          <div class="rcp-row__label">
            <span class="rcp-row__title">{{ t('remoteControl.restoreState') }}</span>
            <span class="rcp-row__desc">{{ t('remoteControl.restoreStateHint') }}</span>
          </div>
          <Switch
            :model-value="restoreEnabled"
            :disabled="initialLoading || opening || closing || restoreStateLoading || restoreStateSaving"
            :label="t('remoteControl.restoreState')"
            @update:model-value="void controller.setRestoreEnabled($event)"
          />
        </div>
      </div>
      <p v-if="restoreStateError" class="rcp-error">{{ restoreStateError }}</p>
      <p v-if="toggleError" class="rcp-error">{{ toggleError }}</p>
      <p v-if="initialError" class="rcp-error">
        {{ t('remoteControl.statusLoadFailed') }}：{{ statusError }}
        <Button variant="secondary" size="sm" @click="void controller.loadStatus()">
          {{ t('remoteControl.retry') }}
        </Button>
      </p>
      <p v-if="refreshError" class="rcp-error">
        {{ t('remoteControl.statusLoadFailed') }}：{{ refreshError }}
        <Button variant="secondary" size="sm" @click="void controller.loadStatus()">
          {{ t('remoteControl.retry') }}
        </Button>
      </p>
    </section>

    <section v-if="signedIn" class="rcp-sec">
      <RemoteControlDeviceList
        :devices="devices"
        :loading="devicesLoading"
        :refreshing="devicesRefreshing"
        :error="devicesError"
        :current-device-id="status?.device_id"
        :refresh="controller.refreshDevices"
        :rename="controller.renameDevice"
        @confirm="requestConfirm"
      />
      <p v-if="deactivateError" class="rcp-error">{{ deactivateError }}</p>
    </section>
  </div>

  <Dialog
    :open="conflictDialogOpen && dialogHolder !== null"
    size="md"
    panel-class="rcp-conflict-dialog"
    :title="t('remoteControl.conflictTitle')"
    @update:open="closeConflictDialog"
  >
    <div v-if="dialogHolder" class="rcp-conflict">
      <p class="rcp-conflict__meta">
        {{ t('remoteControl.conflictMeta', { pid: dialogHolder.pid, time: dialogTime }) }}
      </p>
      <p class="rcp-conflict__hint">{{ t('remoteControl.conflictHint') }}</p>
      <RemoteControlShare :url="dialogHolder.url" source="conflict_dialog" />
      <p v-if="takeoverError" class="rcp-conflict__error">{{ takeoverError }}</p>
    </div>
    <template #foot>
      <Button variant="secondary" :disabled="takingOver" @click="closeConflictDialog">
        {{ t('remoteControl.continueUsing') }}
      </Button>
      <Button :loading="takingOver" @click="void onTakeover()">
        {{ t('remoteControl.takeover') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.rcp-sec {
  padding: var(--space-4) 0;
}
.rcp-sec:first-child {
  padding-top: 0;
}
.rcp-title {
  margin: 0 0 var(--space-3);
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.rcp-group {
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.rcp-restore {
  margin-top: var(--space-3);
}
@media (max-width: 900px) {
  .rcp-restore .rcp-row__desc {
    max-width: 48ch;
  }
}
.rcp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-4);
}
.rcp-row__label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rcp-row__title {
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
}
.rcp-row__desc {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.rcp-expand {
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-top: var(--p-hairline) solid var(--color-line);
}
.rcp-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  margin-top: var(--space-3);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.rcp-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  color: var(--color-danger);
  font-size: var(--text-sm);
}
.rcp-conflict {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
}
.rcp-conflict__meta {
  align-self: flex-start;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.rcp-conflict__hint {
  align-self: flex-start;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.rcp-conflict__error {
  align-self: flex-start;
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-xs);
}
:global(.rcp-conflict-dialog .ui-dialog__foot) {
  flex-wrap: wrap;
}
:global(.rcp-conflict-dialog .ui-dialog__foot .ui-button) {
  max-width: 100%;
  height: auto;
  min-height: 36px;
  padding-top: var(--space-2);
  padding-bottom: var(--space-2);
  white-space: normal;
  line-height: 1.25;
}
</style>
