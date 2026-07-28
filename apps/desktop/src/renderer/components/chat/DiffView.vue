<!-- apps/web/src/components/chat/DiffView.vue -->
<!-- ~/diff tab: real git changes from the daemon's fs:git_status, with a
     line-by-line unified-diff view (fs:diff) when a file is tapped.
     The changed-file list can be viewed as a flat list or as a tree. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DiffViewLine } from '../../types';
import type { DiffFullTexts } from '../../lib/diffFullTexts';
import HighlightedCode from '../HighlightedCode.vue';
import { Button, Icon, PanelHeader, ScrollArea, SegmentedControl, Spinner, Tooltip } from '@moonshot-ai/web-ui';

const { t } = useI18n();

function formatFileCount(count: number): string {
  const key = count === 1 ? 'diff.fileCountOne' : 'diff.fileCountOther';
  return t(key, { number: count });
}

const props = withDefaults(
  defineProps<{
    changes: { path: string; status: string }[];
    gitInfo: { branch: string; ahead: number; behind: number } | null;
    /** Parsed unified-diff lines for the selected file (empty until tapped). */
    fileDiff?: DiffViewLine[];
    /** Full old/new texts behind the diff for full-file highlighting; null →
        HighlightedCode falls back to fragment highlighting. */
    fullTexts?: DiffFullTexts | null;
    /** True when the selected file is empty (0 bytes) — git has no line diff
        for it, so show an "empty file" state instead of "no line changes". */
    emptyFile?: boolean;
    /** The currently-open file path, or null when showing the file list. */
    selectedDiffPath?: string | null;
    /** True while the diff for the selected file is being fetched. */
    fileDiffLoading?: boolean;
    /**
     * Render mode. 'full' (default, standalone tab) switches list↔detail by
     * selectedDiffPath. In the merged ~/files tab the list and the detail live in
     * two different panes, so 'list' forces the changed-file list and 'detail'
     * forces the line-by-line view.
     */
    mode?: 'full' | 'list' | 'detail';
    /** Hide the in-panel Back button (the merged tab owns the back affordance). */
    hideBack?: boolean;
    /** Show the close button in the panel header. */
    closable?: boolean;
  }>(),
  { mode: 'full', hideBack: false, closable: true },
);

const emit = defineEmits<{
  /** Fired when the user taps a changed file → parent loads its diff. */
  open: [path: string];
  /** Fired when the user collapses the diff back to the file list. */
  back: [];
  /** Fired when the user closes the right-side panel. */
  close: [];
}>();

// Status badge: single-letter glyph + CSS class
type BadgeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'ignored' | 'clean' | 'unknown';

function badgeKind(s: string): BadgeKind {
  const lower = s.toLowerCase();
  if (lower === 'modified') return 'modified';
  if (lower === 'added') return 'added';
  if (lower === 'deleted') return 'deleted';
  if (lower === 'renamed') return 'renamed';
  if (lower === 'untracked') return 'untracked';
  if (lower === 'conflicted') return 'conflicted';
  if (lower === 'ignored') return 'ignored';
  if (lower === 'clean') return 'clean';
  return 'unknown';
}

const BADGE_GLYPH: Record<BadgeKind, string> = {
  modified: 'M',
  added: '+',
  deleted: '−',
  renamed: '→',
  untracked: '+',
  conflicted: 'C',
  ignored: 'I',
  clean: '·',
  unknown: '?',
};

function badgeGlyph(s: string): string {
  return BADGE_GLYPH[badgeKind(s)] ?? '?';
}

/**
 * Truncate a long path from the left, showing the tail.
 * e.g. "packages/agent-core/src/services/session/sessionService.ts" → "…sion/sessionService.ts"
 */
function truncateLeft(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  return '…' + path.slice(path.length - maxLen + 1);
}

const hasGitInfo = computed(() => props.gitInfo !== null);
const hasChanges = computed(() => props.changes.length > 0);

// When a file is selected we show the line-by-line panel instead of the list.
const showingDiff = computed(() => (props.selectedDiffPath ?? null) !== null);
// Which half to render: 'detail' forces the line view, 'list' forces the file
// list, 'full' decides by whether a file is selected (legacy standalone tab).
const renderDetail = computed(
  () => props.mode === 'detail' || (props.mode === 'full' && showingDiff.value),
);
const diffLines = computed<DiffViewLine[]>(() => props.fileDiff ?? []);
const loading = computed(() => props.fileDiffLoading === true);

function onOpen(path: string): void {
  emit('open', path);
}
function onBack(): void {
  emit('back');
}
function onClose(): void {
  emit('close');
}

// ---------------------------------------------------------------------------
// List / tree view toggle
// ---------------------------------------------------------------------------

type ViewMode = 'list' | 'tree';
const viewMode = ref<ViewMode>('list');

function setViewMode(mode: string): void {
  viewMode.value = mode as ViewMode;
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  status?: string;
  children: TreeNode[];
}

function buildTree(changes: { path: string; status: string }[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };
  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const isDirectoryEntry = entry.path.endsWith('/');
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isFile = i === parts.length - 1 && !isDirectoryEntry;
      const path = parts.slice(0, i + 1).join('/');
      let child = current.children.find((c) => c.name === name && c.kind === (isFile ? 'file' : 'folder'));
      if (!child) {
        child = {
          name,
          path,
          kind: isFile ? 'file' : 'folder',
          status: isFile ? entry.status : undefined,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }
  return root.children;
}

interface FlatNode {
  node: TreeNode;
  depth: number;
}

const treeRoots = computed<TreeNode[]>(() => buildTree(props.changes));
const collapsedPaths = ref<Set<string>>(new Set());

function isExpanded(path: string): boolean {
  return !collapsedPaths.value.has(path);
}

const flatTree = computed<FlatNode[]>(() => {
  const result: FlatNode[] = [];
  function walk(nodes: TreeNode[], depth: number): void {
    for (const node of nodes) {
      result.push({ node, depth });
      if (node.kind === 'folder' && isExpanded(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  }
  walk(treeRoots.value, 0);
  return result;
});

function toggleFolder(node: TreeNode): void {
  const next = new Set(collapsedPaths.value);
  if (next.has(node.path)) {
    next.delete(node.path);
  } else {
    next.add(node.path);
  }
  collapsedPaths.value = next;
}

function treePadding(depth: number): string {
  return `calc(var(--tree-base-indent) + ${depth} * var(--tree-indent-step))`;
}

function treeRowStyle(depth: number): Record<string, string> {
  return {
    paddingLeft: treePadding(depth),
    '--tree-depth': String(depth),
  };
}
</script>

<template>
  <div class="changes-pane">
    <!-- ===================== LINE-BY-LINE DIFF VIEW ===================== -->
    <template v-if="renderDetail">
      <PanelHeader
        :title="t('diff.title')"
        :closable="closable"
        :close-label="t('diff.close')"
        @close="onClose"
      >
        <Tooltip :text="selectedDiffPath ?? ''">
          <span class="dv-path">{{ truncateLeft(selectedDiffPath ?? '', 50) }}</span>
        </Tooltip>
      </PanelHeader>

      <div class="diff-head">
        <Button v-if="!hideBack" variant="ghost" size="sm" @click="onBack">
          <Icon name="arrow-left" size="sm" />
          <span class="back-label">{{ t('diff.back') }}</span>
        </Button>
      </div>

      <Transition name="diff-content" mode="out-in">
        <div v-if="loading" key="loading" class="empty-state diff-loading">
          <Spinner size="md" />
          <span>{{ t('diff.loading') }}</span>
        </div>

        <div v-else-if="diffLines.length > 0" key="lines" class="dv-lines-wrap">
          <!-- Unframed: the panel owns the edge + scroll; shiki infers the
               language from the selected file's path. -->
          <HighlightedCode :lines="diffLines" :path="selectedDiffPath ?? undefined" line-numbers :framed="false" :full-texts="fullTexts ?? null" />
        </div>

        <div v-else key="empty" class="empty-state">{{ emptyFile ? t('diff.emptyFile') : t('diff.noDiff') }}</div>
      </Transition>
    </template>

    <!-- ======================== CHANGED-FILE LIST ======================= -->
    <template v-else>
      <!-- Panel header: title, view toggle, close -->
      <PanelHeader
        :title="t('diff.title')"
        :closable="closable"
        :close-label="t('diff.close')"
        @close="onClose"
      >
        <span class="dv-change-count">{{ formatFileCount(changes.length) }}</span>
        <SegmentedControl
          :model-value="viewMode"
          size="sm"
          :options="[
            { value: 'list', label: t('diff.list'), icon: 'list' },
            { value: 'tree', label: t('diff.tree'), icon: 'tree-view' },
          ]"
          @update:model-value="setViewMode"
        />
      </PanelHeader>

      <!-- Git branch / status sub-header -->
      <div class="ch-head">
        <template v-if="hasGitInfo">
          <span class="br-heading">
            <Icon class="br-icon" name="git-fork" size="sm" />
            <span class="br-label">{{ t('diff.branch') }}</span>
          </span>
          <span class="br-name">{{ gitInfo!.branch }}</span>
          <span v-if="gitInfo!.ahead > 0 || gitInfo!.behind > 0" class="sync-info">
            <Tooltip :text="t('diff.aheadTitle')">
              <span v-if="gitInfo!.ahead > 0" class="ahead">&#8593;{{ gitInfo!.ahead }}</span>
            </Tooltip>
            <Tooltip :text="t('diff.behindTitle')">
              <span v-if="gitInfo!.behind > 0" class="behind">&#8595;{{ gitInfo!.behind }}</span>
            </Tooltip>
          </span>
        </template>
        <template v-else>
          <span class="empty-head">{{ t('diff.empty') }}</span>
        </template>
      </div>

      <!-- File list (flat) -->
      <ScrollArea v-if="hasChanges && viewMode === 'list'" class="ch-list">
        <div class="ch-list-content">
          <Tooltip
            v-for="entry in changes"
            :key="entry.path"
            :text="entry.path"
          >
            <button
              type="button"
              class="ch-row"
              @click="onOpen(entry.path)"
            >
              <span class="badge" :class="badgeKind(entry.status)">{{ badgeGlyph(entry.status) }}</span>
              <span class="fpath">{{ truncateLeft(entry.path) }}</span>
            </button>
          </Tooltip>
        </div>
      </ScrollArea>

      <!-- File tree -->
      <ScrollArea v-else-if="hasChanges && viewMode === 'tree'" class="ch-list ch-tree">
        <TransitionGroup name="tree-collapse" tag="ul" class="tree-list ch-list-content">
          <li
            v-for="{ node, depth } in flatTree"
            :key="node.path"
            class="tree-node"
          >
            <button
              v-if="node.kind === 'folder'"
              type="button"
              class="tree-row tree-folder"
              :style="treeRowStyle(depth)"
              @click="toggleFolder(node)"
            >
              <Icon class="tree-icon" name="folder-solid" size="sm" />
              <span class="tree-name">{{ node.name }}</span>
            </button>
            <Tooltip v-else :text="node.path">
              <button
                type="button"
                class="tree-row tree-file"
                :style="treeRowStyle(depth)"
                @click="onOpen(node.path)"
              >
                <span class="badge" :class="badgeKind(node.status!)">{{ badgeGlyph(node.status!) }}</span>
                <span class="tree-name">{{ node.name }}</span>
              </button>
            </Tooltip>
          </li>
        </TransitionGroup>
      </ScrollArea>

      <!-- Empty state when git info present but no changes -->
      <div v-else-if="hasGitInfo" class="empty-state">
        <span class="empty-state-icon" aria-hidden="true"><Icon name="check" size="lg" /></span>
        {{ t('diff.clean') }}
      </div>

      <!-- No git info at all -->
      <div v-else class="empty-state">
        {{ t('diff.empty') }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.changes-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  font-family: var(--mono);
}

/* ---- Panel-header middle content (path / change count) ---- */
.dv-path,
.dv-change-count {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.dv-change-count {
  flex: 1;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  font-family: var(--font-ui);
}
.dv-path {
  font-family: var(--font-ui);
}

/* ---- Branch sub-header ---- */
.ch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px var(--space-3);
  border-bottom: 0.5px solid var(--line);
  background: var(--panel);
  font-size: var(--text-base);
  color: var(--dim);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
  font-family: var(--font-ui);
  user-select: none;
}

.br-heading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}

.br-icon {
  flex: none;
  color: var(--muted);
}

.br-label {
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: 500;
}

.br-name {
  color: var(--color-text);
  font-weight: 500;
  font-size: var(--text-xs);
}

.sync-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ahead {
  color: var(--color-accent);
  font-size: var(--text-xs);
}

.behind {
  color: var(--color-warning);
  font-size: var(--text-xs);
}

.empty-head {
  color: var(--muted);
  font-size: var(--text-base);
}

/* ---- File list ---- */
.ch-list {
  flex: 1;
  min-height: 0;
}
.ch-list-content {
  min-height: 100%;
  padding: 4px 0;
}

.ch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: var(--text-xs);
  line-height: 1.6;
  /* reset button defaults so the row looks like the original div */
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  font-family: var(--font-ui);
  color: inherit;
}

.ch-row:hover {
  background: var(--panel2);
}

.ch-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

/* ---- Tree view ---- */
.ch-tree {
  --tree-base-indent: 14px;
  --tree-indent-step: 12px;
  font-family: var(--font-ui);
}
.tree-list {
  list-style: none;
  margin: 0;
}
.tree-node {
  overflow: hidden;
  interpolate-size: allow-keywords;
}
.tree-collapse-enter-active,
.tree-collapse-leave-active {
  transition:
    block-size var(--duration-base) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.tree-collapse-enter-from,
.tree-collapse-leave-to {
  block-size: 0;
  opacity: 0;
  transform: translateY(-3px);
}
.tree-collapse-enter-to,
.tree-collapse-leave-from {
  block-size: auto;
  opacity: 1;
  transform: translateY(0);
}
.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 1px;
  padding: 3px 8px;
  background: none;
  border: none;
  text-align: left;
  font-family: inherit;
  font-size: var(--text-xs);
  color: inherit;
  cursor: pointer;
}
.tree-row::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(var(--tree-base-indent) + 6px);
  width: calc(var(--tree-depth, 0) * var(--tree-indent-step));
  background: repeating-linear-gradient(
    to right,
    var(--color-line) 0 1px,
    transparent 1px var(--tree-indent-step)
  );
  pointer-events: none;
}
.tree-row:hover {
  background: var(--panel2);
}
.tree-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.tree-folder {
  color: var(--color-text);
  font-weight: 500;
}
.tree-file {
  color: var(--color-text);
  font-weight: 450;
}
.tree-icon {
  flex: none;
  color: var(--muted);
}
.tree-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- Status badge ---- */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-xs);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  font-weight: 500;
  flex: none;
  user-select: none;
}

.badge.modified  { background: var(--color-warning-soft); color: var(--color-warning); }
.badge.added     { background: var(--color-success-soft); color: var(--color-success); }
.badge.deleted   { background: var(--color-danger-soft); color: var(--color-danger); }
.badge.renamed   { background: var(--color-done-soft); color: var(--color-done); }
.badge.untracked { background: var(--color-success-soft); color: var(--color-success); }
.badge.conflicted{ background: color-mix(in srgb, var(--color-danger) 10%, var(--bg)); color: var(--color-danger); font-size: max(9px, calc(var(--ui-font-size) - 5px)); }
.badge.ignored   { background: var(--color-well); color: var(--faint); }
.badge.clean     { background: transparent; color: var(--faint); }
.badge.unknown   { background: var(--color-well); color: var(--muted); }

/* ---- File path ---- */
.fpath {
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: 450;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;   /* makes text-overflow clip from the left */
  text-align: left;
  min-width: 0;
}
/* In the rtl context above, the bidi algorithm moves boundary punctuation to
   the opposite end (".test" → "test.", ".config/" → "/config."). Sandwich the
   path in invisible LTR marks so boundary neutrals resolve as LTR. */
.fpath::before,
.fpath::after {
  content: '\200E';
}

/* ---- Empty state ---- */
.empty-state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 32px 20px;
  color: var(--muted);
  font-size: var(--ui-font-size);
  text-align: center;
  user-select: none;
}
.empty-state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--color-well);
  color: var(--color-text-muted);
}

/* =========================================================================
   LINE-BY-LINE DIFF VIEW
   ========================================================================= */
.diff-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 0.5px solid var(--line);
  background: var(--panel);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
}

/* Wrapper that lets the unframed <HighlightedCode> fill the panel height and
   scroll internally. The line-row styles live in HighlightedCode.vue. */
.dv-lines-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.diff-content-enter-active,
.diff-content-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.diff-content-enter-from,
.diff-content-leave-to {
  opacity: 0;
}

/* Context rows keep plain colors (inherit). */

/* =========================================================================
   MOBILE (≤640px): full-width file rows with ≥44px tap height, a clear Back
   tap target, and the line-by-line panel scrolling horizontally for long
   lines (the gutter scrolls with it; that's acceptable on a phone). No layout
   break at 360px.
   ========================================================================= */
@media (max-width: 640px) {
  .ch-head { padding: 10px 14px; }
  .ch-list { padding: 2px 0 12px; }
  .ch-row {
    min-height: 44px;
    padding: 8px 14px;
    gap: 12px;
    font-size: var(--text-xs);
  }
  .ch-row:active { background: var(--panel2); }
  .badge { width: 18px; height: 18px; }
  .fpath { font-size: var(--text-xs); }
  .tree-row {
    min-height: 40px;
    padding: 8px 14px;
  }

  /* Diff-head Back → real tap target. */
  .diff-head { padding: 8px 12px; gap: 10px; }
  .diff-path { font-size: var(--text-base); }
}

.changes-pane .empty-state { font-family: var(--sans); }
.br-label,
.empty-head { font-family: var(--sans); }
.ch-row,
.ct-row {
  margin: 1px 6px;
  width: calc(100% - 12px);
  border-radius: var(--radius-md);
}
.changes-pane .badge,
.changed-tree .badge { border-radius: var(--radius-sm); }
.change-count { font-family: var(--sans); border-radius: 999px; }
</style>
