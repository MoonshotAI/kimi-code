<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { anyMenuOpen, ContextRing, Icon, IconButton } from '@moonshot-ai/app-ui';
import type { BrowserDownloadAction, BrowserDownloadItem } from '../../../shared/browser-data';
import type { BrowserOverlayMenuItem } from '../../../shared/browser-overlay';
import { openBrowserOverlayDialogCount } from '../../lib/browserOverlayDialog';
import { registerBrowserOverlayMenu } from '../../lib/browserOverlayMenu';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import {
  BROWSER_DOWNLOAD_AUTO_CLOSE_MS,
  BROWSER_DOWNLOAD_BUBBLE_LIMIT,
  browserDownloadIndicator,
  canCancelDownload,
  canOpenDownload,
  canPauseDownload,
  canResumeDownload,
  canRetryDownload,
  downloadBubbleStatus,
  downloadProgress,
  isPausedDownload,
  useBrowserDownloads,
} from '../../lib/browserDownloads';

const props = defineProps<{ browserId: string; active: boolean }>();
const emit = defineEmits<{ openAll: [] }>();
const { t } = useI18n();
const bridge = getNativeBrowserBridge();
const downloads = useBrowserDownloads();
const button = ref<InstanceType<typeof IconButton> | null>(null);
const autoOpened = ref(false);
let autoCloseTimer: ReturnType<typeof setTimeout> | undefined;

const SEE_ALL = 'see-all';

const bubbleEntries = computed(() => downloads.recent.value.slice(0, BROWSER_DOWNLOAD_BUBBLE_LIMIT));
const indicator = computed(() => browserDownloadIndicator(downloads.progress.value));
const label = computed(() => t('browser.downloads.title'));

function actionId(action: BrowserDownloadAction['action'] | 'row', id: string): string {
  return `${action}:${id}`;
}

function rowActions(entry: BrowserDownloadItem): NonNullable<Extract<BrowserOverlayMenuItem, { kind: 'item' }>['actions']> {
  return [
    ...(canPauseDownload(entry) ? [{ id: actionId('pause', entry.id), label: t('browser.downloads.pause'), icon: 'pause', keepOpen: true }] : []),
    ...(canResumeDownload(entry) ? [{ id: actionId('resume', entry.id), label: t('browser.downloads.resume'), icon: 'play', keepOpen: true }] : []),
    ...(canRetryDownload(entry) ? [{ id: actionId('retry', entry.id), label: t('browser.downloads.retry'), icon: 'refresh', keepOpen: true }] : []),
    ...(canCancelDownload(entry) ? [{ id: actionId('cancel', entry.id), label: t('browser.downloads.cancel'), icon: 'close', keepOpen: true }] : []),
    ...(canOpenDownload(entry) ? [{ id: actionId('show', entry.id), label: t('browser.downloads.showInFolder'), icon: 'folder' }] : []),
  ];
}

function row(entry: BrowserDownloadItem): BrowserOverlayMenuItem {
  const name = (entry.filename || entry.url || entry.id).slice(0, 256);
  const paused = isPausedDownload(entry);
  return {
    kind: 'item',
    id: actionId('row', entry.id),
    label: name,
    icon: 'file',
    description: downloadBubbleStatus(t, entry).slice(0, 1024),
    ...(canOpenDownload(entry) ? {} : { keepOpen: true }),
    ...(entry.state === 'interrupted' ? { tone: 'danger' as const } : {}),
    ...(entry.state === 'progressing'
      ? { progress: { label: `${t(paused ? 'browser.downloads.paused' : 'browser.downloads.progressing')} ${name}`.slice(0, 256), value: downloadProgress(entry), ...(paused ? { paused: true } : {}) } }
      : {}),
    actions: rowActions(entry),
  };
}

function menuItems(): BrowserOverlayMenuItem[] {
  const entries = bubbleEntries.value;
  return [
    { kind: 'section', id: 'downloads-recent', label: t('browser.downloads.recent') },
    ...(entries.length === 0 ? [{ kind: 'note' as const, id: 'downloads-empty', label: t('browser.downloads.empty') }] : entries.map(row)),
    { kind: 'separator' },
    { kind: 'item', id: SEE_ALL, label: t('browser.downloads.seeAll'), icon: 'list' },
  ];
}

function clearAutoClose(): void {
  clearTimeout(autoCloseTimer);
  autoCloseTimer = undefined;
  autoOpened.value = false;
}

const menu = registerBrowserOverlayMenu({
  id: `browser.downloads.${props.browserId}`,
  width: 340,
  placement: 'bottom-end',
  offset: 4,
  items: menuItems,
  footerStart: () => Math.max(1, bubbleEntries.value.length) + 1,
  onSelect: (itemId) => {
    if (autoOpened.value) downloads.markSeen();
    clearAutoClose();
    void runAction(itemId);
  },
  onClose: () => clearAutoClose(),
});

async function runAction(itemId: string): Promise<void> {
  if (itemId === SEE_ALL) {
    emit('openAll');
    return;
  }
  const separator = itemId.indexOf(':');
  if (separator < 0 || bridge === null) return;
  const kind = itemId.slice(0, separator);
  const entry = downloads.recent.value.find((candidate) => candidate.id === itemId.slice(separator + 1));
  if (entry === undefined) return;
  const action: BrowserDownloadAction['action'] | null = kind === 'row'
    ? (canOpenDownload(entry) ? 'open' : null)
    : kind === 'show' || kind === 'pause' || kind === 'resume' || kind === 'cancel' || kind === 'retry' ? kind : null;
  if (action === null) return;
  const done = await bridge.browserOpenDownload(entry.id, action).catch(() => false);
  if (!done) await downloads.refresh();
}

function toggle(): void {
  const el = button.value?.el;
  if (el === undefined) return;
  if (autoOpened.value) {
    clearAutoClose();
    downloads.markSeen();
    menu.show(el, { preserveFocus: false });
    return;
  }
  if (!menu.open.value) downloads.markSeen();
  menu.toggle(el);
}

function canAutoOpen(): boolean {
  return props.active && !menu.open.value && !anyMenuOpen.value && openBrowserOverlayDialogCount.value === 0
    && document.visibilityState !== 'hidden' && document.hasFocus();
}

watch(downloads.completion, () => {
  void nextTick(() => {
    const el = button.value?.el;
    if (el === undefined) return;
    const extend = autoOpened.value && menu.open.value && props.active;
    if (!extend && !canAutoOpen()) return;
    clearTimeout(autoCloseTimer);
    autoOpened.value = true;
    if (!extend) menu.show(el, { preserveFocus: true });
    autoCloseTimer = setTimeout(() => {
      if (!autoOpened.value) return;
      autoOpened.value = false;
      menu.close();
    }, BROWSER_DOWNLOAD_AUTO_CLOSE_MS);
  });
});

watch(() => menuItems(), () => menu.refresh(), { deep: true });

watch([downloads.unseen, menu.open], ([unseen, open]) => {
  if (unseen && open && !autoOpened.value) downloads.markSeen();
});

watch(() => props.active, (active) => {
  if (active) return;
  clearAutoClose();
  menu.close();
});

watch(downloads.visible, (visible) => {
  if (!visible) menu.close();
});

void downloads.refresh();

onScopeDispose(() => {
  clearTimeout(autoCloseTimer);
  downloads.release();
});
</script>

<template>
  <IconButton
    v-if="downloads.visible.value"
    ref="button"
    size="sm"
    class="pb-download-button"
    :class="{ 'is-unseen': downloads.unseen.value }"
    :label="label"
    :tooltip="label"
    aria-haspopup="menu"
    :aria-expanded="menu.open.value"
    @click="toggle"
  >
    <span v-if="indicator.ring" class="pb-download-progress">
      <ContextRing class="pb-download-ring" weight="thin" origin :indeterminate="indicator.indeterminate" :pct="indicator.pct" />
      <Icon name="download" />
    </span>
    <Icon v-else name="download" />
  </IconButton>
</template>

<style scoped>
.pb-download-progress {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--p-ic-lg);
  height: var(--p-ic-lg);
}
.pb-download-progress .pb-download-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.pb-download-progress :deep(.kw-icon) {
  position: relative;
  width: calc(var(--p-ic-lg) - 2 * var(--space-1));
  height: calc(var(--p-ic-lg) - 2 * var(--space-1));
}
.pb-download-button.is-unseen {
  color: var(--color-accent);
}
</style>
