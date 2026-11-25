<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { isLongOffline } from '@moonshot-ai/app-core/lib';
import { devicesStore, type DeviceDisplayState } from '@moonshot-ai/app-client/stores';
import { SegmentedControl } from '@moonshot-ai/app-ui';
import AccountDevicesSection from './AccountDevicesSection.vue';
import SshDevicesSection from './SshDevicesSection.vue';

defineProps<{
  openSshConfig?: (path: string) => void;
  pickIdentityFile?: (defaultPath?: string) => Promise<string | undefined>;
  createProject?: (deviceId: string) => void;
}>();

const emit = defineEmits<{
  login: [];
}>();

type DeviceTab = 'account' | 'ssh';

const PROBLEM_STATES: ReadonlySet<DeviceDisplayState> = new Set(['failed', 'outdated', 'signedOut']);

const { t } = useI18n();
const store = devicesStore();
const sshPage = ref(false);
const tab = ref<DeviceTab>('account');

function enabledIds(connection: DeviceTab): string[] {
  return store.devices.filter((row) => row.connection === connection && row.enabled !== false).map((row) => row.id);
}

function tabLabel(label: string, count: number): string {
  return count > 0 ? `${label} ${count}` : label;
}

function problemSwatch(connection: DeviceTab): string | undefined {
  return enabledIds(connection).some((id) => PROBLEM_STATES.has(store.displayState(id))) ? 'var(--color-danger)' : undefined;
}

const activeAccountCount = computed(() => {
  const now = Date.now();
  return store.myDevices.filter((row) => row.device !== undefined || row.registration === undefined || !isLongOffline(row.registration, now)).length;
});

const tabs = computed(() => [
  {
    value: 'account',
    label: tabLabel(t('settings.devices.myDevices'), activeAccountCount.value),
    swatch: problemSwatch('account'),
  },
  {
    value: 'ssh',
    label: tabLabel(t('settings.devices.sshTitle'), store.devices.filter((row) => row.connection === 'ssh').length),
    swatch: problemSwatch('ssh'),
  },
]);

function selectTab(value: string): void {
  tab.value = value === 'ssh' ? 'ssh' : 'account';
}

watch(() => [store.focusDeviceId, store.addIfEmpty] as const, ([focusId, addIfEmpty]) => {
  if (addIfEmpty) tab.value = 'ssh';
  else if (focusId !== null) tab.value = store.deviceFor(focusId)?.connection === 'account' ? 'account' : 'ssh';
}, { immediate: true });
</script>

<template>
  <div class="dp">
    <section v-if="$slots['this-device']" v-show="!sshPage" class="dp-this-device" :aria-label="t('settings.devices.thisDevice')">
      <h3 class="dp-title">{{ t('settings.devices.thisDevice') }}</h3>
      <slot name="this-device" />
    </section>
    <AccountDevicesSection v-show="!sshPage && tab === 'account'" :create-project="createProject" @login="emit('login')">
      <template #title>
        <SegmentedControl class="dp-tabs" size="sm" :model-value="tab" :options="tabs" @update:model-value="selectTab" />
      </template>
    </AccountDevicesSection>
    <SshDevicesSection
      v-show="tab === 'ssh'"
      :open-ssh-config="openSshConfig"
      :pick-identity-file="pickIdentityFile"
      :create-project="createProject"
      @page="sshPage = $event"
    >
      <template #title>
        <SegmentedControl class="dp-tabs" size="sm" :model-value="tab" :options="tabs" @update:model-value="selectTab" />
      </template>
    </SshDevicesSection>
  </div>
</template>

<style scoped>
.dp { display: flex; flex-direction: column; gap: var(--space-8); }
.dp-this-device { display: flex; flex-direction: column; gap: var(--space-3); }
.dp-title { margin: 0; color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-base); font-weight: var(--weight-medium); }
.dp-tabs { flex: none; }
</style>
