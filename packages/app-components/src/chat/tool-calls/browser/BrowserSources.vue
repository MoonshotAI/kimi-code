<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Button, Favicon, Icon, IconButton, Tooltip } from '@moonshot-ai/app-ui';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import { turnBlocks } from '../../../chatTurnRendering';
import { useHistoryState } from '../../historyState';
import { BROWSER_DIALOG_RECORD_ICONS, browserHandledDialogs, digestBrowserActivity, type BrowserHandledDialog, type BrowserVisitedPage } from '../browserActivity';
import { BrowserFaviconSourceKey } from '../browserLive';
import { browserPageHost, readableBrowserUrl } from '../browserPages';
import { BrowserToolContextKey } from '../browserToolContext';
import { isBrowserTool } from '../browserToolPresentation';

const SITE_PREVIEW = 3;

const props = defineProps<{ turns: readonly ChatTurn[] }>();
const { t } = useI18n();
const contexts = inject(BrowserToolContextKey, undefined);
const resolveSidebar = inject(OpenSidebarBrowserUrlKey, undefined);
const favicons = inject(BrowserFaviconSourceKey, undefined);
const open = useHistoryState('browser-sources:open', false);
const copied = ref<string | null>(null);
const broken = ref<ReadonlySet<string>>(new Set());
const listId = useId();
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const tools = computed(() => props.turns.flatMap((turn) => turnBlocks(turn).flatMap((block) =>
  block.kind === 'tool' && isBrowserTool(block.tool) ? [block.tool] : [])));

const pages = computed(() => tools.value.length === 0 ? [] : digestBrowserActivity(tools.value, {
  context: (tool) => contexts?.value.get(tool as ToolCall),
}).pages);

const dialogs = computed(() => tools.value.length === 0 ? [] : browserHandledDialogs(tools.value));

const read = computed(() => pages.value.filter((page) => page.read));
const passed = computed(() => pages.value.filter((page) => !page.read));

const pageSummary = computed(() => {
  if (pages.value.length === 0) return undefined;
  if (read.value.length === 0) return t('tools.browser.sources.visited', { count: passed.value.length });
  if (passed.value.length === 0) return t('tools.browser.sources.read', { count: read.value.length });
  return t('tools.browser.sources.readAndPassed', { read: read.value.length, passed: passed.value.length });
});

const summary = computed(() => [
  pageSummary.value,
  dialogs.value.length > 0 ? t('tools.browser.sources.dialogs', { count: dialogs.value.length }) : undefined,
].filter(Boolean).join(' · '));

function dialogTitle(dialog: BrowserHandledDialog): string {
  return t(`browser.dialogRecords.kinds.${dialog.kind}`);
}

function dialogOutcome(dialog: BrowserHandledDialog): string {
  return t('browser.dialogRecords.answeredBy', {
    outcome: t(`browser.dialogRecords.outcomes.${dialog.outcome}`),
    answerer: t(`browser.dialogRecords.answerers.${dialog.answerer}`),
  });
}

const groups = computed(() => [
  { key: 'read', title: t('tools.browser.sources.readGroup'), pages: read.value },
  { key: 'passed', title: t('tools.browser.sources.passedGroup'), pages: passed.value },
].filter((group) => group.pages.length > 0));

const sites = computed(() => {
  const seen = new Set<string>();
  const list: { host: string; url: string }[] = [];
  for (const page of [...read.value, ...passed.value]) {
    const host = browserPageHost(page.url);
    if (seen.has(host)) continue;
    seen.add(host);
    list.push({ host, url: page.url });
    if (list.length === SITE_PREVIEW) break;
  }
  return list;
});

const sidebar = computed(() => resolveSidebar?.());

const visible = computed(() => pages.value.length > 0 || dialogs.value.length > 0);

watch(() => pages.value.length > 0, (visible) => {
  if (visible) favicons?.refresh();
}, { immediate: true });

onBeforeUnmount(() => clearTimeout(copiedTimer));

function favicon(url: string): string | undefined {
  const source = favicons?.favicon(url);
  return source !== undefined && !broken.value.has(source) ? source : undefined;
}

function markBroken(url: string): void {
  const source = favicons?.favicon(url);
  if (source !== undefined) broken.value = new Set([...broken.value, source]);
}

function address(page: BrowserVisitedPage): string {
  return page.titled ? readableBrowserUrl(page.url) : browserPageHost(page.url);
}

function tag(page: BrowserVisitedPage): string {
  if (page.read) return t('tools.browser.sources.readTag');
  return page.visits > 1 ? t('tools.browser.sources.visits', { count: page.visits }) : t('tools.browser.sources.passedTag');
}

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}

function openPage(url: string): void {
  const opener = sidebar.value;
  if (opener) opener(url);
  else openExternal(url);
}

async function copy(url: string): Promise<void> {
  if (!(await copyTextToClipboard(url))) return;
  copied.value = url;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = null; }, 1500);
}
</script>

<template>
  <div v-if="visible" class="bsrc" :class="{ open }">
    <Button variant="secondary" size="sm" class="bsrc-pill" :aria-expanded="open" @click="open = !open">
      <span class="bsrc-sites" aria-hidden="true">
        <span v-for="site in sites" :key="site.host" class="bsrc-fav">
          <Favicon v-if="favicon(site.url)" :src="favicon(site.url)!" draggable="false" @error="markBroken(site.url)" />
          <span v-else class="bsrc-fallback"><Icon class="bsrc-globe" name="globe" size="sm" /></span>
        </span>
      </span>
      <span v-if="sites.length === 0" class="bsrc-sites" aria-hidden="true"><span class="bsrc-fav"><span class="bsrc-fallback"><Icon class="bsrc-globe" name="bell" size="sm" /></span></span></span>
      <span>{{ summary }}</span>
      <Icon class="bsrc-car" name="chevron-right" size="sm" aria-hidden="true" />
    </Button>
    <div v-if="open" class="bsrc-list" role="region" :aria-label="t('tools.browser.sources.label')" :style="{ '--bsrc-action-count': sidebar ? 3 : 2 }">
      <section v-for="group in groups" :key="group.key" class="bsrc-group">
        <div :id="`${listId}-${group.key}`" class="bsrc-group-title">{{ group.title }}</div>
        <ul class="bsrc-rows" :aria-labelledby="`${listId}-${group.key}`">
          <li v-for="page in group.pages" :key="page.url" class="bsrc-row">
            <Tooltip :text="page.url" :max-lines="3">
              <button type="button" class="bsrc-main" @click="openPage(page.url)">
                <span class="bsrc-fav" aria-hidden="true">
                  <Favicon v-if="favicon(page.url)" :src="favicon(page.url)!" draggable="false" @error="markBroken(page.url)" />
                  <span v-else class="bsrc-fallback"><Icon class="bsrc-globe" name="globe" size="sm" /></span>
                </span>
                <span class="bsrc-text">
                  <span class="bsrc-title">{{ page.label }}</span>
                  <span class="bsrc-address">{{ address(page) }}</span>
                </span>
                <span class="bsrc-trail">
                  <Badge class="bsrc-tag" :variant="page.read ? 'success' : 'neutral'" size="sm">{{ tag(page) }}</Badge>
                </span>
              </button>
            </Tooltip>
            <span class="bsrc-actions">
              <IconButton
                v-if="sidebar"
                size="sm"
                :label="t('tools.browser.sources.openSidebar')"
                :tooltip="t('tools.browser.sources.openSidebar')"
                @click="openPage(page.url)"
              >
                <Icon name="browser" size="sm" />
              </IconButton>
              <IconButton
                size="sm"
                :label="t('tools.browser.sources.openExternal')"
                :tooltip="t('tools.browser.sources.openExternal')"
                @click="openExternal(page.url)"
              >
                <Icon name="external-link" size="sm" />
              </IconButton>
              <IconButton
                size="sm"
                :label="t(copied === page.url ? 'tools.browser.sources.copied' : 'tools.browser.sources.copy')"
                :tooltip="t(copied === page.url ? 'tools.browser.sources.copied' : 'tools.browser.sources.copy')"
                @click="copy(page.url)"
              >
                <Icon :name="copied === page.url ? 'check' : 'link'" size="sm" />
              </IconButton>
            </span>
          </li>
        </ul>
      </section>
      <section v-if="dialogs.length > 0" class="bsrc-group bsrc-dialogs">
        <div :id="`${listId}-dialogs`" class="bsrc-group-title">{{ t('tools.browser.sources.dialogsGroup') }}</div>
        <ul class="bsrc-rows" :aria-labelledby="`${listId}-dialogs`">
          <li v-for="dialog in dialogs" :key="dialog.id" class="bsrc-row bsrc-dialog">
            <span class="bsrc-fav" aria-hidden="true"><span class="bsrc-fallback"><Icon class="bsrc-globe" :name="BROWSER_DIALOG_RECORD_ICONS[dialog.kind] ?? 'info'" size="sm" /></span></span>
            <span class="bsrc-text">
              <span class="bsrc-title">{{ dialogTitle(dialog) }}</span>
              <span class="bsrc-address bsrc-wrap">{{ [dialog.origin, dialogOutcome(dialog)].filter(Boolean).join(' · ') }}</span>
              <span v-if="dialog.message" class="bsrc-address bsrc-wrap">{{ dialog.message }}</span>
              <span v-if="dialog.text !== undefined" class="bsrc-address bsrc-wrap">{{ t('tools.browser.sources.dialogAnswer', { text: JSON.stringify(dialog.text) }) }}</span>
              <span v-for="file in dialog.files" :key="file" class="bsrc-path">{{ file }}</span>
            </span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.bsrc {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--chat-block-gap);
  min-width: 0;
}
.bsrc-sites {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
}
.bsrc-fav {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--browser-sources-favicon-size);
  height: var(--browser-sources-favicon-size);
}
.bsrc-fav img {
  width: var(--browser-sources-favicon-size);
  height: var(--browser-sources-favicon-size);
  object-fit: contain;
}
.bsrc-fallback {
  display: inline-grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-xs);
  background: var(--color-fill-2);
  color: var(--color-text-muted);
}
.bsrc-globe {
  width: var(--browser-sources-fallback-icon-size);
  height: var(--browser-sources-fallback-icon-size);
}
.bsrc-car {
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.bsrc.open .bsrc-car {
  transform: rotate(90deg);
}
.bsrc-list {
  box-sizing: border-box;
  width: 100%;
  max-height: var(--browser-sources-list-max-height);
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--space-1);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}
.bsrc-group + .bsrc-group {
  margin-top: var(--space-1);
}
.bsrc-group-title {
  margin: 0;
  padding: var(--space-1-5) var(--space-2) var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
}
.bsrc-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.bsrc-row {
  position: relative;
  border-radius: var(--radius-md);
}
.bsrc-row:hover {
  background: var(--color-hover);
}
.bsrc-main {
  display: flex;
  width: 100%;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-1-5) var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.bsrc-main:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.bsrc-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.bsrc-title,
.bsrc-address {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bsrc-title {
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.bsrc-address {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.bsrc-trail {
  display: inline-flex;
  flex: none;
  justify-content: flex-end;
  width: calc(var(--icon-button-sm) * var(--bsrc-action-count) + var(--space-05) * (var(--bsrc-action-count) - 1));
}
.bsrc-dialog {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
}
.bsrc-dialog:hover {
  background: transparent;
}
.bsrc-wrap {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}
.bsrc-path {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.bsrc-tag {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.bsrc-actions {
  position: absolute;
  top: 0;
  right: var(--space-2);
  bottom: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-05);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.bsrc-row:hover .bsrc-actions,
.bsrc-row:focus-within .bsrc-actions {
  opacity: 1;
}
.bsrc-row:hover .bsrc-tag,
.bsrc-row:focus-within .bsrc-tag {
  opacity: 0;
}
@media (hover: none) {
  .bsrc-actions {
    opacity: 1;
  }
  .bsrc-tag {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bsrc-list {
    animation: none;
  }
  .bsrc-car {
    transition: none;
  }
}
</style>
