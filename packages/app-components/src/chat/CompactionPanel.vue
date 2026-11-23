<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { EmptyState, Icon, IconButton, ScrollArea } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { CompactionTurnData, FilePreviewRequest } from '@moonshot-ai/app-core/client/types';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { createCwdAssumedResolver } from './turnFilePathIndex';

const LEGACY_SUMMARY_PREFIX =
  /^The conversation so far has been compacted to free up context\.[^\n]*\n+/;
const TRAILING_SYSTEM_REMINDER = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/;

function cleanCompactionSummary(raw: string | null): string {
  if (!raw) return '';
  return raw
    .replace(LEGACY_SUMMARY_PREFIX, '')
    .replace(TRAILING_SYSTEM_REMINDER, '')
    .trim();
}

const props = defineProps<{
  turnId?: string;
  text: string | null;
  compaction?: CompactionTurnData;
  cwd?: string;
  openFile?: (target: FilePreviewRequest) => void;
}>();

const { t } = useI18n();

const displayText = computed(() => cleanCompactionSummary(props.text));
const hasText = computed(() => displayText.value.length > 0);
const instructionText = computed(() => props.compaction?.instruction?.trim() ?? '');
const assumedFilePathResolver = computed(() =>
  props.cwd ? createCwdAssumedResolver(props.cwd) : undefined,
);

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

function resetCopied(): void {
  copied.value = false;
  if (copyTimer !== undefined) {
    clearTimeout(copyTimer);
    copyTimer = undefined;
  }
}

watch(() => [props.turnId, props.text], resetCopied);
onBeforeUnmount(resetCopied);

async function copySummary(): Promise<void> {
  if (!hasText.value) return;
  const ok = await copyTextToClipboard(displayText.value);
  if (!ok) return;
  resetCopied();
  copied.value = true;
  copyTimer = setTimeout(() => {
    copied.value = false;
    copyTimer = undefined;
  }, 1600);
}
</script>

<template>
  <section class="cp" :aria-label="t('panel.tabs.compaction')">
    <template v-if="hasText">
      <IconButton
        class="cp-copy-btn"
        size="sm"
        :label="copied ? t('panel.inspector.copied') : t('filePreview.copy')"
        :tooltip="copied ? t('panel.inspector.copied') : t('filePreview.copy')"
        @click="copySummary"
      >
        <Icon :name="copied ? 'check' : 'copy'" size="sm" />
      </IconButton>

      <ScrollArea class="cp-scroll">
        <div class="cp-doc">
          <div v-if="instructionText" class="cp-focus">
            <span class="cp-focus-label">{{ t('panel.compactionInstruction') }}</span>
            <span class="cp-focus-text">{{ instructionText }}</span>
          </div>
          <Markdown
            :text="displayText"
            :state-key="`compaction:${turnId ?? 'summary'}`"
            :open-file="openFile"
            :resolve-file-path="assumedFilePathResolver"
          />
        </div>
      </ScrollArea>
    </template>
    <div v-else class="cp-empty">
      <EmptyState :title="t('panel.compactionUnavailable')" />
    </div>
  </section>
</template>

<style scoped>
.cp {
  position: relative;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-ui);
}

.cp-copy-btn {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: var(--z-sticky);
  background: var(--color-bg);
  border: var(--p-hairline) solid var(--color-line);
  box-shadow: var(--shadow-xs);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.cp:hover .cp-copy-btn,
.cp-copy-btn:focus-visible {
  opacity: 1;
}

@media (hover: none) {
  .cp-copy-btn {
    opacity: 1;
  }
}

.cp-scroll {
  flex: 1;
  min-height: 0;
}

.cp-doc {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px max(18px, var(--pfc-host-h, 0px));
  min-width: 0;
}

.cp-doc :deep(.markdown-renderer > .node-slot:first-child) {
  padding-top: 0;
}

.cp-focus {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: var(--p-hairline) solid var(--color-line);
  font-size: var(--text-xs);
  line-height: 1.5;
}

.cp-focus-label {
  flex: none;
  color: var(--color-text-faint);
  font-weight: var(--weight-medium);
}

.cp-focus-text {
  color: var(--color-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cp-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
