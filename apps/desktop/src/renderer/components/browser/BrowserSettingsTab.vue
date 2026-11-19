<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Button, Favicon, Icon, IconButton, Input, ProgressBar, SegmentedControl, Select, Switch } from '@moonshot-ai/app-ui';
import { BROWSER_AGENT_DOWNLOAD_LIMITS, BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT } from '../../../shared/browser-data';
import { formatDownloadBytes as formatBytes } from '../../../shared/browser-download-status';
import type {
  BrowserDataSnapshot,
  BrowserDownloadControl,
  BrowserDownloadItem,
  BrowserSettingsSection,
} from '../../../shared/browser-data';
import { BROWSER_SEARCH_ENGINES, isBrowserSearchEngine } from '../../../shared/browser-search';
import { isBrowserAutoplay } from '../../../shared/browser-autoplay';
import { isBrowserSound } from '../../../shared/browser-sound';
import BrowserSitesPanel from './BrowserSitesPanel.vue';
import BrowserUserAgentSettings from './BrowserUserAgentSettings.vue';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import { track } from '../../lib/track';
import {
  canCancelDownload,
  canCopyDownloadLink,
  canOpenDownload,
  canPauseDownload,
  canRemoveDownload,
  canResumeDownload,
  canRetryDownload,
  downloadProgress,
  downloadStatus as formatDownloadStatus,
  formatDownloadTime,
  isDeletedDownload,
  isPausedDownload,
  setBrowserDownloadsWatch,
} from '../../lib/browserDownloads';

const props = withDefaults(defineProps<{ initialSection?: BrowserSettingsSection }>(), {
  initialSection: 'settings',
});
const emit = defineEmits<{ openUrl: [url: string] }>();
const { t, locale } = useI18n();
const bridge = getNativeBrowserBridge();
const snapshot = ref<BrowserDataSnapshot | null>(null);
const downloads = ref<BrowserDownloadItem[]>([]);
let downloadsRevision = 0;
const loading = ref(false);
const historyQuery = ref('');
const downloadQuery = ref('');
const failedFavicons = ref(new Set<string>());

function onFaviconError(favicon?: string): void {
  if (favicon !== undefined) failedFavicons.value.add(favicon);
}
const activeSection = ref<BrowserSettingsSection>(props.initialSection);
const downloadsWatchOwner = Symbol('browser-settings-downloads');

const sectionOptions = computed(() => [
  { value: 'settings', label: t('browser.settings.title'), icon: 'settings' },
  { value: 'downloads', label: t('browser.downloads.title'), icon: 'download' },
  { value: 'history', label: t('browser.history.title'), icon: 'list' },
  { value: 'sites', label: t('browser.sites.title'), icon: 'globe' },
]);

const searchOptions = Object.entries(BROWSER_SEARCH_ENGINES).map(([value, provider]) => ({ value, label: provider.name }));
const autoplayOptions = computed(() => [
  { value: 'block', label: t('browser.settings.autoplayBlock') },
  { value: 'allow', label: t('browser.settings.autoplayAllow') },
]);

async function setAutoplay(value: string): Promise<void> {
  if (bridge !== null && isBrowserAutoplay(value)) snapshot.value = await bridge.browserUpdatePreferences({ autoplay: value });
}

const soundOptions = computed(() => [
  { value: 'muted', label: t('browser.settings.soundMuted') },
  { value: 'on', label: t('browser.settings.soundOn') },
]);

async function setSound(value: string): Promise<void> {
  if (bridge !== null && isBrowserSound(value)) snapshot.value = await bridge.browserUpdatePreferences({ sound: value });
}

async function setSearchEngine(value: string): Promise<void> {
  if (bridge === null || !isBrowserSearchEngine(value)) return;
  snapshot.value = await bridge.browserUpdatePreferences({ searchEngine: value });
  track('settings_changed', { key: 'browser-search-engine', value, source_panel: 'settings' });
}

const ZOOM_TRACK_VALUES = new Map<number, '75' | '90' | '100' | '110' | '125' | '150'>([
  [0.75, '75'],
  [0.9, '90'],
  [1, '100'],
  [1.1, '110'],
  [1.25, '125'],
  [1.5, '150'],
]);

const zoomOptions = [...ZOOM_TRACK_VALUES.keys()].map((value) => ({
  value: String(value),
  label: `${Math.round(value * 100)}%`,
}));

async function refresh(): Promise<void> {
  if (bridge === null) return;
  loading.value = true;
  failedFavicons.value.clear();
  try {
    await Promise.all([
      bridge.browserGetData().then((next) => { snapshot.value = next; }),
      activeSection.value === 'downloads' ? refreshDownloads() : undefined,
    ]);
  } finally {
    loading.value = false;
  }
}

async function refreshDownloads(): Promise<void> {
  if (bridge === null) return;
  const revision = downloadsRevision;
  const next = await bridge.browserGetDownloads();
  if (revision === downloadsRevision) downloads.value = next;
}

function setSection(value: string): void {
  if (value === 'settings' || value === 'downloads' || value === 'history' || value === 'sites') {
    activeSection.value = value;
  }
}

async function setAgentControl(value: boolean): Promise<void> {
  if (bridge === null) return;
  snapshot.value = await bridge.browserUpdatePreferences({ agentControl: value });
  track('settings_changed', { key: 'browser-agent-control', value: value ? 'on' : 'off', source_panel: 'settings' });
}

async function setSubagentControl(value: boolean): Promise<void> {
  if (bridge === null) return;
  snapshot.value = await bridge.browserUpdatePreferences({ subagentControl: value });
  track('settings_changed', { key: 'browser-subagent-control', value: value ? 'on' : 'off', source_panel: 'settings' });
}

async function setAgentLocalFiles(value: boolean): Promise<void> {
  if (bridge !== null) snapshot.value = await bridge.browserUpdatePreferences({ agentLocalFiles: value });
}

async function setAskWhereToSave(value: boolean): Promise<void> {
  if (bridge === null) return;
  snapshot.value = await bridge.browserUpdatePreferences({ askWhereToSave: value });
  track('settings_changed', { key: 'browser-ask-where-to-save', value: value ? 'on' : 'off', source_panel: 'settings' });
}

const AGENT_LIMIT_TRACK_VALUES = new Map<number, '100mb' | '500mb' | '1gb' | '5gb'>([
  [100 * 1_024 ** 2, '100mb'],
  [500 * 1_024 ** 2, '500mb'],
  [1_024 ** 3, '1gb'],
  [5 * 1_024 ** 3, '5gb'],
]);
const agentLimitOptions = computed(() => [
  ...BROWSER_AGENT_DOWNLOAD_LIMITS.map(value => ({ value: String(value), label: formatBytes(value) })),
  { value: 'unlimited', label: t('browser.settings.agentDownloadUnlimited') },
]);
const agentLimitValue = computed(() => {
  const limit = snapshot.value?.preferences.agentDownloadLimitBytes;
  return limit === null ? 'unlimited' : String(limit ?? BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT);
});
const agentDownloads = computed(() => snapshot.value?.agentDownloads);
const checkingAccess = ref(false);

async function setAgentDownloadLimit(value: string): Promise<void> {
  if (bridge === null) return;
  const limit = value === 'unlimited' ? null : Number(value);
  if (limit !== null && !Number.isSafeInteger(limit)) return;
  snapshot.value = await bridge.browserUpdatePreferences({ agentDownloadLimitBytes: limit });
  const tracked = limit === null ? 'unlimited' : AGENT_LIMIT_TRACK_VALUES.get(limit);
  if (tracked !== undefined) track('settings_changed', { key: 'browser-agent-download-limit', value: tracked, source_panel: 'settings' });
}

async function chooseAgentDownloadDirectory(): Promise<void> {
  if (!bridge?.browserChooseAgentDownloadDirectory) return;
  const wasCustom = snapshot.value?.agentDownloads?.custom === true;
  const previousPath = snapshot.value?.agentDownloads?.path;
  snapshot.value = await bridge.browserChooseAgentDownloadDirectory();
  const next = snapshot.value.agentDownloads;
  if (next?.custom === true && (!wasCustom || next.path !== previousPath)) {
    track('settings_changed', { key: 'browser-agent-download-location', value: 'custom', source_panel: 'settings' });
  }
}

async function resetAgentDownloadDirectory(): Promise<void> {
  if (bridge === null) return;
  snapshot.value = await bridge.browserUpdatePreferences({ agentDownloadDirectory: null });
  track('settings_changed', { key: 'browser-agent-download-location', value: 'default', source_panel: 'settings' });
}

async function checkDownloadsAccess(): Promise<void> {
  if (!bridge?.browserCheckDownloadsAccess || checkingAccess.value) return;
  checkingAccess.value = true;
  try {
    snapshot.value = await bridge.browserCheckDownloadsAccess();
  } finally {
    checkingAccess.value = false;
  }
}

async function setDefaultZoom(value: string): Promise<void> {
  if (bridge === null) return;
  const defaultZoomFactor = Number(value);
  if (Number.isFinite(defaultZoomFactor)) {
    snapshot.value = await bridge.browserUpdatePreferences({ defaultZoomFactor });
    const tracked = ZOOM_TRACK_VALUES.get(defaultZoomFactor);
    if (tracked !== undefined) track('settings_changed', { key: 'browser-default-zoom', value: tracked, source_panel: 'settings' });
  }
}

async function clearHistory(): Promise<void> {
  if (bridge !== null) snapshot.value = await bridge.browserClearHistory();
}

async function clearDownloads(): Promise<void> {
  if (bridge === null) return;
  snapshot.value = await bridge.browserClearDownloads();
  await refreshDownloads();
}

async function openDownload(entry: BrowserDownloadItem, action: 'open' | 'show'): Promise<void> {
  if (bridge === null) return;
  const opened = await bridge.browserOpenDownload(entry.id, action).catch(() => false);
  if (!opened) await refreshDownloads();
}

async function controlDownload(entry: BrowserDownloadItem, action: BrowserDownloadControl['action'] | 'retry'): Promise<void> {
  if (bridge === null) return;
  const done = await bridge.browserOpenDownload(entry.id, action).catch(() => false);
  if (!done) await refreshDownloads();
}

const copiedDownload = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copyDownloadLink(entry: BrowserDownloadItem): Promise<void> {
  if (!(await copyTextToClipboard(entry.url))) return;
  copiedDownload.value = entry.id;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copiedDownload.value = null; }, 1500);
}

async function removeDownload(entry: BrowserDownloadItem): Promise<void> {
  if (bridge === null) return;
  const removed = await bridge.browserRemoveDownload(entry.id).catch(() => false);
  if (!removed) {
    await refreshDownloads();
    return;
  }
  downloadsRevision += 1;
  downloads.value = downloads.value.filter((candidate) => candidate.id !== entry.id);
}

function groupByDate<T>(entries: readonly T[], timestamp: (entry: T) => number) {
  const groups = new Map<number, T[]>();
  for (const entry of [...entries].sort((a, b) => timestamp(b) - timestamp(a))) {
    const date = new Date(timestamp(entry));
    date.setHours(0, 0, 0, 0);
    const day = date.getTime();
    const group = groups.get(day) ?? [];
    group.push(entry);
    groups.set(day, group);
  }
  return [...groups].map(([date, entries]) => ({ date, entries }));
}

const downloadGroups = computed(() => groupByDate(downloads.value.filter((entry) => `${entry.filename} ${entry.url}`.toLowerCase().includes(downloadQuery.value.trim().toLowerCase())), (entry) => entry.startedAt));
const historyGroups = computed(() => groupByDate((snapshot.value?.history ?? []).filter((entry) => `${entry.title} ${entry.url}`.toLowerCase().includes(historyQuery.value.trim().toLowerCase())), (entry) => entry.visitedAt));

function formatGroupDate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (value === today.getTime()) return t('browser.records.today');
  today.setDate(today.getDate() - 1);
  if (value === today.getTime()) return t('browser.records.yesterday');
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(value);
}

function formatDate(value: number): string {
  return formatDownloadTime(value, locale.value);
}

function downloadStatus(entry: BrowserDownloadItem): string {
  return formatDownloadStatus(t, entry, locale.value);
}

function onWindowFocus(): void {
  if (activeSection.value === 'downloads') void refreshDownloads();
}

watch(activeSection, (section, previous) => {
  setBrowserDownloadsWatch(downloadsWatchOwner, section === 'downloads');
  if (section === 'downloads' && previous !== undefined) void refreshDownloads();
}, { immediate: true });

let offDownloads: (() => void) | undefined;

onMounted(() => {
  offDownloads = bridge?.onBrowserDownloads((next) => {
    downloadsRevision += 1;
    downloads.value = next;
  });
  window.addEventListener('focus', onWindowFocus);
  void refresh();
});

onUnmounted(() => {
  clearTimeout(copiedTimer);
  setBrowserDownloadsWatch(downloadsWatchOwner, false);
  offDownloads?.();
  window.removeEventListener('focus', onWindowFocus);
});
</script>

<template>
  <div class="browser-settings-panel">
    <header class="bsp-head">
      <h3 class="sec-title">{{ t('settings.tabs.browser') }}</h3>
      <SegmentedControl
        class="bsp-nav"
        size="xs"
        :model-value="activeSection"
        :options="sectionOptions"
        :aria-label="t('browser.settings.sectionAria')"
        @update:model-value="setSection"
      />
    </header>

    <section v-if="activeSection === 'settings'" class="bsp-section">
      <div v-if="snapshot" class="settings-group">
        <div class="row">
          <span class="rlabel">
            {{ t('browser.settings.agentControl') }}
            <small>{{ t('browser.settings.agentControlHint') }}</small>
          </span>
          <Switch
            :model-value="snapshot.preferences.agentControl"
            :label="t('browser.settings.agentControl')"
            @update:model-value="setAgentControl"
          />
        </div>
        <div class="row">
          <span class="rlabel">
            {{ t('browser.settings.subagentControl') }}
            <small>{{ t('browser.settings.subagentControlHint') }}</small>
          </span>
          <Switch
            :model-value="snapshot.preferences.subagentControl"
            :label="t('browser.settings.subagentControl')"
            :disabled="!snapshot.preferences.agentControl"
            @update:model-value="setSubagentControl"
          />
        </div>
        <div class="row">
          <span class="rlabel">
            {{ t('browser.settings.agentLocalFiles') }}
            <small>{{ t('browser.settings.agentLocalFilesHint') }}</small>
          </span>
          <Switch
            :model-value="snapshot.preferences.agentLocalFiles"
            :label="t('browser.settings.agentLocalFiles')"
            :disabled="!snapshot.preferences.agentControl"
            @update:model-value="setAgentLocalFiles"
          />
        </div>
        <div class="row">
          <span class="rlabel">{{ t('browser.settings.searchEngine') }}<small>{{ t('browser.settings.searchEngineHint') }}</small></span>
          <span class="bsp-select-control"><Select size="sm" :model-value="snapshot.preferences.searchEngine" :options="searchOptions" :aria-label="t('browser.settings.searchEngine')" @update:model-value="setSearchEngine" /></span>
        </div>
        <div class="row">
          <span class="rlabel">{{ t('browser.settings.autoplay') }}<small>{{ t('browser.settings.autoplayHint') }}</small></span>
          <span class="bsp-select-control"><Select size="sm" :model-value="snapshot.preferences.autoplay" :options="autoplayOptions" :aria-label="t('browser.settings.autoplay')" @update:model-value="setAutoplay" /></span>
        </div>
        <div class="row">
          <span class="rlabel">{{ t('browser.settings.sound') }}<small>{{ t('browser.settings.soundHint') }}</small></span>
          <span class="bsp-select-control"><Select size="sm" :model-value="snapshot.preferences.sound" :options="soundOptions" :aria-label="t('browser.settings.sound')" @update:model-value="setSound" /></span>
        </div>
        <div class="row">
          <span class="rlabel">
            {{ t('browser.settings.downloadsPrompt') }}
            <small>{{ t('browser.settings.downloadsPromptHint') }}</small>
          </span>
          <Switch
            :model-value="snapshot.preferences.askWhereToSave"
            :label="t('browser.settings.downloadsPrompt')"
            @update:model-value="setAskWhereToSave"
          />
        </div>
        <div v-if="agentDownloads" class="row bsp-agent-downloads">
          <span class="rlabel">
            {{ t('browser.settings.agentDownloadLocation') }}
            <small>{{ t('browser.settings.agentDownloadLocationHint') }}</small>
            <code class="bsp-agent-path">{{ agentDownloads.path }}</code>
            <small v-if="agentDownloads.fallback" class="bsp-agent-note">{{ t('browser.settings.agentDownloadFallback') }}</small>
            <small v-else-if="!agentDownloads.custom && agentDownloads.access === 'unknown'" class="bsp-agent-note">{{ t('browser.settings.agentDownloadAccessHint') }}</small>
          </span>
          <span class="bsp-agent-actions">
            <Button v-if="!agentDownloads.custom && agentDownloads.access !== 'granted'" size="sm" variant="secondary" :loading="checkingAccess" @click="checkDownloadsAccess">
              {{ agentDownloads.fallback ? t('browser.settings.agentDownloadAccessRetry') : t('browser.settings.agentDownloadAccess') }}
            </Button>
            <Button size="sm" variant="secondary" @click="chooseAgentDownloadDirectory">{{ t('browser.settings.agentDownloadChoose') }}</Button>
            <Button v-if="agentDownloads.custom" size="sm" variant="ghost" @click="resetAgentDownloadDirectory">{{ t('browser.settings.agentDownloadReset') }}</Button>
          </span>
        </div>
        <div class="row">
          <span class="rlabel">
            {{ t('browser.settings.agentDownloadLimit') }}
            <small>{{ t('browser.settings.agentDownloadLimitHint') }}</small>
          </span>
          <span class="bsp-select-control">
            <Select size="sm" :model-value="agentLimitValue" :options="agentLimitOptions" :aria-label="t('browser.settings.agentDownloadLimit')" @update:model-value="setAgentDownloadLimit" />
          </span>
        </div>
        <div class="row">
          <span class="rlabel">
            {{ t('browser.settings.defaultZoom') }}
            <small>{{ t('browser.settings.defaultZoomHint') }}</small>
          </span>
          <span class="bsp-select-control">
            <Select
              size="sm"
              :model-value="String(snapshot.preferences.defaultZoomFactor)"
              :options="zoomOptions"
              :aria-label="t('browser.settings.defaultZoom')"
              @update:model-value="setDefaultZoom"
            />
          </span>
        </div>
      </div>
      <BrowserUserAgentSettings v-if="snapshot" :snapshot="snapshot" @update="snapshot = $event" />
    </section>

    <section v-else-if="activeSection === 'downloads'" class="bsp-section">
      <header class="bsp-section-head">
        <IconButton
          size="sm"
          :label="t('browser.downloads.refresh')"
          :tooltip="t('browser.downloads.refresh')"
          :disabled="loading"
          @click="refresh"
        >
          <Icon name="refresh" />
        </IconButton>
        <Button v-if="downloads.some(canRemoveDownload)" size="sm" variant="secondary" @click="clearDownloads">
          {{ t('browser.downloads.clear') }}
        </Button>
      </header>
      <Input v-model="downloadQuery" class="bsp-search" type="search" size="sm" :aria-label="t('browser.records.searchDownloads')" :placeholder="t('browser.records.searchDownloads')" />
      <template v-if="snapshot">
        <div v-if="downloadGroups.length === 0" class="settings-group">
          <p class="bsp-empty">
            {{ t(downloads.length === 0 ? 'browser.downloads.empty' : 'browser.records.noResults') }}
          </p>
        </div>
        <template v-else>
          <section v-for="group in downloadGroups" :key="group.date" class="bsp-download-group settings-group">
            <h4 class="bsp-date-title">{{ formatGroupDate(group.date) }}</h4>
            <ul class="bsp-list">
              <li v-for="entry in group.entries" :key="entry.id" class="bsp-item bsp-download-item">
                <Icon name="download" />
                <span class="bsp-item-main">
                  <button
                    v-if="canOpenDownload(entry)"
                    type="button"
                    class="bsp-download-name"
                    @click="openDownload(entry, 'open')"
                  >{{ entry.filename }}</button>
                  <strong v-else :class="{ 'bsp-download-deleted': isDeletedDownload(entry) }">{{ entry.filename }}</strong>
                  <small class="bsp-download-status">{{ downloadStatus(entry) }}</small>
                  <ProgressBar
                    v-if="entry.state === 'progressing'"
                    class="bsp-progress"
                    :class="{ 'bsp-progress-paused': isPausedDownload(entry) }"
                    :value="downloadProgress(entry)"
                    :label="`${t(isPausedDownload(entry) ? 'browser.downloads.paused' : 'browser.downloads.progressing')} ${entry.filename}`"
                  />
                </span>
                <span class="bsp-item-actions">
                  <IconButton
                    v-if="canPauseDownload(entry)"
                    size="sm"
                    :label="t('browser.downloads.pause')"
                    :tooltip="t('browser.downloads.pause')"
                    @click="controlDownload(entry, 'pause')"
                  >
                    <Icon name="pause" />
                  </IconButton>
                  <IconButton
                    v-if="canResumeDownload(entry)"
                    size="sm"
                    :label="t('browser.downloads.resume')"
                    :tooltip="t('browser.downloads.resume')"
                    @click="controlDownload(entry, 'resume')"
                  >
                    <Icon name="play" />
                  </IconButton>
                  <IconButton
                    v-if="canRetryDownload(entry)"
                    size="sm"
                    :label="t('browser.downloads.retry')"
                    :tooltip="t('browser.downloads.retry')"
                    @click="controlDownload(entry, 'retry')"
                  >
                    <Icon name="refresh" />
                  </IconButton>
                  <IconButton
                    v-if="canCancelDownload(entry)"
                    size="sm"
                    :label="t('browser.downloads.cancel')"
                    :tooltip="t('browser.downloads.cancel')"
                    @click="controlDownload(entry, 'cancel')"
                  >
                    <Icon name="close" />
                  </IconButton>
                  <IconButton
                    v-if="canCopyDownloadLink(entry)"
                    size="sm"
                    :label="t(copiedDownload === entry.id ? 'browser.downloads.linkCopied' : 'browser.downloads.copyLink')"
                    :tooltip="t(copiedDownload === entry.id ? 'browser.downloads.linkCopied' : 'browser.downloads.copyLink')"
                    @click="copyDownloadLink(entry)"
                  >
                    <Icon :name="copiedDownload === entry.id ? 'check' : 'link'" />
                  </IconButton>
                  <IconButton
                    v-if="canOpenDownload(entry)"
                    size="sm"
                    :label="t('browser.downloads.showInFolder')"
                    :tooltip="t('browser.downloads.showInFolder')"
                    @click="openDownload(entry, 'show')"
                  >
                    <Icon name="folder" />
                  </IconButton>
                  <IconButton
                    v-if="canRemoveDownload(entry)"
                    size="sm"
                    :label="t('browser.downloads.remove')"
                    :tooltip="t('browser.downloads.remove')"
                    @click="removeDownload(entry)"
                  >
                    <Icon name="close" />
                  </IconButton>
                </span>
              </li>
            </ul>
          </section>
        </template>
      </template>
    </section>

    <BrowserSitesPanel v-else-if="activeSection === 'sites'" />

    <section v-else class="bsp-section">
      <header class="bsp-section-head">
        <IconButton
          size="sm"
          :label="t('browser.history.refresh')"
          :tooltip="t('browser.history.refresh')"
          :disabled="loading"
          @click="refresh"
        >
          <Icon name="refresh" />
        </IconButton>
      </header>
      <Input v-model="historyQuery" class="bsp-search" type="search" size="sm" :aria-label="t('browser.records.searchHistory')" :placeholder="t('browser.records.searchHistory')" />
      <div v-if="snapshot" class="settings-group">
        <p v-if="historyGroups.length === 0" class="bsp-empty">
          {{ t(snapshot.history.length === 0 ? 'browser.history.empty' : 'browser.records.noResults') }}
        </p>
        <div v-else>
          <section v-for="group in historyGroups" :key="group.date" class="bsp-date-group">
            <h4 class="bsp-date-title">{{ formatGroupDate(group.date) }}</h4>
            <ul class="bsp-list">
              <li v-for="entry in group.entries" :key="entry.id">
                <button class="bsp-item bsp-history-item" type="button" @click="emit('openUrl', entry.url)">
              <Favicon v-if="entry.favicon && !failedFavicons.has(entry.favicon)" :src="entry.favicon" @error="onFaviconError(entry.favicon)" />
                  <Icon v-else name="browser" />
                  <span class="bsp-item-main">
                    <strong>{{ entry.title }}</strong>
                    <small>{{ entry.url }} · {{ formatDate(entry.visitedAt) }}</small>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </div>
        <footer v-if="snapshot.history.length > 0" class="bsp-foot">
          <Button size="sm" variant="secondary" @click="clearHistory">
            {{ t('browser.history.clear') }}
          </Button>
        </footer>
      </div>
    </section>
  </div>
</template>

<style scoped src="../settings/settings-common.css"></style>

<style scoped>
.browser-settings-panel {
  display: block;
  color: var(--color-text);
}
.bsp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.bsp-head .sec-title {
  margin: 0;
}
.bsp-section {
  padding: 0 0 var(--space-4);
}
.bsp-section-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.bsp-item {
  min-height: var(--browser-settings-row-min-height);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
}
.bsp-list > li + li,
.bsp-foot {
  border-top: var(--p-hairline) solid var(--color-line);
}
.bsp-section .row > .rlabel {
  flex: 1;
  min-width: 0;
}
.bsp-section .settings-group > .row {
  min-height: var(--browser-settings-row-min-height);
  border-top: var(--p-hairline) solid var(--color-line);
}
.bsp-section .settings-group > .row:first-child { border-top: none; }
.bsp-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.bsp-download-item {
  --bsp-download-name-line: calc(var(--text-sm) * var(--leading-normal));
  align-items: flex-start;
}
.bsp-download-item > :deep(svg) {
  margin-top: calc((var(--bsp-download-name-line) - var(--p-ic-md)) / 2);
}
.bsp-download-item .bsp-item-main > :first-child {
  line-height: var(--bsp-download-name-line);
}
.bsp-download-item .bsp-item-actions {
  margin-top: calc((var(--bsp-download-name-line) - var(--icon-button-sm)) / 2);
}
.bsp-download-item .bsp-item-main {
  gap: var(--space-05);
}
.bsp-download-item .bsp-download-status {
  color: var(--color-text-muted);
  font-weight: var(--weight-medium);
  line-height: var(--leading-caption);
}
.bsp-progress {
  margin-top: var(--space-1);
}
.bsp-progress-paused :deep(.ui-progress-bar__indicator) {
  animation-play-state: paused;
}
.bsp-item-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}
.bsp-select-control {
  width: var(--browser-settings-control-width);
  max-width: 50%;
  flex: 0 1 var(--browser-settings-control-width);
  min-width: var(--browser-settings-control-min-width);
}
.bsp-agent-downloads {
  align-items: flex-start;
}
.bsp-agent-path {
  display: block;
  margin-top: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.bsp-agent-note {
  display: block;
  margin-top: var(--space-1);
}
.bsp-agent-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
  max-width: 50%;
}
.rlabel small {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.bsp-item-main small {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
}
.bsp-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.bsp-search { margin-bottom: var(--space-3); }
.bsp-date-title { margin: 0; padding: var(--space-3) var(--space-4) var(--space-1); font-size: var(--ui-c1); font-weight: var(--weight-medium); color: var(--color-text-muted); }
.bsp-date-group + .bsp-date-group { border-top: var(--p-hairline) solid var(--color-line); }
.bsp-download-group + .bsp-download-group { margin-top: var(--space-3); }
.bsp-history-item {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.bsp-history-item:hover {
  background: var(--color-hover);
}
.bsp-history-item:focus-visible {
  outline: none;
  box-shadow: inset var(--p-focus-ring);
}
.bsp-item > img,
.bsp-item > :deep(svg) {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  flex: none;
  object-fit: contain;
}
.bsp-item-main strong,
.bsp-item-main small,
.bsp-download-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bsp-item-main strong {
  font-weight: var(--weight-medium);
}
.bsp-download-name {
  align-self: flex-start;
  max-width: 100%;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-weight: var(--weight-medium);
  text-align: left;
  cursor: pointer;
}
.bsp-download-name:hover {
  text-decoration: underline;
}
.bsp-download-name:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.bsp-download-deleted {
  text-decoration: line-through;
}
.bsp-empty {
  margin: 0;
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-muted);
  text-align: center;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.bsp-foot {
  display: flex;
  justify-content: flex-end;
  padding: var(--space-3) var(--space-4);
}
</style>
