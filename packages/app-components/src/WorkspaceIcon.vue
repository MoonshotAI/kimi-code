<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, StatusDot, type IconSize } from '@moonshot-ai/app-ui';
import { hostsStore } from '@moonshot-ai/app-client/stores';

const props = withDefaults(defineProps<{
  hostId?: string;
  size?: IconSize;
  status?: 'all' | 'none';
}>(), {
  hostId: undefined,
  size: undefined,
  status: 'all',
});

const { t } = useI18n();
const state = computed(() => hostsStore().displayState(props.hostId));
const dot = computed(() => {
  if (props.status === 'none') return undefined;
  if (state.value === 'failed') return 'error';
  if (state.value === 'ready') return 'ok';
  if (state.value === 'connecting') return 'running';
  if (state.value === 'idle') return 'idle';
  return undefined;
});
const label = computed(() => {
  if (props.hostId === undefined) return undefined;
  const description = t(`workspace.hostState.${state.value}`);
  return state.value === 'missing' ? description : `${hostsStore().displayName(props.hostId)} · ${description}`;
});
</script>

<template>
  <Icon v-if="state === 'local'" name="folder-closed" :size="size" />
  <span v-else class="ws-icon" :class="`ws-icon--${state}`" :title="label" :aria-label="label" role="img">
    <Icon name="server" :size="size" />
    <StatusDot v-if="dot" class="ws-icon-dot" :status="dot" size="sm" ring="surface" />
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
.ws-icon--missing {
  opacity: 0.55;
}
.ws-icon-dot {
  position: absolute;
  right: -2px;
  bottom: -1px;
}
</style>
