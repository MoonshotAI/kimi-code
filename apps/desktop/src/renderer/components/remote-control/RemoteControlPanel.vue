<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { Button, Dialog, Switch } from '@moonshot-ai/app-ui';

import {
  remoteControlErrorText,
  type RemoteControlConflictHolder,
  type RemoteControlController,
} from '../../composables/useRemoteControl';
import { track } from '../../lib/track';
import RemoteControlDeviceName from './RemoteControlDeviceName.vue';
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
const restoreEnabled = computed(() => props.controller.restoreEnabled.value);
const restoreStateLoading = computed(() => props.controller.restoreStateLoading.value);
const restoreStateSaving = computed(() => props.controller.restoreStateSaving.value);
const restoreStateError = computed(() => props.controller.restoreStateError.value);

onMounted(() => {
  void props.controller.open();
});

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
</script>

<template>
  <div class="rcp">
    <div class="rcp-group">
      <RemoteControlDeviceName :status="status" />
      <div class="rcp-row">
        <span class="rcp-row__title">{{ t('settings.devices.allowControl') }}</span>
        <Switch
          :model-value="enabled"
          :disabled="initialLoading || opening || closing"
          :label="enabled ? t('remoteControl.turnOff') : t('remoteControl.enable')"
          @update:model-value="onSwitch"
        />
      </div>
      <RemoteControlShare v-if="enabled && status?.url" class="rcp-share" :url="status.url" source="panel" compact />
      <div class="rcp-row rcp-row--restore">
        <span class="rcp-row__title">{{ t('settings.devices.keepOnAfterRestart') }}</span>
        <Switch
          :model-value="restoreEnabled"
          :disabled="initialLoading || opening || closing || restoreStateLoading || restoreStateSaving"
          :label="t('settings.devices.keepOnAfterRestart')"
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
.rcp-group {
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.rcp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 52px;
  padding: 0 var(--space-3) 0 var(--space-4);
}
.rcp-row--restore {
  border-top: var(--p-hairline) solid var(--color-line);
}
.rcp-row__title {
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
}
.rcp-share {
  border-top: var(--p-hairline) solid var(--color-line);
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
