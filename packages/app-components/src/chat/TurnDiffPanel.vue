<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, PanelHeader, Spinner } from '@moonshot-ai/app-ui';
import { MAX_TURN_DIFF_CHARS } from '@moonshot-ai/app-core/client';
import type { DiffViewLine, TurnFileChange } from '@moonshot-ai/app-core/client/types';
import type { TurnDiffResult } from './turnDiff.worker';
import { logWarn } from '@moonshot-ai/app-core/lib';
import { FetchTurnFileContentKey } from '@moonshot-ai/app-client/contracts';
import HighlightedCode from '../HighlightedCode.vue';
import HtmlOpenActions from '../HtmlOpenActions.vue';
import { absoluteFilePath, displayFilePath } from '../lib/displayPath';
import { openFileContextMenu } from './fileContextMenu';

const props = defineProps<{
  change: TurnFileChange;
  daemonTurnId?: number;
  sessionId?: string;
  cwd?: string;
}>();

const emit = defineEmits<{ openFile: [path: string] }>();

const { t } = useI18n();

const displayTitle = computed(() => displayFilePath({ path: props.change.path, cwd: props.cwd }));
const rawTitle = computed(() => absoluteFilePath({ path: props.change.path, cwd: props.cwd }));

const fetchTurnFileContent = inject(FetchTurnFileContentKey, undefined);
const trueDiff = shallowRef<DiffViewLine[] | null>(null);
const loading = ref(false);
const diffBody = ref<HTMLElement>();
watch(trueDiff, (lines) => {
  const body = diffBody.value;
  if (!body || !lines) return;
  const firstChange = lines.findIndex(line => line.type === 'add' || line.type === 'del');
  const row = body.querySelectorAll<HTMLElement>('.hl-row')[Math.max(0, firstChange - 3)];
  body.scrollTop = row ? body.scrollTop + row.getBoundingClientRect().top - body.getBoundingClientRect().top : 0;
}, { flush: 'post' });
watch(
  () => [props.daemonTurnId, props.change, props.sessionId] as const,
  async ([turnId, change, sessionId], _previous, onCleanup) => {
    let active = true;
    let worker: Worker | undefined;
    let cancel: (() => void) | undefined;
    onCleanup(() => {
      active = false;
      worker?.terminate();
      cancel?.();
    });
    loading.value = false;
    trueDiff.value = null;
    const logUnavailable = (reason: string, detail: Record<string, unknown> = {}) => {
      if (active) logWarn('turn file diff unavailable', { reason, turnId, path: change.path, ...detail });
    };
    if (fetchTurnFileContent === undefined || turnId === undefined) {
      logUnavailable(fetchTurnFileContent === undefined ? 'fetcher_missing' : 'turn_id_missing');
      return;
    }
    loading.value = true;
    try {
      const [start, end] = await Promise.all([
        fetchTurnFileContent(turnId, change.path, 'start', sessionId),
        fetchTurnFileContent(turnId, change.path, 'end', sessionId),
      ]);
      if (!active) return;
      if (start === undefined || end === undefined) {
        logUnavailable('snapshot_missing', { startMissing: start === undefined, endMissing: end === undefined });
        return;
      }
      if (start.binary === true || end.binary === true) {
        logUnavailable('binary_snapshot', { startBinary: start.binary === true, endBinary: end.binary === true });
        return;
      }
      const before = start.content ?? '';
      const after = end.content ?? '';
      if (before.length > MAX_TURN_DIFF_CHARS || after.length > MAX_TURN_DIFF_CHARS) {
        logUnavailable('character_limit', { startChars: before.length, endChars: after.length, maxChars: MAX_TURN_DIFF_CHARS });
        return;
      }
      worker = new Worker(new URL('./turnDiff.worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<TurnDiffResult | null>((resolve, reject) => {
        cancel = () => resolve(null);
        worker!.onmessage = (event: MessageEvent<TurnDiffResult>) => resolve(event.data);
        worker!.onerror = (event) => reject(new Error(event.message || 'Turn diff worker failed'));
        worker!.onmessageerror = () => reject(new Error('Turn diff worker response could not be decoded'));
        worker!.postMessage({ before, after });
      });
      if (!active || result === null) return;
      if (result.unavailable) logUnavailable(result.unavailable.reason, result.unavailable);
      if (result.lines !== null && result.lines.length > 0) trueDiff.value = result.lines;
      else if (result.lines?.length === 0) logUnavailable('empty_diff');
    } catch (error) {
      logUnavailable('exception', { error });
    } finally {
      worker?.terminate();
      if (active) loading.value = false;
    }
  },
  { immediate: true },
);

const hasDiff = computed(() => trueDiff.value !== null && trueDiff.value.length > 0);

const isHtml = computed(() => /\.html?$/i.test(props.change.path));

const codeWrap = ref(false);
</script>

<template>
  <div class="td panel-file-head">
    <PanelHeader :title="displayTitle" :title-tooltip="rawTitle" :closable="false" :data-file-path="change.path" :data-file-deleted="change.status === 'deleted' ? '' : undefined" @contextmenu="openFileContextMenu($event, cwd)">
      <div class="panel-file-head-actions">
        <IconButton
          v-if="hasDiff"
          size="sm"
          :label="codeWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
          :tooltip="codeWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
          :aria-pressed="codeWrap"
          @click="codeWrap = !codeWrap"
        >
          <Icon :name="codeWrap ? 'text-wrap-disabled' : 'text-wrap'" size="md" />
        </IconButton>
        <HtmlOpenActions v-if="isHtml" :path="rawTitle" />
        <IconButton size="sm" :label="t('conversation.turnFiles.openFile')" :tooltip="t('conversation.turnFiles.openFile')" @click="emit('openFile', rawTitle)"><Icon name="folder-jump" size="md" /></IconButton>
      </div>
    </PanelHeader>

    <div ref="diffBody" class="td-body" data-panel-content data-quote-display-lines>
      <HighlightedCode v-if="hasDiff" :lines="trueDiff!" :path="change.path" :framed="false" :wrap="codeWrap" />
      <div v-else-if="loading" class="td-empty">
        <Spinner size="sm" />
        <p>{{ t('conversation.turnFiles.rebuilding') }}</p>
      </div>
      <div v-else class="td-empty">
        <p>{{ t('conversation.turnFiles.diffUnavailable') }}</p>
        <Button variant="ghost" size="sm" @click="emit('openFile', rawTitle)">{{ t('conversation.turnFiles.openFile') }}</Button>
      </div>
    </div>
  </div>
</template>

<style src="../lib/panel-file-head.css"></style>

<style scoped>
.td {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.td-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: var(--pfc-host-h, 0px);
}
.td-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-6);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  text-align: center;
}
</style>
