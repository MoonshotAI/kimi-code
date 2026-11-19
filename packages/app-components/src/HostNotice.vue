<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon } from '@moonshot-ai/app-ui';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import { useHostFailureText } from './composables/useHostFailureText';

const props = defineProps<{ hostId?: string }>();

const { t } = useI18n();
const state = computed(() => {
  const display = hostsStore().displayState(props.hostId);
  return display === 'ready' && hostsStore().needsLogin(props.hostId) ? 'signedOut' : display;
});
const visible = computed(() => state.value === 'disabled' || state.value === 'missing' || state.value === 'failed' || state.value === 'signedOut');
const host = computed(() => hostsStore().hostFor(props.hostId));
const error = computed(() => host.value?.connectError);
const failureText = useHostFailureText();
const failure = computed(() => failureText.label(host.value?.connectFailure, host.value?.remoteVersion));
const failureTitle = computed(() => [failureText.hint(host.value?.connectFailure), error.value].filter(Boolean).join('\n\n'));
const name = computed(() => props.hostId === undefined ? '' : hostsStore().displayName(props.hostId) ?? '');
const connecting = computed(() => props.hostId !== undefined && hostsStore().connecting[props.hostId] === true);
const copying = computed(() => props.hostId !== undefined && hostsStore().providerCopies[props.hostId]?.status === 'copying');

function signIn(): void {
  if (props.hostId !== undefined) hostsStore().openLogin(props.hostId);
}

async function copyLocalModels(): Promise<void> {
  const hostId = props.hostId;
  if (hostId !== undefined && await failureText.confirmCopy(name.value)) {
    await hostsStore().copyProviders(hostId);
  }
}

async function reconnect(): Promise<void> {
  if (props.hostId === undefined) return;
  await hostsStore().connect(props.hostId).catch(() => undefined);
}

</script>

<template>
  <div v-if="visible" class="host-notice" :class="`host-notice--${state}`" role="status">
    <Icon class="host-notice-icon" :name="state === 'failed' || state === 'signedOut' ? 'alert-triangle' : 'server'" size="sm" />
    <span class="host-notice-copy">
      <span class="host-notice-title" :title="t(`workspace.hostNotice.${state}`, { name })">{{ t(`workspace.hostNotice.${state}`, { name }) }}</span>
      <span v-if="state === 'failed' && failure" class="host-notice-reason host-notice-reason--known" :title="failureTitle">{{ failure }}</span>
      <span v-else-if="state === 'failed' && error" class="host-notice-reason" :title="error">{{ error.split('\n', 1)[0] }}</span>
    </span>
    <Button v-if="state === 'failed'" variant="secondary" size="xs" :loading="connecting" @click="reconnect">
      {{ t('workspace.hostNotice.reconnect') }}
    </Button>
    <template v-else-if="state === 'signedOut'">
      <Button class="host-notice-sign-in" variant="secondary" size="xs" @click="signIn">
        {{ t('workspace.hostNotice.signIn') }}
      </Button>
      <Button class="host-notice-use-local" variant="secondary" size="xs" :loading="copying" @click="copyLocalModels">
        {{ t('workspace.hostNotice.useLocal') }}
      </Button>
    </template>
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
.host-notice--signedOut .host-notice-icon { color: var(--color-warning); }
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
.host-notice :deep(.ui-button) { flex: none; color: var(--color-accent); }
</style>
