<!-- apps/kimi-web/src/components/DiffView.vue -->
<!-- ~/diff tab: real git changes from the daemon's fs:git_status, with a
     line-by-line unified-diff view (fs:diff) when a file is tapped.
     The changed-file list can be viewed as a flat list or as a tree. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DiffViewLine } from '../types';

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
 * e.g. "packages/daemon/src/middleware/schema.ts" → "…leware/schema.ts"
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

/** Gutter cell text for a diff row (old / new line numbers). */
function oldGutter(line: DiffViewLine): string {
  return line.oldNo !== undefined ? String(line.oldNo) : '';
}
function newGutter(line: DiffViewLine): string {
  return line.newNo !== undefined ? String(line.newNo) : '';
}

function rowClass(line: DiffViewLine): string {
  return `dl-${line.type}`;
}

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

function setViewMode(mode: ViewMode): void {
  viewMode.value = mode;
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

const folderIcon = (expanded: boolean) =>
  expanded
    ? 'M1.5 3.5h3l1.5 2h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z'
    : 'M1.5 3.5h3l1.5 2h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z';

function treePadding(depth: number): string {
  return `${16 + depth * 16}px`;
}
</script>

<template>
  <div class="changes-pane">
    <!-- ===================== LINE-BY-LINE DIFF VIEW ===================== -->
    <template v-if="renderDetail">
      <div class="dv-panel-head">
        <span class="dv-title">{{ t('diff.title') }}</span>
        <span class="dv-path" :title="selectedDiffPath ?? ''">{{ truncateLeft(selectedDiffPath ?? '', 50) }}</span>
        <button
          v-if="closable"
          type="button"
          class="dv-close"
          :title="t('diff.close')"
          :aria-label="t('diff.close')"
          @click="onClose"
        >
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>

      <div class="diff-head">
        <button v-if="!hideBack" class="back-btn" type="button" @click="onBack" :title="t('diff.back')">
          <span aria-hidden="true">&#8592;</span>
          <span class="back-label">{{ t('diff.back') }}</span>
        </button>
      </div>

      <div v-if="loading" class="empty-state">{{ t('diff.loading') }}</div>

      <div v-else-if="diffLines.length > 0" class="diff-lines">
        <div
          v-for="(line, i) in diffLines"
          :key="i"
          class="dl"
          :class="rowClass(line)"
        >
          <template v-if="line.type === 'hunk'">
            <span class="hunk-text">{{ line.text }}</span>
          </template>
          <template v-else>
            <span class="dl-gutter old">{{ oldGutter(line) }}</span>
            <span class="dl-gutter new">{{ newGutter(line) }}</span>
            <span class="dl-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
            <span class="dl-text">{{ line.text }}</span>
          </template>
        </div>
      </div>

      <div v-else class="empty-state">{{ t('diff.noDiff') }}</div>
    </template>

    <!-- ======================== CHANGED-FILE LIST ======================= -->
    <template v-else>
      <!-- Panel header: title, view toggle, close -->
      <div class="dv-panel-head">
        <span class="dv-title">{{ t('diff.title') }}</span>
        <span class="dv-change-count">{{ t('diff.changeCount', { count: changes.length }) }}</span>
        <div class="dv-toggle" role="group" :aria-label="t('diff.list') + ' / ' + t('diff.tree')">
          <button
            type="button"
            class="dv-toggle-btn"
            :class="{ active: viewMode === 'list' }"
            :aria-pressed="viewMode === 'list'"
            @click="setViewMode('list')"
          >
            {{ t('diff.list') }}
          </button>
          <button
            type="button"
            class="dv-toggle-btn"
            :class="{ active: viewMode === 'tree' }"
            :aria-pressed="viewMode === 'tree'"
            @click="setViewMode('tree')"
          >
            {{ t('diff.tree') }}
          </button>
        </div>
        <button
          v-if="closable"
          type="button"
          class="dv-close"
          :title="t('diff.close')"
          :aria-label="t('diff.close')"
          @click="onClose"
        >
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>

      <!-- Git branch / status sub-header -->
      <div class="ch-head">
        <template v-if="hasGitInfo">
          <span class="br-label">{{ t('diff.branch') }}</span>
          <span class="br-name">{{ gitInfo!.branch }}</span>
          <span v-if="gitInfo!.ahead > 0 || gitInfo!.behind > 0" class="sync-info">
            <span v-if="gitInfo!.ahead > 0" class="ahead" :title="t('diff.aheadTitle')">&#8593;{{ gitInfo!.ahead }}</span>
            <span v-if="gitInfo!.behind > 0" class="behind" :title="t('diff.behindTitle')">&#8595;{{ gitInfo!.behind }}</span>
          </span>
        </template>
        <template v-else>
          <span class="empty-head">{{ t('diff.empty') }}</span>
        </template>
      </div>

      <!-- File list (flat) -->
      <div v-if="hasChanges && viewMode === 'list'" class="ch-list">
        <button
          v-for="entry in changes"
          :key="entry.path"
          type="button"
          class="ch-row"
          :title="entry.path"
          @click="onOpen(entry.path)"
        >
          <span class="badge" :class="badgeKind(entry.status)">{{ badgeGlyph(entry.status) }}</span>
          <span class="fpath">{{ truncateLeft(entry.path) }}</span>
        </button>
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
              <svg class="tree-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path :d="folderIcon(isExpanded(node.path))" />
              </svg>
              <span class="tree-name">{{ node.name }}</span>
            </button>
            <button
              v-else
              type="button"
              class="tree-row tree-file"
              :style="{ paddingLeft: treePadding(depth) }"
              :title="node.path"
              @click="onOpen(node.path)"
            >
              <span class="badge" :class="badgeKind(node.status!)">{{ badgeGlyph(node.status!) }}</span>
              <span class="tree-name">{{ node.name }}</span>
            </button>
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

/* ---- Panel header (matches other right-side panels) ---- */
.dv-panel-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--panel-head-h, 48px);
  padding: 0 6px 0 12px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.dv-title {
  flex: none;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ink);
}
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
.dv-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 5px;
  overflow: hidden;
}
.dv-toggle-btn {
  background: var(--panel);
  border: none;
  padding: 3px 8px;
  font-family: inherit;
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--dim);
  cursor: pointer;
}
.dv-toggle-btn.active {
  background: var(--bg);
  color: var(--ink);
}
.dv-toggle-btn:hover:not(.active) {
  background: var(--panel2, #f5f6f8);
  color: var(--ink);
}
.dv-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
}
.dv-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.dv-close:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

/* ---- Branch sub-header ---- */
.ch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: calc(var(--ui-font-size) - 2.5px);
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
  color: var(--blue);
  font-weight: 700;
  font-size: var(--ui-font-size);
}

.sync-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ahead {
  color: var(--blue);
  font-size: calc(var(--ui-font-size) - 3px);
}

.behind {
  color: var(--warn);
  font-size: calc(var(--ui-font-size) - 3px);
}

.empty-head {
  color: var(--muted);
  font-size: calc(var(--ui-font-size) - 3px);
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
  outline: 2px solid var(--blue, #1783ff);
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
  outline: 2px solid var(--blue, #1783ff);
  outline-offset: -2px;
}
.tree-folder {
  color: var(--ink);
  font-weight: 600;
}
.tree-file {
  color: var(--ink);
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
  border-radius: 2px;
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  font-weight: 700;
  flex: none;
  user-select: none;
}

.badge.modified  { background: color-mix(in srgb, var(--blue) 12%, var(--bg)); color: var(--blue); }
.badge.added     { background: color-mix(in srgb, var(--ok) 10%, var(--bg)); color: var(--ok); }
.badge.deleted   { background: color-mix(in srgb, var(--err) 10%, var(--bg)); color: var(--err); }
.badge.renamed   { background: color-mix(in srgb, var(--warn) 12%, var(--bg)); color: var(--warn); }
.badge.untracked { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }
.badge.conflicted{ background: color-mix(in srgb, var(--err) 10%, var(--bg)); color: var(--err); font-size: max(9px, calc(var(--ui-font-size) - 5px)); }
.badge.ignored   { background: var(--soft, #f0f0f5); color: var(--faint, #c0c5cc); }
.badge.clean     { background: transparent; color: var(--faint, #c0c5cc); }
.badge.unknown   { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }

/* ---- File path ---- */
.fpath {
  color: var(--ink);
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

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 3px 8px;
  cursor: pointer;
  color: var(--dim);
  font-family: inherit;
  font-size: calc(var(--ui-font-size) - 3px);
  flex: none;
}

.back-btn:hover {
  background: var(--panel2, #f5f6f8);
  color: var(--ink);
}

.back-btn:focus-visible {
  outline: 2px solid var(--blue, #1783ff);
  outline-offset: 1px;
}

.diff-lines {
  flex: 1;
  overflow: auto;
  padding: 4px 0 12px;
  font-size: var(--ui-font-size);
  line-height: 1.5;
  -webkit-overflow-scrolling: touch;
}

.dl {
  display: flex;
  align-items: flex-start;
  min-height: 18px;
  white-space: pre;
}

.dl-gutter {
  flex: none;
  width: 40px;
  padding: 0 6px;
  text-align: right;
  color: var(--faint, #aeb4bc);
  background: var(--panel, #fafbfc);
  user-select: none;
  border-right: 1px solid var(--line2, #eef1f4);
  font-variant-numeric: tabular-nums;
}

.dl-gutter.new { border-right: 1px solid var(--line, #e7eaee); }

.dl-sign {
  flex: none;
  width: 16px;
  text-align: center;
  color: var(--muted);
  user-select: none;
}

.dl-text {
  flex: 1;
  padding-right: 14px;
  white-space: pre;
  color: var(--text);
  min-width: 0;
}

/* Added / removed lines: a faint background plus a left accent bar mark the
   change, while the code TEXT keeps the normal ink colour. Washing the whole
   line in green/red competed with reading the code itself; the sign (+/-) and
   the accent carry the colour so the content stays legible. */
.dl-add {
  background: color-mix(in srgb, var(--ok) 7%, var(--bg));
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--ok) 55%, transparent);
}
.dl-add .dl-sign {
  color: var(--ok, #0e7a38);
}

.dl-del {
  background: color-mix(in srgb, var(--err) 7%, var(--bg));
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--err) 55%, transparent);
}
.dl-del .dl-sign {
  color: var(--err, #b91c1c);
}

/* Hunk header — muted band spanning the whole row. */
.dl-hunk {
  background: var(--panel2, #f3f5f8);
}
.dl-hunk .hunk-text {
  flex: 1;
  padding: 1px 12px;
  color: var(--muted, #8b929b);
  font-style: normal;
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
  .back-btn {
    min-height: 36px;
    padding: 6px 12px;
    font-size: var(--ui-font-size-xs);
    border-radius: 7px;
  }
  .back-btn:active { background: var(--panel2, #f5f6f8); }
  .diff-path { font-size: calc(var(--ui-font-size) - 1.5px); }

  /* Line panel: horizontal scroll for long lines; keep the mono gutter intact. */
  .diff-lines {
    overflow-x: auto;
    font-size: var(--ui-font-size);
  }
}
</style>
