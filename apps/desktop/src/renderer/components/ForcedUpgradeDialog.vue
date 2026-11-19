<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import { useUpdateStatus } from '@moonshot-ai/app-client/composables';
import { createForcedUpgradeController } from '../lib/forcedUpgrade';
import { getKimiWebApi } from '../api';

const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const { t, locale } = useI18n();
const update = useUpdateStatus();
const currentVersion = typeof __KIMI_CLIENT_VERSION__ === 'string' ? __KIMI_CLIENT_VERSION__ : '';
const controller = createForcedUpgradeController({
  currentVersion,
  supported: !import.meta.env.DEV && currentVersion !== '' && !currentVersion.includes('-preview.') && update.canCheck,
  status: update.status,
  fetchPolicy: () => getKimiWebApi().getClientConfig('client_upgrade_policy', { background: false }),
  check: update.check,
  download: update.download,
  install: update.install,
});

const {
  phase,
  visible,
  minimumVersion,
  targetVersion,
  remainingSeconds,
  errorMessage,
  start,
  skip,
  upgrade,
  retry,
  restart,
  dispose,
} = controller;

const title = computed(() => phase.value === 'prompt'
  ? t('sidebar.forcedUpgradeTitle')
  : t('sidebar.forcedUpgradeProgressTitle'));
const percent = computed(() => update.status.value.percent ?? 0);
const changelogText = computed(() => {
  const notes = update.status.value.releaseNotes;
  if (notes === undefined) return '';
  const primary = locale.value.toLowerCase().startsWith('zh') ? notes.zh : notes.en;
  return (primary ?? notes.zh ?? notes.en ?? '').trim();
});
const errorText = computed(() => {
  if (errorMessage.value === 'target_below_minimum') return t('sidebar.forcedUpgradeTargetUnavailable');
  return errorMessage.value || t('sidebar.forcedUpgradeFailed');
});
const skipText = computed(() => remainingSeconds.value > 0
  ? t('sidebar.forcedUpgradeSkipIn', { seconds: remainingSeconds.value })
  : t('sidebar.updateSkip'));

watch(visible, (value) => emit('update:visible', value), { immediate: true });
onMounted(() => { void start(); });
onUnmounted(dispose);
</script>

<template>
  <Dialog
    :open="visible"
    :title="title"
    :close-on-overlay="false"
    :close-on-esc="false"
    hide-close
    :size="phase === 'prompt' ? 'md' : 'lg'"
    @update:open="() => {}"
  >
    <div class="forced-upgrade" @keydown.stop>
      <template v-if="phase === 'prompt'">
        <p class="forced-upgrade__body">{{ t('sidebar.forcedUpgradeBody', { version: minimumVersion }) }}</p>
        <p class="forced-upgrade__meta">{{ t('sidebar.updateCurrentVersion', { version: currentVersion }) }}</p>
      </template>
      <p v-else-if="phase === 'checking'" class="forced-upgrade__body">{{ t('sidebar.forcedUpgradeChecking') }}</p>
      <p v-else-if="phase === 'downloading'" class="forced-upgrade__body">{{ t('sidebar.forcedUpgradeDownloading', { version: targetVersion ?? '' }) }}</p>
      <p v-else-if="phase === 'downloaded'" class="forced-upgrade__body">{{ t('sidebar.forcedUpgradeReady', { version: targetVersion ?? '' }) }}</p>
      <p v-else-if="phase === 'installing'" class="forced-upgrade__body">{{ t('sidebar.forcedUpgradeInstalling') }}</p>
      <p v-else-if="phase === 'error'" class="forced-upgrade__error" role="alert">{{ errorText }}</p>
      <section v-if="phase !== 'prompt' && changelogText" class="forced-upgrade__notes">
        <h4 class="forced-upgrade__notes-title">{{ t('sidebar.updateWhatsNew') }}</h4>
        <Markdown :text="changelogText" />
      </section>
    </div>
    <template #foot>
      <template v-if="phase === 'prompt' || phase === 'error'">
        <Button variant="secondary" :disabled="remainingSeconds > 0" @click="skip">{{ skipText }}</Button>
        <Button v-if="phase === 'prompt'" variant="primary" @click="upgrade">{{ t('sidebar.updateDownloadNow') }}</Button>
        <Button v-else variant="primary" @click="retry">{{ t('sidebar.updateRetry') }}</Button>
      </template>
      <Button v-else-if="phase === 'downloaded'" variant="primary" @click="restart">{{ t('sidebar.updateRestartNow') }}</Button>
      <Button v-else variant="primary" disabled>{{ phase === 'checking' ? t('sidebar.forcedUpgradeChecking') : phase === 'downloading' ? `${percent}%` : t('sidebar.forcedUpgradeInstalling') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.forced-upgrade {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.forced-upgrade__body,
.forced-upgrade__meta,
.forced-upgrade__error {
  margin: 0;
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.forced-upgrade__body { color: var(--color-text); }
.forced-upgrade__meta { color: var(--color-text-muted); font-size: var(--text-sm); }
.forced-upgrade__error { color: var(--color-danger); }
.forced-upgrade__notes {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--p-hairline) solid var(--color-line);
  max-height: min(360px, 45vh);
  overflow-y: auto;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  --markdown-font-family: var(--font-ui);
  --markdown-font-size: var(--text-sm);
  --markdown-line-height: var(--leading-normal);
  --markdown-block-space-before: var(--space-2);
  --markdown-block-space-after: var(--space-2);
  --markdown-heading-level-1-size: var(--text-lg);
  --markdown-heading-level-2-size: var(--text-base);
  --markdown-heading-level-3-size: var(--text-sm);
  --markdown-list-item-gap: var(--space-1);
}
.forced-upgrade__notes-title {
  margin: 0 0 var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.forced-upgrade__notes :deep(ul),
.forced-upgrade__notes :deep(p) { margin: 0; }
.forced-upgrade__notes :deep(li + li) { margin-top: var(--space-1); }
.forced-upgrade__notes :deep(h3) { font-size: var(--text-sm); }
</style>
