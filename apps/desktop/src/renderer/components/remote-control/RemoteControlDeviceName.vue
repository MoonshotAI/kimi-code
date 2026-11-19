<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import type { RemoteControlStatus } from '@moonshot-ai/app-core/api';
import { devicesStore } from '@moonshot-ai/app-client/stores';
import { Icon, IconButton, Input } from '@moonshot-ai/app-ui';

import { track } from '../../lib/track';

interface HostNameBridge {
  getHostName?: () => Promise<string>;
}

const props = defineProps<{
  status: RemoteControlStatus | null;
}>();

const { t } = useI18n();
const store = devicesStore();
const hostName = ref('');
const renaming = ref(false);
const renameValue = ref('');
const submitting = ref(false);
const failed = ref(false);
const input = ref<InstanceType<typeof Input> | null>(null);

const deviceId = computed(() => store.localDeviceId || props.status?.device_id || '');
const registration = computed(() => store.registrations?.find((entry) => entry.device_id === deviceId.value));
const running = computed(() => props.status?.device_id !== undefined && props.status.device_id === deviceId.value);
const registered = computed(() => registration.value !== undefined || running.value);
const name = computed(() => registration.value?.alias || (running.value ? props.status?.device_name : undefined) || hostName.value);

onMounted(async () => {
  const bridge = (globalThis as { kimiDesktop?: HostNameBridge }).kimiDesktop;
  hostName.value = (await bridge?.getHostName?.().catch(() => '')) ?? '';
});

async function startRename(): Promise<void> {
  renaming.value = true;
  renameValue.value = name.value;
  failed.value = false;
  await nextTick();
  input.value?.focus();
  input.value?.select();
}

function cancelRename(): void {
  track('remote_control_action', { action: 'rename', outcome: 'cancelled' });
  renaming.value = false;
  failed.value = false;
}

async function submitRename(): Promise<void> {
  const alias = renameValue.value.trim();
  if (submitting.value) return;
  if (alias.length === 0 || alias.length > 50) {
    failed.value = true;
    return;
  }
  submitting.value = true;
  failed.value = false;
  try {
    await store.renameRegistration(deviceId.value, alias);
    track('remote_control_action', { action: 'rename', outcome: 'ok' });
    renaming.value = false;
  } catch {
    track('remote_control_action', { action: 'rename', outcome: 'error' });
    failed.value = true;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="name" class="rcp-device">
    <div class="rcp-device__row">
      <form v-if="renaming" class="rcp-device__rename" @submit.prevent="void submitRename()">
        <Input
          ref="input"
          v-model="renameValue"
          size="sm"
          maxlength="50"
          :error="failed"
          :disabled="submitting"
          :placeholder="t('remoteControl.renamePlaceholder')"
          :aria-label="t('remoteControl.rename')"
          @keydown.esc.prevent="cancelRename"
        />
        <IconButton
          size="sm"
          type="submit"
          :label="t('remoteControl.save')"
          :tooltip="t('remoteControl.save')"
          :disabled="submitting || renameValue.trim().length === 0"
        >
          <Icon name="check" />
        </IconButton>
        <IconButton
          size="sm"
          :label="t('remoteControl.cancel')"
          :tooltip="t('remoteControl.cancel')"
          :disabled="submitting"
          @click="cancelRename"
        >
          <Icon name="close" />
        </IconButton>
      </form>
      <template v-else>
        <span class="rcp-device__name" :title="name">{{ name }}</span>
        <IconButton
          v-if="registered"
          class="rcp-device__rename-button"
          size="sm"
          :label="t('remoteControl.rename')"
          :tooltip="t('remoteControl.rename')"
          @click="void startRename()"
        >
          <Icon name="pencil" />
        </IconButton>
      </template>
    </div>
    <p v-if="failed" class="rcp-device__error" role="alert">{{ t('remoteControl.renameFailed') }}</p>
  </div>
</template>

<style scoped>
.rcp-device {
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.rcp-device__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: 0 var(--space-3) 0 var(--space-4);
}
.rcp-device__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rcp-device__rename-button {
  flex: none;
  color: var(--color-text-faint);
}
.rcp-device__rename {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.rcp-device__error {
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  color: var(--color-danger);
  font-size: var(--text-xs);
}
</style>
