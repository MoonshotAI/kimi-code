<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, StatusDot, type IconSize } from '@moonshot-ai/app-ui';
import { devicesStore, type DeviceDisplayState } from '@moonshot-ai/app-client/stores';

const props = withDefaults(defineProps<{
  deviceId?: string;
  size?: IconSize;
  status?: 'all' | 'none';
}>(), {
  deviceId: undefined,
  size: undefined,
  status: 'all',
});

const DOTS: Partial<Record<DeviceDisplayState, string>> = {
  ready: 'ok',
  connecting: 'running',
  idle: 'idle',
  offline: 'idle',
  failed: 'error',
  outdated: 'error',
  signedOut: 'error',
};

const { t } = useI18n();
const state = computed(() => devicesStore().displayState(props.deviceId));
const icon = computed(() => (devicesStore().deviceFor(props.deviceId)?.connection === 'account' ? 'device-desktop' : 'server'));
const dot = computed(() => (props.status === 'none' ? undefined : DOTS[state.value]));
const label = computed(() => {
  if (props.deviceId === undefined) return undefined;
  const description = t(`workspace.deviceState.${state.value}`);
  return state.value === 'missing' ? description : `${devicesStore().displayName(props.deviceId)} · ${description}`;
});
</script>

<template>
  <Icon v-if="state === 'local'" name="folder-closed" :size="size" />
  <span v-else class="ws-icon" :class="`ws-icon--${state}`" :title="label" :aria-label="label" role="img">
    <Icon :name="icon" :size="size" />
    <StatusDot v-if="dot" class="ws-icon-dot" :status="dot" />
  </span>
</template>

<style scoped>
.ws-icon {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
}
.ws-icon--disabled,
.ws-icon--missing,
.ws-icon--duplicate,
.ws-icon--self {
  opacity: 0.55;
}
.ws-icon-dot {
  position: absolute;
  right: -2px;
  bottom: -1px;
  width: 6px;
  height: 6px;
  box-shadow: 0 0 0 1.5px var(--color-surface, var(--color-bg));
}
</style>
