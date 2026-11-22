<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Checkbox, Icon, IconButton, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import { WORKTREE_DISK_REMINDER_THRESHOLD_BYTES } from '@moonshot-ai/app-core/lib';
import { useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import { formatWorktreeSize, worktreeManageRow, type WorktreeManageRow } from '@moonshot-ai/app-client/lib';
import { worktreesStore } from '@moonshot-ai/app-client/stores';
import ManageWorktreeRow from '../worktree/ManageWorktreeRow.vue';

const emit = defineEmits<{
  openSession: [sessionId: string];
}>();

const { t } = useI18n();
const store = worktreesStore();
const { deleteDialog, deleteRequestPending, requestWorktreeDeletion } = useWorktreeManageDialogs();

interface GroupView {
  key: string;
  name: string;
  summary: string;
  rows: WorktreeManageRow[];
  deletable: string[];
}

const collapsed = reactive(new Set<string>());
const batchMode = ref(false);
const selected = reactive(new Set<string>());
const outputPath = ref<string | null>(null);
const viewedFailures = new Set<string>();

const groups = computed<GroupView[]>(() =>
  store.groups.map((group) => {
    const rows = group.items.map((item) =>
      worktreeManageRow(item, store.removalFor(item.path), store.deletedSessionTitles[item.path]),
    );
    const size = formatWorktreeSize(group.sizeBytes);
    const count = t('worktreeManage.projectSummary', { n: rows.length });
    return {
      key: group.key,
      name: group.name,
      summary: size === '' ? count : `${count} · ${size}`,
      rows,
      deletable: rows.filter((row) => row.deletable).map((row) => row.path),
    };
  }),
);

const deletablePaths = computed(() => new Set(groups.value.flatMap((group) => group.deletable)));
const selectedPaths = computed(() => [...selected].filter((path) => deletablePaths.value.has(path)));

const reminder = computed(
  () => store.totalSizeBytes !== undefined && store.totalSizeBytes >= WORKTREE_DISK_REMINDER_THRESHOLD_BYTES,
);

const totalText = computed(() => {
  const size = formatWorktreeSize(store.totalSizeBytes);
  if (size === '') return '';
  return t(reminder.value ? 'worktreeManage.totalReminder' : 'worktreeManage.total', { size });
});

function toggleIn(set: Set<string>, key: string): void {
  if (!set.delete(key)) set.add(key);
}

function isExpanded(key: string): boolean {
  return !collapsed.has(key);
}

function groupSelected(group: GroupView): boolean {
  return group.deletable.length > 0 && group.deletable.every((path) => selected.has(path));
}

function toggleGroupSelection(group: GroupView): void {
  const select = !groupSelected(group);
  for (const path of group.deletable) {
    if (select) selected.add(path);
    else selected.delete(path);
  }
}

function exitBatch(): void {
  batchMode.value = false;
  selected.clear();
}

function requestDelete(paths: string[]): void {
  if (paths.length === 0 || deleteRequestPending.value) return;
  void requestWorktreeDeletion(paths);
}

function toggleOutput(path: string): void {
  outputPath.value = outputPath.value === path ? null : path;
}

function refresh(): void {
  if (store.refreshingSizes) return;
  void store.refreshSizes();
}

watch(
  () => deleteDialog.value?.kind === 'worktrees' && deleteDialog.value.phase === 'progress',
  (started) => {
    if (started) exitBatch();
  },
);

watch(
  [groups, collapsed],
  ([current]) => {
    for (const group of current) {
      if (!isExpanded(group.key)) continue;
      for (const row of group.rows) if (row.status === 'failed') viewedFailures.add(row.path);
    }
  },
  { immediate: true },
);

watch(
  () => store.totalSizeBytes,
  () => store.markDiskUsageReminded(),
);

onMounted(() => {
  void (store.loaded ? store.load() : store.ensureLoaded()).then(() => store.markDiskUsageReminded());
});

onBeforeUnmount(() => {
  if (viewedFailures.size > 0) store.dismissRemovals([...viewedFailures], ['failed']);
});
</script>

<template>
  <div class="worktrees-panel">
    <header class="wtp-head">
      <div class="wtp-heading">
        <h4 class="wtp-title">{{ t('worktreeManage.title') }}</h4>
        <p v-if="totalText" class="wtp-total" :class="{ 'is-reminder': reminder }">
          <Icon v-if="reminder" name="alert-triangle" size="sm" />
          <span>{{ totalText }}</span>
        </p>
      </div>
      <div class="wtp-actions">
        <template v-if="batchMode">
          <span class="wtp-selected">{{ t('worktreeManage.selectedCount', { n: selectedPaths.length }) }}</span>
          <Button class="wtp-batch-cancel" variant="ghost" size="sm" @click="exitBatch">
            {{ t('worktreeManage.cancelBatch') }}
          </Button>
          <Button
            class="wtp-batch-delete"
            variant="danger"
            size="sm"
            icon="trash"
            :disabled="selectedPaths.length === 0 || deleteRequestPending"
            @click="requestDelete(selectedPaths)"
          >
            {{ t('worktreeManage.deleteSelected') }}
          </Button>
        </template>
        <template v-else>
          <Tooltip :text="t('worktreeManage.batchDeleteTip', { n: deletablePaths.size })">
            <Button
              class="wtp-batch"
              variant="danger"
              size="sm"
              :disabled="deletablePaths.size === 0"
              @click="batchMode = true"
            >
              {{ t('worktreeManage.batchDelete') }}
            </Button>
          </Tooltip>
          <IconButton
            class="wtp-refresh"
            :label="t('worktreeManage.refresh')"
            :tooltip="t('worktreeManage.refresh')"
            :disabled="store.refreshingSizes"
            @click="refresh"
          >
            <Spinner v-if="store.refreshingSizes" size="sm" />
            <Icon v-else name="refresh" size="md" />
          </IconButton>
        </template>
      </div>
    </header>

    <div v-if="!store.loaded && store.loadError !== null" class="wtp-state">
      <span>{{ t('worktreeManage.loadFailed') }}</span>
      <Button variant="secondary" size="sm" @click="store.load()">{{ t('worktreeManage.retryLoad') }}</Button>
    </div>
    <div v-else-if="!store.loaded" class="wtp-state">{{ t('worktreeManage.loading') }}</div>
    <div v-else-if="groups.length === 0" class="wtp-state">{{ t('worktreeManage.empty') }}</div>

    <section v-for="group in groups" :key="group.key" class="wtp-card">
      <div class="wtp-card-head">
        <span v-if="batchMode" class="wtp-card-check">
          <Checkbox
            :model-value="groupSelected(group)"
            :disabled="group.deletable.length === 0"
            :aria-label="t('worktreeManage.selectProject', { project: group.name })"
            @update:model-value="toggleGroupSelection(group)"
          />
        </span>
        <button type="button" class="wtp-card-toggle" :aria-expanded="isExpanded(group.key)" @click="toggleIn(collapsed, group.key)">
          <span class="wtp-card-name">{{ group.name }}</span>
          <span class="wtp-card-summary">{{ group.summary }}</span>
          <Icon class="wtp-card-chevron" :class="{ 'is-expanded': isExpanded(group.key) }" name="chevron-right" size="md" />
        </button>
      </div>
      <Transition name="wtp-collapse">
        <div v-if="isExpanded(group.key)" class="wtp-card-body">
          <ManageWorktreeRow
            v-for="row in group.rows"
            :key="row.path"
            :row="row"
            :batch-mode="batchMode"
            :selected="selected.has(row.path)"
            :output-open="outputPath === row.path"
            :pending="deleteRequestPending"
            @toggle-select="toggleIn(selected, row.path)"
            @open-session="emit('openSession', $event)"
            @delete="requestDelete([row.path])"
            @toggle-output="toggleOutput(row.path)"
          />
        </div>
      </Transition>
    </section>
  </div>
</template>

<style scoped>
.worktrees-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.wtp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.wtp-heading { min-width: 0; }
.wtp-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.wtp-total {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
.wtp-total.is-reminder svg {
  flex: none;
  color: var(--color-warning);
}
.wtp-actions {
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--space-2);
}
.wtp-selected {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.wtp-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--color-surface);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.wtp-card {
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface);
  overflow: hidden;
}
.wtp-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-4);
}
.wtp-card-check {
  display: inline-flex;
  flex: none;
}
.wtp-card-toggle {
  display: flex;
  align-items: center;
  flex: 1;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3) 0;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  color: var(--color-text-faint);
  cursor: pointer;
}
.wtp-card-toggle:focus-visible {
  outline: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--p-focus-ring);
}
.wtp-card-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--color-text);
}
.wtp-card-summary {
  flex: none;
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.wtp-card-chevron {
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.wtp-card-chevron.is-expanded { transform: rotate(90deg); }
.wtp-card-body {
  overflow: hidden;
  interpolate-size: allow-keywords;
}
.wtp-collapse-enter-active,
.wtp-collapse-leave-active {
  transition:
    block-size var(--duration-base) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out);
}
.wtp-collapse-enter-from,
.wtp-collapse-leave-to {
  block-size: 0;
  opacity: 0;
}
</style>
