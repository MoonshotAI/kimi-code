<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, Skeleton, Tooltip } from '@moonshot-ai/app-ui';
import { basename } from '@moonshot-ai/app-core/lib';
import type { SessionFolderInfoRow } from '@moonshot-ai/app-client/stores';

const props = withDefaults(defineProps<{
  row: SessionFolderInfoRow;
  showPrimaryBadge?: boolean;
}>(), {
  showPrimaryBadge: false,
});

const emit = defineEmits<{
  openPr: [url: string];
  openDiff: [root: string];
}>();

const { t } = useI18n();
const name = computed(() => basename(props.row.path));
const expanded = ref(props.row.primary);
watch(() => props.row.path, () => {
  expanded.value = props.row.primary;
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

const git = computed(() => props.row.state.status === 'ready' ? props.row.state.value : null);
const pr = computed(() => git.value?.pullRequest ?? null);
const branchLine = ref<HTMLElement>();
const branchTruncated = ref(false);
function updateBranchTruncated(element: HTMLElement | null): void {
  const branch = element?.querySelector('.sif-branch');
  branchTruncated.value = branch !== null && branch !== undefined && branch.scrollWidth > branch.clientWidth;
}
watch(branchLine, (element, _previous, onCleanup) => {
  updateBranchTruncated(element ?? null);
  if (!element || typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => updateBranchTruncated(element));
  observer.observe(element);
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });
watch(() => git.value?.branch, () => updateBranchTruncated(branchLine.value ?? null), { flush: 'post' });
const PR_STATE_LABELS: Record<string, string> = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
  draft: 'Draft',
};

function normalizedPrState(state: string): string {
  return state.trim().toLowerCase().replaceAll('_', '-');
}

function prStateClass(state: string): string {
  const normalized = normalizedPrState(state);
  return PR_STATE_LABELS[normalized] ? `pr-${normalized}` : 'pr-unknown';
}

function prStateLabel(state: string): string {
  return PR_STATE_LABELS[normalizedPrState(state)] ?? 'Unknown';
}
</script>

<template>
  <section class="sif" :data-folder="row.path">
    <button class="sif-heading" type="button" :aria-expanded="expanded" @click="toggleExpanded">
      <span class="sif-name" :title="name">{{ name }}</span>
      <Badge v-if="row.primary && showPrimaryBadge" class="sif-primary" size="sm" variant="soft">{{ t('header.sessionInfoPrimary') }}</Badge>
      <Icon class="sif-chevron" :class="{ collapsed: !expanded }" name="chevron-down" size="sm" />
    </button>

    <template v-if="expanded">
      <div v-if="row.state.status === 'loading'" class="sif-loading" role="status">
        <div class="sif-skeleton">
          <Skeleton height="6px" />
          <Skeleton width="80%" height="6px" />
          <Skeleton width="60%" height="6px" />
        </div>
        <span class="sif-loading-label">{{ t('header.sessionInfoLoading') }}</span>
      </div>
      <div v-else-if="row.state.status === 'error'" class="sif-state sif-error" role="status">
        <Icon name="info" size="md" />
        <span>{{ t('header.sessionInfoLoadFailed') }}</span>
      </div>
      <div v-else-if="row.state.status === 'non-git'" class="sif-state">
        <Icon name="folder" size="md" />
        <span>{{ t('header.sessionInfoNonGit') }}</span>
      </div>

      <div v-else-if="git" class="sif-git">
        <div ref="branchLine" class="sif-line sif-branch-line">
          <Icon name="git-fork" size="md" />
          <Tooltip v-if="branchTruncated" :text="git.branch">
            <span class="sif-branch">{{ git.branch || t('header.detached') }}</span>
          </Tooltip>
          <span v-else class="sif-branch">{{ git.branch || t('header.detached') }}</span>
          <span v-if="git.ahead > 0 || git.behind > 0" class="sif-sync">
            <span v-if="git.ahead > 0" class="sif-ahead">↑{{ git.ahead }}</span>
            <span v-if="git.behind > 0" class="sif-behind">↓{{ git.behind }}</span>
          </span>
        </div>
        <button type="button" class="sif-line sif-action sif-diff-button" @click="emit('openDiff', row.path)">
          <Icon name="file-diff" size="md" />
          <span class="sif-changes">{{ git.additions === 0 && git.deletions === 0 ? t('header.sessionInfoNoChanges') : t('header.sessionInfoChanges') }}</span>
          <span v-if="git.additions !== 0 || git.deletions !== 0" class="sif-diff">
            <span class="sif-add">+{{ git.additions }}</span>
            <span class="sif-del">-{{ git.deletions }}</span>
          </span>
        </button>
        <button
          v-if="pr"
          type="button"
          class="sif-line sif-action sif-pr"
          :title="t('header.openPr')"
          @click="emit('openPr', pr.url)"
        >
          <Icon :name="pr.state === 'merged' ? 'git-merge' : 'git-pull-request'" size="md" />
          <span class="sif-pr-number">PR #{{ pr.number }}</span>
          <span class="sif-pr-state" :class="prStateClass(pr.state)">{{ prStateLabel(pr.state) }}</span>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sif { padding: 0 var(--space-4); }
.sif + .sif { margin-top: var(--space-3); }
.sif-heading {
  width: 100%;
  min-width: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}
.sif-heading:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sif-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-weight: var(--weight-medium); }
.sif-chevron { flex: none; color: var(--color-text-faint); transition: transform var(--duration-fast) var(--ease-out); }
.sif-chevron.collapsed { transform: rotate(-90deg); }
.sif-primary { flex: none; }
.sif-loading { padding: var(--space-1) 0 var(--space-3); }
.sif-skeleton { display: grid; gap: var(--space-2); }
.sif-skeleton :deep(.ui-skeleton) { background: var(--color-surface); }
.sif-loading-label { display: block; margin-top: var(--space-2); color: var(--color-text-faint); font-size: var(--text-xs); }
.sif-state { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; color: var(--color-text-faint); font-size: var(--text-xs); }
.sif-state > .kw-icon { flex: none; }
.sif-error { color: var(--color-danger); }
.sif-git { display: grid; gap: 0; }
.sif-line { min-width: 0; min-height: 32px; display: flex; align-items: center; gap: var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); }
.sif-line > .kw-icon { flex: none; color: var(--color-text-faint); }
.sif-line > .ui-tip { flex: 1; min-width: 0; }
.sif-branch-line { width: calc(100% + var(--space-4)); min-height: 28px; margin: var(--space-05) calc(-1 * var(--space-2)); padding: 0 var(--space-2); border-radius: var(--radius-md); }
.sif-branch-line:hover { background: var(--color-hover); }
.sif-action { width: calc(100% + var(--space-4)); min-height: 28px; margin: var(--space-05) calc(-1 * var(--space-2)); padding: 0 var(--space-2); border: 0; border-radius: var(--radius-md); background: transparent; text-align: left; cursor: pointer; }
.sif-action:hover { background: var(--color-hover); }
.sif-action:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sif-branch { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.sif-sync { flex: none; display: inline-flex; gap: var(--space-2); font-family: var(--font-mono); }
.sif-ahead { color: var(--color-warning); }
.sif-behind { color: var(--color-accent-hover); }
.sif-changes { flex: 1; color: var(--color-text); }
.sif-diff { flex: none; display: inline-flex; gap: var(--space-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.sif-add { color: var(--color-diff-add-fg); }
.sif-del { color: var(--color-diff-del-fg); }
.sif-pr-number { flex: 1; font-family: var(--font-mono); }
.sif-pr-state { flex: none; padding: 0 var(--space-1-5); border: var(--p-hairline) solid transparent; border-radius: var(--radius-full); font-size: 11px; line-height: 16px; }
.sif-pr-state.pr-open { color: var(--color-success); background: var(--color-success-soft); border-color: var(--color-success-bd); }
.sif-pr-state.pr-merged { color: var(--color-done); background: var(--color-done-soft); border-color: var(--color-done-bd); }
.sif-pr-state.pr-closed { color: var(--color-danger); background: var(--color-danger-soft); border-color: var(--color-danger-bd); }
.sif-pr-state.pr-draft,
.sif-pr-state.pr-unknown { color: var(--color-text-muted); background: var(--color-well); border-color: var(--color-line); }
</style>
