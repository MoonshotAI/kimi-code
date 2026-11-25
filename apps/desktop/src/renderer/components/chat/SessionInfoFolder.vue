<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import { basename, summarizeGitStatus } from '@moonshot-ai/app-core/lib';
import type { SessionFolderInfoRow } from '@moonshot-ai/app-client/stores';
import {
  SessionInfoPopover,
  SessionPullRequestState,
  SessionWorktreeIcon,
  pullRequestIcon,
  shortenHomePath,
  type SessionWorktreeDisplay,
} from '@moonshot-ai/app-components/support';

const props = withDefaults(defineProps<{
  row: SessionFolderInfoRow;
  worktree?: SessionWorktreeDisplay | null;
  home?: string | null;
  label?: string | null;
  refreshing?: boolean;
}>(), {
  worktree: null,
  home: null,
  label: null,
  refreshing: false,
});

const emit = defineEmits<{
  openPr: [url: string];
  openDiff: [root: string];
  retry: [];
}>();

const { t } = useI18n();
const name = computed(() => props.label ?? basename(props.row.path));
const displayPath = computed(() => shortenHomePath(props.row.path, props.home));
const expanded = ref(props.row.primary);
watch(() => props.row.path, () => {
  expanded.value = props.row.primary;
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

const ownWorktree = computed(() => (props.row.primary ? props.worktree : null));
const missing = computed(() => props.row.state.status === 'missing' || ownWorktree.value?.missing === true);
const loading = computed(() => props.row.state.status === 'loading');
const git = computed(() =>
  props.row.state.status === 'ready' && !missing.value ? summarizeGitStatus(props.row.state.value) : null,
);
const branchLabel = computed(() => {
  if (missing.value) return ownWorktree.value?.branch ?? '';
  if (git.value === null) return '';
  if (!git.value.detached) return git.value.branch || t('header.detached');
  return git.value.shortHead === null
    ? t('header.detached')
    : t('worktreeSession.detachedHead', { sha: git.value.shortHead });
});
const lineCounts = computed(() =>
  git.value !== null && git.value.statsError === null && (git.value.additions > 0 || git.value.deletions > 0),
);
const SLOW_STATUS_MS = 400;
const statusSlow = ref(false);
watch(
  () => loading.value || props.row.statusLoading === true,
  (pending, _previous, onCleanup) => {
    statusSlow.value = false;
    if (!pending) return;
    const timer = setTimeout(() => {
      statusSlow.value = true;
    }, SLOW_STATUS_MS);
    onCleanup(() => clearTimeout(timer));
  },
  { immediate: true },
);
const changesLabel = computed(() => {
  if (git.value === null) return t('header.sessionInfoNoChanges');
  if (git.value.statsError !== null || git.value.hasChanges) return t('header.sessionInfoChanges');
  return t('header.sessionInfoNoChanges');
});
const pr = computed(() => git.value?.pullRequest ?? null);
const prFailed = computed(() => git.value?.pullRequestDisplay === 'failed');
const prPending = computed(
  () => loading.value || (git.value !== null && props.row.pullRequestLoading === true && pr.value === null && !prFailed.value),
);

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
watch(branchLabel, () => updateBranchTruncated(branchLine.value ?? null), { flush: 'post' });
const branchTooltip = computed(() => {
  if (git.value?.detached === true) return t('worktreeSession.detachedTooltip');
  return branchTruncated.value ? branchLabel.value : null;
});
</script>

<template>
  <section class="sif" :class="{ 'is-missing': missing }" :data-folder="row.path">
    <div class="sif-head">
      <button class="sif-heading si-heading" type="button" :aria-expanded="expanded" @click="toggleExpanded">
        <span class="sif-name" :title="name">{{ name }}</span>
        <Badge v-if="row.primary" class="sif-primary" size="sm" variant="soft">{{ t('worktreeSession.mainDirectory') }}</Badge>
        <Icon class="sif-chevron" :class="{ collapsed: !expanded }" name="chevron-down" size="sm" />
      </button>
      <span v-if="$slots['heading-action']" class="sif-head-action">
        <slot name="heading-action" />
      </span>
    </div>

    <div v-if="expanded" class="sif-body">
      <div class="sif-line sif-path-line">
        <span class="sif-ico"><Icon name="folder" size="md" /></span>
        <span class="sif-path" :class="{ struck: missing }" :title="row.path">{{ displayPath }}</span>
      </div>

      <template v-if="missing">
        <div class="sif-line sif-missing" role="status">
          <span class="sif-ico">
            <SessionWorktreeIcon v-if="ownWorktree" size="md" />
            <Icon v-else name="alert-triangle" size="md" />
          </span>
          <span>{{ t(ownWorktree ? 'worktreeSession.worktreeMissing' : 'worktreeSession.directoryMissing') }}</span>
        </div>
        <div v-if="branchLabel" class="sif-line sif-branch-line">
          <span class="sif-ico"><Icon name="worktree-branch" size="md" /></span>
          <span class="sif-branch">{{ branchLabel }}</span>
        </div>
      </template>

      <div v-else-if="row.state.status === 'error'" class="sif-line sif-error" role="status">
        <span class="sif-ico"><Icon name="info" size="md" /></span>
        <span>{{ t('worktreeSession.loadFailed') }}</span>
      </div>

      <div v-else-if="row.state.status === 'non-git'" class="sif-line sif-state">
        <span class="sif-ico"><Icon name="info" size="md" /></span>
        <span>{{ t('header.sessionInfoNonGit') }}</span>
      </div>

      <template v-else>
        <div v-if="ownWorktree?.base" class="sif-line sif-created">
          <span class="sif-ico"><SessionWorktreeIcon size="md" :remote="ownWorktree.base.remote" /></span>
          <span class="sif-created-text">{{ t('worktreeSession.createdFrom', { ref: ownWorktree.base.ref }) }}</span>
        </div>

        <div ref="branchLine" class="sif-line sif-branch-line">
          <span class="sif-ico"><Icon name="worktree-branch" size="md" /></span>
          <span v-if="git === null" class="sif-placeholder">-</span>
          <template v-else>
            <Tooltip v-if="branchTooltip" :text="branchTooltip">
              <span class="sif-branch" :class="{ detached: git.detached }">{{ branchLabel }}</span>
            </Tooltip>
            <span v-else class="sif-branch">{{ branchLabel }}</span>
            <span v-if="git.notPushed" class="sif-not-pushed">{{ t('worktreeSession.notPushed') }}</span>
            <span v-else-if="git.ahead > 0 || git.behind > 0" class="sif-sync">
              <span v-if="git.ahead > 0" class="sif-ahead">↑{{ git.ahead }}</span>
              <span v-if="git.behind > 0" class="sif-behind">↓{{ git.behind }}</span>
            </span>
          </template>
        </div>

        <div class="sif-row">
          <button type="button" class="sif-line sif-action sif-diff-button" @click="emit('openDiff', row.path)">
            <span class="sif-ico"><Icon name="file-diff" size="md" /></span>
            <span v-if="git === null" class="sif-placeholder">-</span>
            <span v-else class="sif-changes">{{ changesLabel }}</span>
            <span v-if="git?.statsError != null" class="sif-placeholder sif-stats-failed">—</span>
            <span v-else-if="git !== null && lineCounts" class="sif-diff">
              <span class="sif-add">+{{ git.additions }}</span>
              <span class="sif-del">−{{ git.deletions }}</span>
            </span>
            <Spinner v-if="statusSlow" class="sif-changes-loading" size="xs" :label="t('header.sessionInfoLoading')" />
          </button>
          <SessionInfoPopover
            v-if="git?.statsError != null"
            class="sif-stats-error"
            :title="t('worktreeSession.statsErrorTitle')"
            :body="t('worktreeSession.statsErrorBody')"
            :output="git.statsError"
            :busy="refreshing"
            @retry="emit('retry')"
          />
        </div>

        <div v-if="prFailed" class="sif-row">
          <div class="sif-line sif-pr-failed">
            <span class="sif-ico"><Icon name="git-pull-request" size="md" /></span>
            <span class="sif-pr-number">PR</span>
            <span class="sif-placeholder">—</span>
          </div>
          <SessionInfoPopover
            class="sif-pr-error"
            :title="t('worktreeSession.prErrorTitle')"
            :body="t('worktreeSession.prErrorBody')"
            :output="git?.pullRequestError ?? ''"
            :busy="refreshing"
            @retry="emit('retry')"
          />
        </div>
        <Tooltip v-else-if="pr" :text="t('header.openPr')">
          <button
            type="button"
            class="sif-line sif-action sif-pr"
            @click="emit('openPr', pr.url)"
          >
            <span class="sif-ico"><Icon :name="pullRequestIcon(pr.state)" size="md" /></span>
            <span class="sif-pr-number">PR #{{ pr.number }}</span>
            <SessionPullRequestState class="sif-pr-state" :state="pr.state" />
          </button>
        </Tooltip>
        <div v-else-if="prPending" class="sif-line sif-pr-pending">
          <span class="sif-ico"><Icon name="git-pull-request" size="md" /></span>
          <span class="sif-placeholder">-</span>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped src="./session-info-heading.css"></style>
<style scoped>
.sif { padding: 0 var(--space-4); }
.sif + .sif { margin-top: var(--space-3); }
.sif-head { min-width: 0; min-height: 32px; display: flex; align-items: center; gap: var(--space-2); }
.sif-heading { flex: 0 1 auto; }
.sif-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-weight: var(--weight-medium); }
.sif-chevron { flex: none; color: var(--color-text-faint); transition: transform var(--duration-fast) var(--ease-out); }
.sif-chevron.collapsed { transform: rotate(-90deg); }
.sif-primary { flex: none; }
.sif-head-action { flex: none; display: inline-flex; align-items: center; margin-left: auto; }
.sif-body { display: grid; gap: 0; }
.sif-row { min-width: 0; display: flex; align-items: center; gap: var(--space-2); }
.sif-row > .sif-line { flex: 1; }
.sif-line { min-width: 0; min-height: 32px; display: flex; align-items: center; gap: var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); }
.sif-ico { flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); background: var(--color-well); color: var(--color-text-muted); }
.sif-line > .ui-tip { flex: 0 1 auto; min-width: 0; }
.sif-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); user-select: text; }
.sif-path.struck { text-decoration: line-through; color: var(--color-text-faint); }
.sif-missing,
.sif-missing .sif-ico { color: var(--color-warning); }
.sif-state { color: var(--color-text-faint); }
.sif-error { color: var(--color-danger); }
.sif-created-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sif-placeholder { flex: none; color: var(--color-text-faint); font-family: var(--font-mono); }
.sif-action { min-height: 28px; margin: var(--space-05) calc(-1 * var(--space-2)); padding: 0 var(--space-2); border: 0; border-radius: var(--radius-md); background: transparent; text-align: left; cursor: pointer; }
.sif-body > .sif-action { width: calc(100% + var(--space-4)); }
.sif-row > .sif-action { margin-right: 0; }
.sif-row > .sif-action:last-child { margin-right: calc(-1 * var(--space-2)); }
.sif-action:hover { background: var(--color-hover); }
.sif-action:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sif-branch { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.sif-not-pushed { flex: none; color: var(--color-text-faint); }
.sif-sync { flex: none; display: inline-flex; gap: var(--space-2); font-family: var(--font-mono); }
.sif-ahead { color: var(--color-warning); }
.sif-behind { color: var(--color-accent-hover); }
.sif-changes { flex: none; }
.sif-diff { flex: none; display: inline-flex; gap: var(--space-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.sif-changes-loading { flex: none; color: var(--color-text-faint); }
.sif-add { color: var(--color-diff-add-fg); }
.sif-del { color: var(--color-diff-del-fg); }
.sif-pr-number { flex: none; font-family: var(--font-mono); }
</style>
