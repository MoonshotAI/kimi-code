<!-- Auto-update entry: a yellow pill in the Windows titlebar or the sidebar
     header on other desktop surfaces. Both may be window-drag strips, so the
     wrapper opts out of app-region drag. Clicking opens the canonical §03 Dialog (Anatomy A,
     padded · lg · auto — see §09 in DesignSystemView.vue) with the version,
     release date, the state-dependent actions (download / background +
     disabled live-percent button / restart / retry) and an auto-download
     checkbox on its own foot row below
     the buttons — it is a pure preference for FUTURE checks
     (never starts the waiting download, never closes the dialog), plus
     "本次跳过" to mute a version persistently. When the
     main process fetched the version's changelog (CDN changelog.{zh,en}.md),
     a "更新内容 / What's new" section renders it under the meta line — the
     current locale's text, falling back to the other language, hidden when
     neither exists (older versions simply have no notes).

     Canary mode (Kimi Code Canary 内测版, canary.ts / useCanaryChannel): the
     same pill + dialog skeleton is driven by the gh-based canary channel
     instead of electron-updater — the stable updater is disabled on canary
     builds, so the two sources never conflict. Canary actions differ:
     download pulls the dmg and mounts it (install stays manual: drag into
     Applications), there is no auto-download checkbox and no restart action;
     `downloaded` offers「打开安装包」to re-mount the dmg. The two modes are
     mutually exclusive by construction (canary.enabled only on canary/dev).

     Renders only when the active source reports a state the user has not
     skipped; with no desktop bridge (plain web) both trackers stay idle and
     nothing renders. Telemetry goes through lib/track.ts (a bridge-probed
     no-op without the preload bridge) — sync that file along with this one
     (docs/native-todos.md). -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Checkbox, Dialog, Icon } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { IconName } from '@moonshot-ai/app-client/icons';
import { useUpdateStatus, useCanaryChannel } from '@moonshot-ai/app-client/composables';
import { track } from '../lib/track';

const { t, locale } = useI18n();
const update = useUpdateStatus();
const canary = useCanaryChannel();

// Canary builds disable the stable updater (main-side), so an enabled canary
// tracker is the single source there; stable builds never see canary enabled.
const canaryMode = computed(() => canary.enabled.value);
const status = computed(() => (canaryMode.value ? canary.status.value : update.status.value));
const visible = computed(() => (canaryMode.value ? canary.visible.value : update.visible.value));

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
      if (canaryMode.value) {
        return t('sidebar.canaryDownloading');
      }
      // Compact + locale-neutral: a bare percent keeps the pill's width from
      // shifting on every tick (the full "下载中… 42%" lives in the dialog).
      return `${update.status.value.percent ?? 0}%`;
    case 'downloaded':
      return canaryMode.value ? t('sidebar.canaryDownloaded') : t('sidebar.updateDone');
    case 'error':
      return t('sidebar.updateFailed');
    default:
      return '';
  }
});

const dialogTitle = computed(() => {
  switch (status.value.state) {
    // Downloading keeps the "new version" title — the live percent lives on
    // the disabled foot button instead (no title churn, no progress bar).
    case 'available':
    case 'downloading':
      return canaryMode.value
        ? t('sidebar.canaryAvailable', { version: status.value.version ?? '' })
        : t('sidebar.updateAvailable', { version: status.value.version ?? '' });
    case 'downloaded':
      return canaryMode.value
        ? t('sidebar.canaryReady', { version: status.value.version ?? '' })
        : t('sidebar.updateReady', { version: status.value.version ?? '' });
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

const percent = computed(() => (canaryMode.value ? 0 : (update.status.value.percent ?? 0)));

// Bilingual changelog (main-side fetch, best-effort; stable updates only —
// canary prereleases carry no notes): the current locale's text, falling back
// to the other language; empty hides the section.
const changelogText = computed(() => {
  const notes = canaryMode.value ? undefined : update.status.value.releaseNotes;
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

// The whitelist's version field is optional — omit it when the status has none.
function versionProps(): { version?: string } {
  const version = status.value.version;
  return version === undefined ? {} : { version };
}

// One funnel for both channels: the event stays update_prompt_*, the source
// is told apart by the `channel` property (track-events.ts).
type UpdatePromptAction = 'skip' | 'download' | 'restart' | 'retry' | 'open-installer';

function trackShown(properties: { version?: string }): void {
  track('update_prompt_shown', { ...properties, channel: canaryMode.value ? 'canary' : 'stable' });
}

function trackAction(action: UpdatePromptAction, properties: { version?: string }): void {
  track('update_prompt_action', { ...properties, action, channel: canaryMode.value ? 'canary' : 'stable' });
}

// Shown = pill exposure: the update funnel's reach rate counts devices that
// saw the pill, not only those who opened the dialog. Once per version.
const shownForVersions = new Set<string>();
watch(visible, (isVisible) => {
  if (!isVisible) return;
  const key = status.value.version ?? status.value.state;
  if (shownForVersions.has(key)) return;
  shownForVersions.add(key);
  trackShown(versionProps());
});

function onDownload(): void {
  // The error state's retry button shares this entry with the download.
  trackAction(status.value.state === 'error' ? 'retry' : 'download', versionProps());
  // The dialog stays open and flips to the live progress view.
  if (canaryMode.value) {
    canary.download();
  } else {
    update.download();
  }
}

function onSkip(): void {
  trackAction('skip', versionProps());
  if (canaryMode.value) {
    canary.skipVersion();
  } else {
    update.skipVersion();
  }
  open.value = false;
}

function onRestartNow(): void {
  trackAction('restart', versionProps());
  update.install();
  open.value = false;
}

function onOpenInstaller(): void {
  trackAction('open-installer', versionProps());
  canary.openDownload();
}
</script>

<template>
  <span v-if="visible" class="upd" :data-state="status.state">
    <button class="upd-pill" type="button" :aria-label="pillText" @click="open = true">
      <Icon class="upd-pill-icon" :name="icon" size="sm" />
      <span class="upd-pill-text">{{ pillText }}</span>
    </button>

    <Dialog :open="open" :title="dialogTitle" size="lg" @update:open="open = $event">
      <!-- The quiet meta line (release date · current version) stays up while
           downloading too — the title no longer flips, so the facts under it
           shouldn't collapse mid-flow either; only the error state hides it. -->
      <p v-if="status.state !== 'error' && metaText" class="upd-meta">
        {{ metaText }}
      </p>
      <section v-if="changelogText" class="upd-notes">
        <h4 class="upd-notes-title">{{ t('sidebar.updateWhatsNew') }}</h4>
        <Markdown :text="changelogText" />
      </section>
      <p v-if="status.state === 'downloaded' && canaryMode" class="upd-message">{{ t('sidebar.canaryDownloadedHint') }}</p>
      <p v-if="status.state === 'error' && status.message" class="upd-message">{{ status.message }}</p>

      <template #foot>
        <div class="upd-foot">
          <div class="upd-foot-actions">
            <!-- Canary actions: download → mount → manual drag-install. -->
            <template v-if="canaryMode">
              <template v-if="status.state === 'available'">
                <Button variant="ghost" @click="onSkip">{{ t('sidebar.updateSkip') }}</Button>
                <Button @click="onDownload">{{ t('sidebar.canaryDownload') }}</Button>
              </template>
              <template v-else-if="status.state === 'downloading'">
                <Button variant="secondary" @click="open = false">{{ t('sidebar.updateBackground') }}</Button>
                <Button disabled>{{ t('sidebar.canaryDownloading') }}</Button>
              </template>
              <template v-else-if="status.state === 'downloaded'">
                <Button variant="ghost" @click="open = false">{{ t('sidebar.canaryClose') }}</Button>
                <Button @click="onOpenInstaller">{{ t('sidebar.canaryOpenInstaller') }}</Button>
              </template>
              <template v-else-if="status.state === 'error'">
                <Button variant="danger-soft" @click="onDownload">{{ t('sidebar.updateRetry') }}</Button>
              </template>
            </template>
            <!-- Stable (electron-updater) actions. -->
            <template v-else>
              <template v-if="status.state === 'available'">
                <Button variant="ghost" @click="onSkip">{{ t('sidebar.updateSkip') }}</Button>
                <Button @click="onDownload">{{ t('sidebar.updateDownloadNow') }}</Button>
              </template>
              <template v-else-if="status.state === 'downloading'">
                <!-- The download continues on its own: "background" just dismisses
                     the dialog (the pill keeps showing live percent); the disabled
                     button carries the live percent in place of a progress bar. -->
                <Button variant="secondary" @click="open = false">{{ t('sidebar.updateBackground') }}</Button>
                <Button disabled>{{ t('sidebar.updateDownloadingButton', { percent }) }}</Button>
              </template>
              <template v-else-if="status.state === 'downloaded'">
                <Button variant="ghost" @click="open = false">{{ t('sidebar.updateRestartLater') }}</Button>
                <Button @click="onRestartNow">{{ t('sidebar.updateRestartNow') }}</Button>
              </template>
              <template v-else-if="status.state === 'error'">
                <Button variant="danger-soft" @click="onDownload">{{ t('sidebar.updateRetry') }}</Button>
              </template>
            </template>
          </div>
          <Checkbox
            v-if="!canaryMode && update.canToggleAutoDownload"
            class="upd-auto"
            :model-value="update.autoDownload.value"
            @update:model-value="update.setAutoDownload($event, 'update_prompt')"
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
  /* The parent chrome may be a window-drag strip — the pill must stay clickable. */
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
/* When the meta line is hidden (error state, or no facts to show) the notes
   block is the body's first child — the dialog's own padding already
   separates it from the title. */
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
</style>
