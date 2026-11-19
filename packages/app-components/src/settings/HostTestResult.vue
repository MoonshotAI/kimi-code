<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Icon, Spinner } from '@moonshot-ai/app-ui';

const props = defineProps<{
  state: 'running' | 'failed';
  endpoint: string;
  kimiFailed?: boolean;
  reason?: string;
  hint?: string;
  detail?: string;
}>();

const { t } = useI18n();
const copied = ref(false);
let copiedTimer = 0;

const steps = computed(() => props.kimiFailed
  ? [{ stage: 'connect', state: 'passed' }, { stage: 'start_kimi', state: 'failed' }] as const
  : [{ stage: 'connect', state: 'failed' }, { stage: 'start_kimi', state: 'pending' }] as const);

async function copyDetail(): Promise<void> {
  if (!await copyTextToClipboard(props.detail ?? '')) return;
  copied.value = true;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}

onUnmounted(() => window.clearTimeout(copiedTimer));
</script>

<template>
  <div class="etr" role="status">
    <div v-if="state === 'running'" class="etr-line etr-line--running">
      <span class="etr-marker"><Spinner size="xs" /></span>
      <span class="etr-label">{{ t('settings.hosts.testing') }}</span>
      <span v-if="endpoint" class="etr-endpoint" :title="endpoint">{{ endpoint }}</span>
    </div>
    <ol v-else class="etr-steps" :aria-label="t('settings.hosts.testSteps.label')">
      <li v-for="step in steps" :key="step.stage" class="etr-step" :class="`etr-step--${step.state}`">
        <span class="etr-marker">
          <Icon v-if="step.state === 'passed'" name="check" size="sm" />
          <Icon v-else-if="step.state === 'failed'" name="close" size="sm" />
          <span v-else class="etr-dot" />
        </span>
        <div class="etr-body">
          <div class="etr-line">
            <span class="etr-label">{{ t(`settings.hosts.testSteps.${step.stage}`) }}</span>
            <span v-if="step.stage === 'connect' && endpoint" class="etr-endpoint" :title="endpoint">{{ endpoint }}</span>
          </div>
          <div v-if="step.state === 'failed'" class="etr-failure" role="alert">
            <span v-if="reason" class="etr-reason">{{ reason }}</span>
            <span v-if="hint" class="etr-hint">{{ hint }}</span>
            <div v-if="detail" class="etr-detail-block">
              <pre class="etr-detail">{{ detail }}</pre>
              <button type="button" class="etr-action etr-copy" @click="copyDetail">
                <Icon :name="copied ? 'check' : 'copy'" size="sm" />{{ t('common.copy') }}
              </button>
            </div>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.etr { overflow: auto; max-height: min(240px, 40vh); padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); background: var(--color-surface); color: var(--color-text); font-size: var(--text-xs); line-height: var(--leading-normal); }
.etr-line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.etr-line--running { align-items: center; }
.etr-marker { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: calc(var(--text-xs) * var(--leading-normal)); color: var(--color-text-faint); }
.etr-step--passed .etr-marker { color: var(--color-success); }
.etr-step--failed .etr-marker { color: var(--color-danger); }
.etr-label { flex: none; }
.etr-endpoint { overflow: hidden; min-width: 0; color: var(--color-text-faint); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.etr-steps { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.etr-step { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.etr-step--pending { color: var(--color-text-faint); }
.etr-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.etr-body { display: flex; flex: 1; flex-direction: column; gap: var(--space-1); min-width: 0; }
.etr-failure { display: flex; flex-direction: column; gap: var(--space-1); }
.etr-reason { color: var(--color-danger); }
.etr-hint { color: var(--color-text-muted); }
.etr-action { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0; border: none; background: none; color: var(--color-text-faint); font: inherit; cursor: pointer; }
.etr-action:hover { color: var(--color-text); }
.etr-action:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: var(--p-focus-ring); }
.etr-detail-block { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text-muted); }
.etr-detail { flex: 1; min-width: 0; margin: 0; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word; }
.etr-copy { flex: none; }
</style>
