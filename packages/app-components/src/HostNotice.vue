<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { openHostSettings } from '@moonshot-ai/app-client/composables';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import { useHostFailureText } from './composables/useHostFailureText';

const props = defineProps<{ hostId?: string }>();

const { t } = useI18n();

const displayState = computed(() => hostsStore().displayState(props.hostId));
const host = computed(() => hostsStore().hostFor(props.hostId));
const error = computed(() => host.value?.connectError);
const retrying = computed(() => displayState.value === 'connecting' && (error.value !== undefined || host.value?.connectFailure !== undefined));
const state = computed(() => retrying.value ? 'failed' : displayState.value);
const visible = computed(() => state.value === 'disabled' || state.value === 'missing' || state.value === 'failed');
const failureText = useHostFailureText();
const failure = computed(() => failureText.label(host.value?.connectFailure, host.value?.remoteVersion));
const failureTitle = computed(() => [failureText.hint(host.value?.connectFailure, host.value?.host, name.value), error.value].filter(Boolean).join('\n\n'));
const name = computed(() => props.hostId === undefined ? '' : hostsStore().displayName(props.hostId) ?? '');
const connecting = computed(() => props.hostId !== undefined && hostsStore().connecting[props.hostId] === true);

async function reconnect(): Promise<void> {
  if (props.hostId === undefined) return;
  await hostsStore().connect(props.hostId).catch(() => undefined);
}

function openSettings(): void {
  openHostSettings(props.hostId);
}
</script>

<template>
  <div v-if="visible" class="host-notice" :class="`host-notice--${state}`" role="status">
    <Icon class="host-notice-icon" :name="state === 'failed' ? 'alert-triangle' : 'server'" size="sm" />
    <span class="host-notice-copy">
      <span class="host-notice-title" :title="t(`workspace.hostNotice.${state}`, { name })">{{ retrying ? t('workspace.hostState.retrying') : t(`workspace.hostNotice.${state}`, { name }) }}</span>
      <span v-if="state === 'failed' && failure" class="host-notice-reason host-notice-reason--known" :title="failureTitle">{{ failure }}</span>
      <span v-else-if="state === 'failed' && error" class="host-notice-reason" :title="error">{{ error.split('\n', 1)[0] }}</span>
    </span>
    <template v-if="state === 'failed'">
      <button
        type="button"
        class="host-notice-action host-notice-reconnect"
        :disabled="connecting || retrying"
        :aria-busy="(connecting || retrying) || undefined"
        @click="reconnect"
      >
        {{ t('workspace.hostNotice.reconnect') }}
      </button>
      <button type="button" class="host-notice-action host-notice-settings" @click="openSettings">
        {{ t('workspace.hostNotice.settings') }}
      </button>
    </template>
    <button
      v-else-if="state === 'disabled' || state === 'missing'"
      type="button"
      class="host-notice-action host-notice-settings"
      @click="openSettings"
    >
      {{ t('workspace.hostNotice.settings') }}
    </button>
  </div>
</template>

<style scoped>
.host-notice {
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
.host-notice-icon { flex: none; color: var(--color-text-faint); }
.host-notice--failed .host-notice-icon { color: var(--color-danger); }
.host-notice-copy {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  overflow: hidden;
}
.host-notice-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-notice-reason {
  flex: 0 1 auto;
  overflow: hidden;
  min-width: 0;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-notice-reason--known { font-family: var(--font-ui); }
.host-notice-reason::before { content: '·'; margin-right: var(--space-1-5); font-family: var(--font-ui); }
.host-notice-action {
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
.host-notice-action:hover:not(:disabled) { color: var(--color-text); }
.host-notice-action:disabled { opacity: 0.5; cursor: not-allowed; }
.host-notice-action:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: var(--p-focus-ring); }
.host-notice-action + .host-notice-action { margin-inline-start: var(--space-1); }
</style>
