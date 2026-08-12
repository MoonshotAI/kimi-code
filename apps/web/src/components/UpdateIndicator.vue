<!-- apps/web/src/components/UpdateIndicator.vue -->
<!-- Auto-update entry: a yellow pill in the sidebar header (on macOS desktop
     that header IS the traffic-light drag strip, so the wrapper opts out of
     app-region drag). Clicking opens the canonical §03 Dialog (Anatomy A,
     padded · lg · auto — see §09 in DesignSystemView.vue) with the version,
     release date, the state-dependent actions (download / background /
     restart / retry) and an auto-download checkbox on its own foot row below
     the buttons — it is a pure preference for FUTURE checks
     (never starts the waiting download, never closes the dialog), plus
     "本次跳过" to mute a version persistently. When the
     main process fetched the version's changelog (CDN changelog.{zh,en}.md),
     a "更新内容 / What's new" section renders it under the meta line — the
     current locale's text, falling back to the other language, hidden when
     neither exists (older versions simply have no notes).
     Renders only when the main process reports an update state the user has
     not skipped; with no desktop bridge (plain web) useUpdateStatus stays
     idle and nothing renders, so this file is safe to sync to apps/web. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Checkbox, Dialog, Icon } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { IconName } from '@moonshot-ai/app-client/icons';
import { useUpdateStatus } from '@moonshot-ai/app-client/composables';

const { t, locale } = useI18n();
const { status, visible, skipVersion, download, install, autoDownload, setAutoDownload, canToggleAutoDownload } =
  useUpdateStatus();

const open = ref(false);

// The running app's own version, for the "current → new" meta line.
const currentVersion =
  typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim()
    ? __KIMI_CLIENT_VERSION__
    : '';

const pillText = computed(() => {
  switch (status.value.state) {
    case 'available':
      return t('sidebar.update');
    case 'downloading':
      // Compact + locale-neutral: a bare percent keeps the pill's width from
      // shifting on every tick (the full "下载中… 42%" lives in the dialog).
      return `${status.value.percent ?? 0}%`;
    case 'downloaded':
      return t('sidebar.updateDone');
    case 'error':
      return t('sidebar.updateFailed');
    default:
      return '';
  }
});

const dialogTitle = computed(() => {
  switch (status.value.state) {
    case 'available':
      return t('sidebar.updateAvailable', { version: status.value.version ?? '' });
    case 'downloading':
      return t('sidebar.updateDownloading', { percent: status.value.percent ?? 0 });
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

// §09 quiet meta line: dot-separated facts (release date · current version).
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

// Bilingual changelog (main-side fetch, best-effort): the current locale's
// text, falling back to the other language; empty hides the section.
const changelogText = computed(() => {
  const notes = status.value.releaseNotes;
  if (notes === undefined) {
    return '';
  }
  const primary = locale.value.toLowerCase().startsWith('zh') ? notes.zh : notes.en;
  return (primary ?? notes.zh ?? notes.en ?? '').trim();
});

const icon = computed<IconName>(() => {
  switch (status.value.state) {
    case 'error':
      return 'alert-triangle';
    default:
      return 'download';
  }
});

function onDownload(): void {
  // The dialog stays open and flips to the live progress view.
  download();
}

function onSkip(): void {
  skipVersion();
  open.value = false;
}

function onRestartNow(): void {
  install();
  open.value = false;
}
</script>

<template>
  <span v-if="visible" class="upd" :data-state="status.state">
    <button class="upd-pill" type="button" :aria-label="pillText" @click="open = true">
      <Icon class="upd-pill-icon" :name="icon" size="sm" />
      <span class="upd-pill-text">{{ pillText }}</span>
    </button>

    <Dialog :open="open" :title="dialogTitle" size="lg" @update:open="open = $event">
      <p v-if="(status.state === 'available' || status.state === 'downloaded') && metaText" class="upd-meta">
        {{ metaText }}
      </p>
      <section v-if="changelogText" class="upd-notes">
        <h4 class="upd-notes-title">{{ t('sidebar.updateWhatsNew') }}</h4>
        <Markdown :text="changelogText" />
      </section>
      <div v-if="status.state === 'downloading'" class="upd-progress">
        <div class="upd-progress-fill" :style="{ width: `${percent}%` }" />
      </div>
      <p v-if="status.state === 'error' && status.message" class="upd-message">{{ status.message }}</p>

      <template #foot>
        <div class="upd-foot">
          <div class="upd-foot-actions">
            <template v-if="status.state === 'available'">
              <Button variant="ghost" @click="onSkip">{{ t('sidebar.updateSkip') }}</Button>
              <Button @click="onDownload">{{ t('sidebar.updateDownloadNow') }}</Button>
            </template>
            <template v-else-if="status.state === 'downloading'">
              <!-- The download continues on its own; this just dismisses the dialog
                   (the pill keeps showing live percent). -->
              <Button variant="secondary" @click="open = false">{{ t('sidebar.updateBackground') }}</Button>
            </template>
            <template v-else-if="status.state === 'downloaded'">
              <Button variant="ghost" @click="open = false">{{ t('sidebar.updateRestartLater') }}</Button>
              <Button @click="onRestartNow">{{ t('sidebar.updateRestartNow') }}</Button>
            </template>
            <template v-else-if="status.state === 'error'">
              <Button variant="danger-soft" @click="onDownload">{{ t('sidebar.updateRetry') }}</Button>
            </template>
          </div>
          <Checkbox
            v-if="canToggleAutoDownload"
            class="upd-auto"
            :model-value="autoDownload"
            @update:model-value="setAutoDownload($event, 'update_prompt')"
          >
            {{ t('sidebar.updateAutoDownload') }}
          </Checkbox>
        </div>
      </template>
    </Dialog>
  </span>
</template>

<style scoped>
.upd {
  display: inline-flex;
  flex: none;
  /* The macOS-desktop sidebar header is a window-drag strip — the pill must
     stay clickable. */
  -webkit-app-region: no-drag;
  animation: upd-in var(--duration-base) var(--ease-out);
}
@keyframes upd-in {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
}

.upd-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-warning);
  color: var(--color-text-on-accent);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  white-space: nowrap;
  cursor: pointer;
  transition: filter var(--duration-fast) var(--ease-out);
}
.upd-pill:hover {
  filter: brightness(1.1);
}
.upd-pill:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.upd-pill-icon {
  flex: none;
  color: var(--color-text-on-accent);
}
/* Downloading: bare percent in tabular figures on a fixed 4ch field, so the
   pill never resizes mid-stream (no header jitter). */
.upd[data-state='downloading'] .upd-pill-text {
  display: inline-block;
  min-width: 4ch;
  text-align: left;
  font-variant-numeric: tabular-nums;
}

/* Narrow header = icons only: below 250px the pill degrades to a plain icon
   dot (matches the brand-name drop-out at the same breakpoint — see the
   `@container sidebar-col` rules in Sidebar.vue). */
@container sidebar-col (max-width: 250px) {
  .upd-pill {
    padding: var(--space-1);
  }
  .upd-pill-text {
    display: none;
  }
}

/* §09 meta line: quiet facts under the dialog title. */
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

/* Changelog block under the meta line: quiet title + compact rendered list,
   height-capped so long notes scroll inside the block instead of stretching
   the dialog toward full-screen. */
.upd-notes {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
  max-height: min(360px, 45vh);
  overflow-y: auto;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text);
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
/* Section headings (### 新功能 / ### Features …) inside the rendered
   changelog: same size as the body, told apart by weight, tight spacing. */
.upd-notes :deep(h3) {
  margin: var(--space-3) 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.upd-notes :deep(h3:first-child) {
  margin-top: 0;
}
/* When the meta line is hidden (downloading / error states) the notes block
   is the body's first child — the dialog's own padding already separates it
   from the title. */
.upd-notes:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}

/* The foot stacks two fixed rows (never scrolls with the body): the
   auto-download checkbox gets its own right-aligned line below the action
   buttons — one shared row is too narrow for it, especially with the zh
   label. */
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

.upd-progress {
  margin-top: var(--space-3);
  height: var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-line);
  overflow: hidden;
}
.upd-progress-fill {
  height: 100%;
  border-radius: var(--radius-xs);
  background: var(--color-accent);
  transition: width var(--duration-base) var(--ease-out);
}
</style>
