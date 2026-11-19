<script setup lang="ts">
import { useHistoryState } from './historyState';
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Card, Icon } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { TurnFileChange } from '@moonshot-ai/app-components';
import { basename } from '@moonshot-ai/app-core/lib';
import { pathRelativeTo } from '@moonshot-ai/app-core/lib';

const props = withDefaults(
  defineProps<{
    changes: TurnFileChange[];
    turnId: string;
    daemonTurnId?: number;
    sessionId?: string;
    cwd?: string;
    interactive?: boolean;
  }>(),
  { interactive: true },
);

const panelApi = inject(panelApiKey);

const { t } = useI18n();
const interactive = computed(() => props.interactive !== false);

const PREVIEW_COUNT = 3;

const title = computed(() => {
  const n = props.changes.length;
  const key = n === 1 ? 'conversation.turnFiles.titleOne' : 'conversation.turnFiles.titleOther';
  return t(key, { number: n });
});

const anyUncountable = computed(() => props.changes.some((c) => c.binary === true || c.oversize === true));
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
  () => !anyUncountable.value && (totals.value.added > 0 || totals.value.removed > 0),
);

const expanded = useHistoryState('files:expanded', false);
const visibleRows = computed(() => {
  const changes = expanded.value ? props.changes : props.changes.slice(0, PREVIEW_COUNT);
  return changes.map((change) => ({
    change,
    stats: rowStats(change),
    dir: dirOf(change.path),
    base: baseOf(change.path),
  }));
});
const hiddenCount = computed(() => Math.max(0, props.changes.length - PREVIEW_COUNT));
const showMoreRow = computed(() => props.changes.length > PREVIEW_COUNT);
const moreLabel = computed(() =>
  expanded.value
    ? t('conversation.turnFiles.showLess')
    : hiddenCount.value === 1
      ? t('conversation.turnFiles.moreOne')
      : t('conversation.turnFiles.more', { number: hiddenCount.value }),
);

function displayPath(path: string): string {
  const relative = props.cwd ? pathRelativeTo(path, props.cwd) : null;
  if (relative !== null) return relative || basename(path);
  return path.replace(/\\/g, '/');
}

function dirOf(path: string): string {
  const disp = displayPath(path);
  const idx = Math.max(disp.lastIndexOf('/'), disp.lastIndexOf('\\'));
  return idx > 0 ? disp.slice(0, idx) : '';
}

function baseOf(path: string): string {
  const disp = displayPath(path);
  const idx = Math.max(disp.lastIndexOf('/'), disp.lastIndexOf('\\'));
  return idx >= 0 ? disp.slice(idx + 1) : disp;
}

function rowStats(change: TurnFileChange): { added: number; removed: number } | null {
  if (change.added === 0 && change.removed === 0) return null;
  return { added: change.added, removed: change.removed };
}

function openChange(change: TurnFileChange): void {
  panelApi?.openTurnDiff({
    turnId: props.turnId,
    daemonTurnId: props.daemonTurnId,
    sessionId: props.sessionId,
    cwd: props.cwd,
    change,
  });
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
        <li v-for="row in visibleRows" :key="row.change.path" class="tf-row">
          <component
            :is="interactive ? 'button' : 'span'"
            class="tf-file"
            :type="interactive ? 'button' : undefined"
            :aria-label="interactive ? displayPath(row.change.path) : undefined"
            :data-file-path="row.change.path"
            :data-file-deleted="row.change.status === 'deleted' ? '' : undefined"
            @click="interactive && openChange(row.change)"
          ><span class="tf-base">{{ row.base }}</span><span v-if="row.dir" class="tf-dir">{{ row.dir }}</span></component>
          <span v-if="row.stats" class="tf-stats">
            <span v-if="row.stats.added > 0" class="tf-add">+{{ row.stats.added }}</span>
            <span v-if="row.stats.removed > 0" class="tf-del">−{{ row.stats.removed }}</span>
          </span>
        </li>
      </ul>

      <template v-if="showMoreRow" #foot>
        <button type="button" class="tf-more" :aria-expanded="expanded" @click="expanded = !expanded">
          {{ moreLabel }}
          <Icon class="tf-more-car" :class="{ open: expanded }" name="chevron-down" size="sm" aria-hidden="true" />
        </button>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.turn-files {
  margin-top: var(--chat-block-gap);
}

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
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-1) 0;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}

.tf-file {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
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
button.tf-file:hover .tf-base,
button.tf-file:hover .tf-dir {
  text-decoration: underline;
  text-decoration-color: var(--color-text-faint);
  text-underline-offset: 3px;
}
.tf-file:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tf-dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  color: var(--color-text-faint);
}
.tf-dir::before,
.tf-dir::after {
  content: '\200E';
}
.tf-base {
  flex: none;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.tf-more {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  height: 30px;
  padding: 0 var(--space-3);
  border: none;
  background: none;
  color: inherit;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  justify-content: flex-start;
}
.tf-more:hover { background: var(--color-hover); }
.tf-more:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.tf-more-car {
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.tf-more-car.open {
  transform: rotate(180deg);
}

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
