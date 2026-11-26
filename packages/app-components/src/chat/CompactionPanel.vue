<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { EmptyState, ScrollArea } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client/types';
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
  cwd?: string;
  openFile?: (target: FilePreviewRequest) => void;
}>();

const { t } = useI18n();

const displayText = computed(() => cleanCompactionSummary(props.text));
const assumedFilePathResolver = computed(() =>
  props.cwd ? createCwdAssumedResolver(props.cwd) : undefined,
);
</script>

<template>
  <section class="cp" :aria-label="t('panel.tabs.compaction')">
    <ScrollArea v-if="displayText" class="cp-scroll" data-panel-content>
      <div class="cp-doc">
        <Markdown
          :text="displayText"
          :state-key="`compaction:${turnId ?? 'summary'}`"
          :open-file="openFile"
          :resolve-file-path="assumedFilePathResolver"
        />
      </div>
    </ScrollArea>
    <div v-else class="cp-empty" data-panel-content>
      <EmptyState :title="t('panel.compactionUnavailable')" />
    </div>
  </section>
</template>

<style scoped>
.cp {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.cp-scroll {
  flex: 1;
  min-height: 0;
}

.cp-doc {
  padding: 16px 18px max(18px, var(--pfc-host-h, 0px));
  min-width: 0;
}

.cp-doc :deep(.markdown-renderer > .node-slot:first-child) {
  padding-top: 0;
}

.cp-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
