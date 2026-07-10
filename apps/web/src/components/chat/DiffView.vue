<!-- apps/kimi-web/src/components/chat/DiffView.vue -->
<!-- ~/diff tab: real git changes from the daemon's fs:git_status, with a
     line-by-line unified-diff view (fs:diff) when a file is tapped.
     The changed-file list can be viewed as a flat list or as a tree. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DiffViewLine } from '../../types';
import DiffLines from './DiffLines.vue';
import Button from '../ui/Button.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    changes: { path: string; status: string }[];
    gitInfo: { branch: string; ahead: number; behind: number } | null;
    /** Parsed unified-diff lines for the selected file (empty until tapped). */
    fileDiff?: DiffViewLine[];
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
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
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
    const parts = entry.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isFile = i === parts.length - 1;
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
  return `${16 + depth * 16}px`;
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
          <span aria-hidden="true">&#8592;</span>
          <span class="back-label">{{ t('diff.back') }}</span>
        </Button>
      </div>

      <div v-if="loading" class="empty-state">{{ t('diff.loading') }}</div>

      <div v-else-if="diffLines.length > 0" class="dv-lines-wrap">
        <DiffLines :lines="diffLines" />
      </div>

      <div v-else class="empty-state">{{ t('diff.noDiff') }}</div>
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
        <span class="dv-change-count">{{ t('diff.changeCount', { count: changes.length }) }}</span>
        <SegmentedControl
          :model-value="viewMode"
          size="sm"
          :options="[
            { value: 'list', label: t('diff.list') },
            { value: 'tree', label: t('diff.tree') },
          ]"
          @update:model-value="setViewMode"
        />
      </PanelHeader>

      <!-- Git branch / status sub-header -->
      <div class="ch-head">
        <template v-if="hasGitInfo">
          <span class="br-label">{{ t('diff.branch') }}</span>
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
      <div v-if="hasChanges && viewMode === 'list'" class="ch-list">
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

      <!-- File tree -->
      <div v-else-if="hasChanges && viewMode === 'tree'" class="ch-list ch-tree">
        <ul class="tree-list">
          <li
            v-for="{ node, depth } in flatTree"
            :key="node.path"
            class="tree-node"
          >
            <button
              v-if="node.kind === 'folder'"
              type="button"
              class="tree-row tree-folder"
              :style="{ paddingLeft: treePadding(depth) }"
              @click="toggleFolder(node)"
            >
              <Icon class="tree-icon" name="folder-solid" size="sm" />
              <span class="tree-name">{{ node.name }}</span>
            </button>
            <Tooltip v-else :text="node.path">
              <button
                type="button"
                class="tree-row tree-file"
                :style="{ paddingLeft: treePadding(depth) }"
                @click="onOpen(node.path)"
              >
                <span class="badge" :class="badgeKind(node.status!)">{{ badgeGlyph(node.status!) }}</span>
                <span class="tree-name">{{ node.name }}</span>
              </button>
            </Tooltip>
          </li>
        </ul>
      </div>

      <!-- Empty state when git info present but no changes -->
      <div v-else-if="hasGitInfo" class="empty-state">
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
}

/* ---- Branch sub-header ---- */
.ch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: var(--text-base);
  color: var(--dim);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
}

.br-label {
  color: var(--muted);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}

.br-name {
  color: var(--color-accent);
  font-weight: 500;
  font-size: var(--ui-font-size);
}

.sync-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ahead {
  color: var(--color-accent);
  font-size: var(--text-base);
}

.behind {
  color: var(--color-warning);
  font-size: var(--text-base);
}

.empty-head {
  color: var(--muted);
  font-size: var(--text-base);
}

/* ---- File list ---- */
.ch-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.ch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  cursor: pointer;
  font-size: var(--ui-font-size);
  line-height: 1.6;
  /* reset button defaults so the row looks like the original div */
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  font-family: inherit;
  color: inherit;
}

.ch-row:hover {
  background: var(--panel2, #f5f6f8);
}

.ch-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

/* ---- Tree view ---- */
.ch-tree {
  padding: 4px 0;
}
.tree-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 16px;
  background: none;
  border: none;
  text-align: left;
  font-family: inherit;
  font-size: var(--ui-font-size);
  color: inherit;
  cursor: pointer;
}
.tree-row:hover {
  background: var(--panel2, #f5f6f8);
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

.badge.modified  { background: color-mix(in srgb, var(--color-accent) 12%, var(--bg)); color: var(--color-accent); }
.badge.added     { background: color-mix(in srgb, var(--color-success) 10%, var(--bg)); color: var(--color-success); }
.badge.deleted   { background: color-mix(in srgb, var(--color-danger) 10%, var(--bg)); color: var(--color-danger); }
.badge.renamed   { background: color-mix(in srgb, var(--color-warning) 12%, var(--bg)); color: var(--color-warning); }
.badge.untracked { background: var(--color-surface-sunken); color: var(--muted, #9098a0); }
.badge.conflicted{ background: color-mix(in srgb, var(--color-danger) 10%, var(--bg)); color: var(--color-danger); font-size: max(9px, calc(var(--ui-font-size) - 5px)); }
.badge.ignored   { background: var(--color-surface-sunken); color: var(--faint, #c0c5cc); }
.badge.clean     { background: transparent; color: var(--faint, #c0c5cc); }
.badge.unknown   { background: var(--color-surface-sunken); color: var(--muted, #9098a0); }

/* ---- File path ---- */
.fpath {
  color: var(--color-text);
  font-size: var(--ui-font-size);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;   /* makes text-overflow clip from the left */
  text-align: left;
  min-width: 0;
}

/* ---- Empty state ---- */
.empty-state {
  padding: 32px 20px;
  color: var(--muted, #9098a0);
  font-size: var(--ui-font-size);
  text-align: center;
}

/* =========================================================================
   LINE-BY-LINE DIFF VIEW
   ========================================================================= */
.diff-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
}

/* Wrapper that lets <DiffLines> fill the panel height and scroll internally.
   The line-row styles themselves live in DiffLines.vue. */
.dv-lines-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
    font-size: var(--ui-font-size-sm);
  }
  .ch-row:active { background: var(--panel2, #f5f6f8); }
  .badge { width: 18px; height: 18px; }
  .fpath { font-size: var(--ui-font-size-sm); }
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
