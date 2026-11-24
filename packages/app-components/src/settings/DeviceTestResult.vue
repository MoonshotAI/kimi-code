<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppDeviceConnectFailure } from '@moonshot-ai/app-core/api';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, Spinner, Tooltip } from '@moonshot-ai/app-ui';

const UPDATE_COMMAND = 'kimi upgrade';
const INSTALL_COMMAND = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';

const props = defineProps<{
  state: 'running' | 'failed';
  endpoint: string;
  failure?: AppDeviceConnectFailure;
  reason?: string;
  hint?: string;
  detail?: string;
}>();

const { t } = useI18n();
const copied = ref(false);
const commandCopied = ref(false);
let copiedTimer = 0;
let commandCopiedTimer = 0;

const command = computed(() => props.failure === 'executor_not_found'
  ? INSTALL_COMMAND
  : props.failure === 'outdated'
    ? UPDATE_COMMAND
    : '');
const commandLabel = computed(() => props.failure === 'executor_not_found'
  ? 'settings.devices.copyInstallCommand'
  : 'settings.devices.copyUpdateCommand');

watch(
  () => [props.state, props.endpoint, props.failure, props.reason, props.detail] as const,
  () => {
    commandCopied.value = false;
    window.clearTimeout(commandCopiedTimer);
  },
);

async function copyDetail(): Promise<void> {
  if (!await copyTextToClipboard(props.detail ?? '')) return;
  copied.value = true;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}

async function copyCommand(): Promise<void> {
  if (!await copyTextToClipboard(command.value)) return;
  commandCopied.value = true;
  window.clearTimeout(commandCopiedTimer);
  commandCopiedTimer = window.setTimeout(() => {
    commandCopied.value = false;
  }, 1200);
}

onUnmounted(() => {
  window.clearTimeout(copiedTimer);
  window.clearTimeout(commandCopiedTimer);
});
</script>

<template>
  <div class="etr" role="status">
    <div v-if="state === 'running'" class="etr-line etr-line--running">
      <span class="etr-marker"><Spinner size="xs" /></span>
      <span class="etr-label">{{ t('settings.devices.testing') }}</span>
      <span v-if="endpoint" class="etr-endpoint" :title="endpoint">{{ endpoint }}</span>
    </div>
    <div v-else class="etr-failure" role="alert">
      <span v-if="reason" class="etr-reason">{{ reason }}</span>
      <p v-if="hint || command" class="etr-solution">
        <span v-if="hint" class="etr-hint">{{ hint }}</span><Tooltip v-if="command" :text="command"><button
          type="button"
          class="etr-action etr-command"
          :class="failure === 'executor_not_found' ? 'etr-install-command' : 'etr-update-command'"
          @click.stop="copyCommand"
        >{{ t(commandCopied ? 'settings.copied' : commandLabel) }}</button></Tooltip>
      </p>
      <div v-if="detail" class="etr-detail-block">
        <pre class="etr-detail">{{ detail }}</pre>
        <button type="button" class="etr-action etr-copy" @click="copyDetail">
          <Icon :name="copied ? 'check' : 'copy'" size="sm" />{{ t('common.copy') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.etr { overflow: auto; max-height: min(260px, 42vh); padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); background: var(--color-surface); color: var(--color-text); font-size: var(--text-xs); line-height: var(--leading-normal); }
.etr-line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.etr-line--running { align-items: center; }
.etr-marker { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: calc(var(--text-xs) * var(--leading-normal)); color: var(--color-text-faint); }
.etr-label { flex: none; }
.etr-endpoint { overflow: hidden; min-width: 0; color: var(--color-text-faint); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.etr-failure { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-1); width: 100%; min-width: 0; }
.etr-reason { color: var(--color-danger); font-weight: var(--weight-medium); }
.etr-solution { margin: 0; min-width: 0; }
.etr-hint { color: var(--color-text-muted); }
.etr-action { display: inline-flex; align-items: center; align-self: flex-start; gap: var(--space-1); padding: 0; border: none; background: none; color: var(--color-text-faint); font: inherit; cursor: pointer; }
.etr-action:hover { color: var(--color-text); }
.etr-command { display: inline; color: var(--color-text-muted); vertical-align: baseline; white-space: nowrap; text-decoration: underline; text-underline-offset: 3px; }
.etr-hint + .etr-command { margin-inline-start: var(--space-2); }
.etr-action:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: var(--p-focus-ring); }
.etr-detail-block { display: flex; box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; max-height: min(160px, 30vh); align-items: flex-start; gap: var(--space-3); padding: var(--space-2) var(--space-3); overflow: auto; border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text-muted); }
.etr-detail { flex: 1 1 0; width: 0; min-width: 0; margin: 0; font-family: var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.etr-copy { flex: none; }
</style>
