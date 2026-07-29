<!-- apps/web/src/components/chat/TurnDiffPanel.vue -->
<!-- Right-side turn diff for one summary file: the turn's own X→Y change, not
     the git diff. Rendered with HighlightedCode like the Edit tool's inline diff. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, PanelHeader, Tooltip } from '@moonshot-ai/web-ui';
import type { TurnFileChange } from '../chatTurnRendering';
import HighlightedCode from '../HighlightedCode.vue';
import { pathRelativeTo } from '../../lib/pathRelativeTo';

const props = defineProps<{
  change: TurnFileChange;
  cwd?: string;
  closable?: boolean;
}>();

const emit = defineEmits<{ close: []; openFile: [path: string] }>();

const { t } = useI18n();

// The header path: workspace-relative when under the cwd (short and
// self-locating); an external file keeps its absolute path but tail-truncated
// so a long one can't wrap the header to two rows.
const displayPath = computed(() => {
  const relative = props.cwd ? pathRelativeTo(props.change.path, props.cwd) : null;
  return truncatePath(relative ?? props.change.path);
});

function truncatePath(path: string, maxLen = 48): string {
  if (!path || path.length <= maxLen) return path;
  return '…' + path.slice(path.length - maxLen + 1);
}

const hasDiff = computed(() => props.change.diff !== null && props.change.diff.length > 0);
</script>

<template>
  <div class="td">
    <PanelHeader
      :title="t('conversation.turnFiles.diffTitle')"
      :closable="closable"
      :close-label="t('filePreview.close')"
      @close="emit('close')"
    >
      <Tooltip :text="change.path">
        <span class="td-path">{{ displayPath }}</span>
      </Tooltip>
      <IconButton size="sm" :label="t('conversation.turnFiles.openFile')" @click="emit('openFile', change.path)"><Icon name="external-link" size="md" /></IconButton>
    </PanelHeader>

    <div class="td-body">
      <HighlightedCode v-if="hasDiff" :lines="change.diff!" :path="change.path" :framed="false" />
      <div v-else class="td-empty">
        <p>{{ t('conversation.turnFiles.diffUnavailable') }}</p>
        <Button variant="ghost" size="sm" @click="emit('openFile', change.path)">{{ t('conversation.turnFiles.openFile') }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.td {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.td-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--ui-c1) var(--font-mono);
  color: var(--color-text-muted);
}
.td-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
