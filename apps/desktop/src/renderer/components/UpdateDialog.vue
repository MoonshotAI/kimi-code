<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Checkbox, Dialog } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import { useUpdateStatus } from '@moonshot-ai/app-client/composables';
import { track } from '../lib/track';

const { t, locale } = useI18n();
const update = useUpdateStatus();

const status = update.status;
const open = update.dialogOpen;

const currentVersion =
  typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim()
    ? __KIMI_CLIENT_VERSION__
    : '';

const trackChannel = currentVersion.includes('-canary.') ? 'canary' : 'stable';

const dialogTitle = computed(() => {
  switch (status.value.state) {
    case 'available':
    case 'downloading':
      return t('sidebar.updateAvailable', { version: status.value.version ?? '' });
    case 'downloaded':
      return t('sidebar.updateReady', { version: status.value.version ?? '' });
    case 'error':
      return t('sidebar.updateFailed');
    default:
      return '';
  }
});

const releaseDateText = computed(() => {
  const raw = status.value.releaseDate;
  if (raw === undefined || raw === '') {
    return '';
  }
  const parsed = new Date(raw);
  const date = Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString();
  return t('sidebar.updateReleaseDate', { date });
});

const metaText = computed(() => {
  const parts: string[] = [];
  if (releaseDateText.value !== '') {
    parts.push(releaseDateText.value);
  }
  if (currentVersion !== '') {
    parts.push(t('sidebar.updateCurrentVersion', { version: currentVersion }));
  }
  return parts.join(' · ');
});

const percent = computed(() => status.value.percent ?? 0);

const changelogText = computed(() => {
  const notes = status.value.releaseNotes;
  if (notes === undefined) {
    return '';
  }
  const primary = locale.value.toLowerCase().startsWith('zh') ? notes.zh : notes.en;
  return (primary ?? notes.zh ?? notes.en ?? '').trim();
});

function versionProps(): { version?: string } {
  const version = status.value.version;
  return version === undefined ? {} : { version };
}

type UpdatePromptAction = 'skip' | 'download' | 'restart' | 'retry' | 'open-installer';

function trackAction(action: UpdatePromptAction, properties: { version?: string }): void {
  track('update_prompt_action', { ...properties, action, channel: trackChannel });
}

function onDownload(): void {
  trackAction(status.value.state === 'error' ? 'retry' : 'download', versionProps());
  update.download();
}

function onSkip(): void {
  trackAction('skip', versionProps());
  update.skipVersion();
  open.value = false;
}

function onRestartNow(): void {
  trackAction('restart', versionProps());
  void update.install().catch(() => {});
  open.value = false;
}
</script>

<template>
  <Dialog :open="open" :title="dialogTitle" size="lg" @update:open="open = $event">
    <p v-if="status.state !== 'error' && metaText" class="upd-meta">
      {{ metaText }}
    </p>
    <section v-if="changelogText" class="upd-notes">
      <h4 class="upd-notes-title">{{ t('sidebar.updateWhatsNew') }}</h4>
      <Markdown :text="changelogText" />
    </section>
    <p v-if="status.state === 'error' && status.message" class="upd-message">{{ status.message }}</p>

    <template #foot>
      <div class="upd-foot">
        <div class="upd-foot-actions">
          <template v-if="status.state === 'available'">
            <Button variant="ghost" @click="onSkip">{{ t('sidebar.updateSkip') }}</Button>
            <Button @click="onDownload">{{ t('sidebar.updateDownloadNow') }}</Button>
          </template>
          <template v-else-if="status.state === 'downloading'">
            <Button variant="secondary" @click="open = false">{{ t('sidebar.updateBackground') }}</Button>
            <Button disabled>{{ t('sidebar.updateDownloadingButton', { percent }) }}</Button>
          </template>
          <template v-else-if="status.state === 'downloaded'">
            <Button variant="ghost" @click="open = false">{{ t('sidebar.updateRestartLater') }}</Button>
            <Button @click="onRestartNow">{{ t('sidebar.updateRestartNow') }}</Button>
          </template>
          <template v-else-if="status.state === 'error'">
            <Button variant="danger" @click="onDownload">{{ t('sidebar.updateRetry') }}</Button>
          </template>
        </div>
        <Checkbox
          v-if="update.canToggleAutoDownload"
          class="upd-auto"
          :model-value="update.autoDownload.value"
          @update:model-value="update.setAutoDownload($event, 'update_prompt')"
        >
          {{ t('sidebar.updateAutoDownload') }}
        </Checkbox>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.upd-meta {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-faint);
}
.upd-message {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  word-break: break-all;
}

.upd-notes {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
  max-height: min(360px, 45vh);
  overflow-y: auto;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text);
  --markdown-font-family: var(--font-ui);
  --markdown-body-line-height: var(--leading-normal);
  --markdown-block-space-before: var(--space-1);
  --markdown-heading-space-before: var(--space-3);
  --markdown-list-item-gap: var(--space-1);
}
.upd-notes-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
}
.upd-notes :deep(ul),
.upd-notes :deep(p) {
  margin: 0;
}
.upd-notes :deep(li + li) {
  margin-top: var(--space-1);
}
.upd-notes :deep(h3) {
  margin: 0 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.upd-notes .md :deep(.markdown-renderer > .node-slot:first-child) {
  padding-top: 0;
}
.upd-notes:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}

.upd-foot {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
  width: 100%;
}
.upd-foot-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.upd-auto {
  align-self: flex-end;
}
</style>
