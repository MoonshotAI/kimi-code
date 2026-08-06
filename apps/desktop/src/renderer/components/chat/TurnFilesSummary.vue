<!-- apps/web/src/components/chat/TurnFilesSummary.vue -->
<!-- A settled turn's file-change summary card, between its final text and footer. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Card, Icon } from '@moonshot-ai/web-ui';
import type { TurnFileChange } from '../chatTurnRendering';
import type { FilePreviewRequest } from '../../types';
import { basename } from '../../lib/pathBasename';
import { pathRelativeTo } from '../../lib/pathRelativeTo';

const props = withDefaults(
  defineProps<{
    changes: TurnFileChange[];
    cwd?: string;
    /** False where nothing handles the row action (e.g. the BTW side chat) —
        file rows then render as plain text instead of links. */
    interactive?: boolean;
  }>(),
  { interactive: true },
);

const emit = defineEmits<{
  openDiff: [change: TurnFileChange];
  openFile: [target: FilePreviewRequest];
}>();

const { t } = useI18n();
const interactive = computed(() => props.interactive !== false);

// How many files show before the rest collapse behind a "N more files" row.
const PREVIEW_COUNT = 3;

const title = computed(() => {
  const n = props.changes.length;
  const key = n === 1 ? 'conversation.turnFiles.titleOne' : 'conversation.turnFiles.titleOther';
  return t(key, { number: n });
});

// Aggregate stats are hidden whenever any row is incomplete: a partial total
// under-reports the turn, and the header must not present it as complete.
const anyIncomplete = computed(() => props.changes.some((c) => c.statsIncomplete));
const totals = computed(() => {
  let added = 0;
  let removed = 0;
  for (const c of props.changes) {
    added += c.added;
    removed += c.removed;
  }
  return { added, removed };
});
const hasTotals = computed(
  () => !anyIncomplete.value && (totals.value.added > 0 || totals.value.removed > 0),
);

const expanded = ref(false);
const visibleChanges = computed(() =>
  expanded.value ? props.changes : props.changes.slice(0, PREVIEW_COUNT),
);
const hiddenCount = computed(() => Math.max(0, props.changes.length - PREVIEW_COUNT));
const showMoreRow = computed(() => props.changes.length > PREVIEW_COUNT);
const moreLabel = computed(() =>
  expanded.value
    ? t('conversation.turnFiles.showLess')
    : hiddenCount.value === 1
      ? t('conversation.turnFiles.moreOne')
      : t('conversation.turnFiles.more', { number: hiddenCount.value }),
);

// The row's single label: the workspace-relative path when the file sits under
// the active cwd ("apps/web/src/foo.ts" — short and self-locating), else the
// absolute path (a file the turn touched outside the workspace). The full path
// stays in the tooltip.
function displayPath(path: string): string {
  const relative = props.cwd ? pathRelativeTo(path, props.cwd) : null;
  if (relative !== null) return relative || basename(path);
  return path;
}

// The display path split for the row's two-tone label: leading directories
// (muted) and the base name (the row's anchor, medium weight). Split on both
// separators so a Windows path's base name still breaks out (and stays visible).
function dirOf(path: string): string {
  const disp = displayPath(path);
  const idx = Math.max(disp.lastIndexOf('/'), disp.lastIndexOf('\\'));
  return idx > 0 ? disp.slice(0, idx + 1) : '';
}

function baseOf(path: string): string {
  const disp = displayPath(path);
  const idx = Math.max(disp.lastIndexOf('/'), disp.lastIndexOf('\\'));
  return idx >= 0 ? disp.slice(idx + 1) : disp;
}

function rowStats(change: TurnFileChange): { added: number; removed: number } | null {
  if (change.statsIncomplete) return null;
  if (change.added === 0 && change.removed === 0) return null;
  return { added: change.added, removed: change.removed };
}

function openChange(change: TurnFileChange): void {
  // A Write's whole content IS the change (no line diff to show), so it opens
  // the file itself; an Edit has a real diff.
  if (change.hasWrite) {
    emit('openFile', { path: change.path });
  } else {
    emit('openDiff', change);
  }
}
</script>

<template>
  <div class="turn-files">
    <Card>
      <template #head>
        <span class="tf-ic" aria-hidden="true"><Icon name="pencil" size="sm" /></span>
        <span class="tf-title">{{ title }}</span>
        <template v-if="hasTotals">
          <span class="tf-stats">
            <span v-if="totals.added > 0" class="tf-add">+{{ totals.added }}</span>
            <span v-if="totals.removed > 0" class="tf-del">−{{ totals.removed }}</span>
            <span class="diffbar" aria-hidden="true">
              <span class="seg-add" :style="{ flexGrow: totals.added }" />
              <span class="seg-del" :style="{ flexGrow: totals.removed }" />
            </span>
          </span>
        </template>
      </template>

      <ul class="tf-list">
        <li v-for="change in visibleChanges" :key="change.path" class="tf-row">
          <component
            :is="interactive ? 'button' : 'span'"
            class="tf-file"
            :type="interactive ? 'button' : undefined"
            @click="interactive && openChange(change)"
          ><span v-if="dirOf(change.path)" class="tf-dir">{{ dirOf(change.path) }}</span><span class="tf-base">{{ baseOf(change.path) }}</span></component>
          <span v-if="rowStats(change)" class="tf-stats">
            <span v-if="rowStats(change)!.added > 0" class="tf-add">+{{ rowStats(change)!.added }}</span>
            <span v-if="rowStats(change)!.removed > 0" class="tf-del">−{{ rowStats(change)!.removed }}</span>
          </span>
        </li>
      </ul>

      <template v-if="showMoreRow" #foot>
        <Button variant="ghost" size="sm" class="tf-more" :aria-expanded="expanded" @click="expanded = !expanded">
          {{ moreLabel }}
          <Icon class="tf-more-car" :class="{ open: expanded }" name="chevron-down" size="sm" aria-hidden="true" />
        </Button>
      </template>
    </Card>
  </div>
</template>

<style scoped>
/* Block spacing between stream items is owned by ChatPane; the summary sits
   at the same rhythm as the turn footer below it. */
.turn-files {
  margin-top: var(--chat-block-gap);
}

/* The Card head is mono/medium by default (a label style); the summary title
   is sentence text, so it returns to the UI font at regular weight. The head
   and body also pull in from the Card's roomier default padding to read as one
   compact object. */
.turn-files :deep(.ui-card__head) {
  font-family: var(--font-ui);
  font-weight: var(--weight-regular);
  padding: var(--space-2) var(--space-3);
}
.turn-files :deep(.ui-card__body) {
  padding: var(--space-1) var(--space-3);
}
.turn-files :deep(.ui-card__foot) {
  padding: 0;
  justify-content: stretch;
}

.tf-ic {
  display: inline-flex;
  align-items: center;
  color: var(--color-text-faint);
  flex: none;
}
.tf-title {
  font-size: var(--text-sm);
  color: var(--color-text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The stats cluster carries the auto margin so it reaches the right edge
   regardless of which counts are present. */
.tf-stats {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
.tf-add,
.tf-del {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  flex: none;
}
.tf-add {
  color: var(--color-success);
}
.tf-del {
  color: var(--color-danger);
}

.tf-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.tf-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-1) 0;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}

/* The row's anchor: the file link. Directories sit muted beside a medium-weight
   base name; hover underlines it lightly (no accent colour change). */
.tf-file {
  display: flex;
  align-items: baseline;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
}
button.tf-file {
  cursor: pointer;
}
button.tf-file:hover {
  text-decoration: underline;
  /* The spec's "lightly": the line rides the faint text token, not the
     full-strength label colour. */
  text-decoration-color: var(--color-text-faint);
  text-underline-offset: 3px;
}
.tf-file:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
/* The directory lead shrinks and truncates first, so the base name stays
   visible even on long nested paths. */
.tf-dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-faint);
}
.tf-base {
  flex: none;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

/* "N more files" toggle stretches the Card's foot edge to edge. */
.tf-more {
  width: 100%;
  justify-content: flex-start;
  border-radius: 0;
}
.turn-files .tf-more:not(:disabled):active {
  transform: none;
}
.tf-more-car {
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.tf-more-car.open {
  transform: rotate(180deg);
}

/* Mini add/del proportion bar — same shape as the Edit tool line's. */
.diffbar {
  display: inline-flex;
  width: 36px;
  height: 3px;
  border-radius: var(--radius-full);
  overflow: hidden;
  flex: none;
}
.seg-add {
  background: var(--color-success);
}
.seg-del {
  background: var(--color-danger);
}
</style>
