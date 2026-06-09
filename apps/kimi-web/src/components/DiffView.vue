<!-- apps/kimi-web/src/components/DiffView.vue -->
<!-- ~/diff tab: real git changes from the daemon's fs:git_status, with a
     line-by-line unified-diff view (fs:diff) when a file is tapped. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DiffViewLine } from '../types';

const { t } = useI18n();

const props = defineProps<{
  changes: { path: string; status: string }[];
  gitInfo: { branch: string; ahead: number; behind: number } | null;
  /** Parsed unified-diff lines for the selected file (empty until tapped). */
  fileDiff?: DiffViewLine[];
  /** The currently-open file path, or null when showing the file list. */
  selectedDiffPath?: string | null;
  /** True while the diff for the selected file is being fetched. */
  fileDiffLoading?: boolean;
}>();

const emit = defineEmits<{
  /** Fired when the user taps a changed file → parent loads its diff. */
  open: [path: string];
  /** Fired when the user collapses the diff back to the file list. */
  back: [];
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
</script>

<template>
  <div class="changes-pane">
    <!-- ===================== LINE-BY-LINE DIFF VIEW ===================== -->
    <template v-if="showingDiff">
      <div class="diff-head">
        <button class="back-btn" type="button" @click="onBack" :title="t('diff.back')">
          <span aria-hidden="true">&#8592;</span>
          <span class="back-label">{{ t('diff.back') }}</span>
        </button>
        <span class="diff-path" :title="selectedDiffPath ?? ''">{{ truncateLeft(selectedDiffPath ?? '', 50) }}</span>
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
      <!-- Header -->
      <div class="ch-head">
        <template v-if="hasGitInfo">
          <span class="br-label">{{ t('diff.branch') }}</span>
          <span class="br-name">{{ gitInfo!.branch }}</span>
          <span v-if="gitInfo!.ahead > 0 || gitInfo!.behind > 0" class="sync-info">
            <span v-if="gitInfo!.ahead > 0" class="ahead" :title="t('diff.aheadTitle')">&#8593;{{ gitInfo!.ahead }}</span>
            <span v-if="gitInfo!.behind > 0" class="behind" :title="t('diff.behindTitle')">&#8595;{{ gitInfo!.behind }}</span>
          </span>
          <span class="change-count">{{ t('diff.changeCount', { count: changes.length }) }}</span>
        </template>
        <template v-else>
          <span class="empty-head">{{ t('diff.empty') }}</span>
        </template>
      </div>

      <!-- File list -->
      <div v-if="hasChanges" class="ch-list">
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

/* ---- Header ---- */
.ch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: 11.5px;
  color: var(--dim);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
}

.br-label {
  color: var(--muted);
  font-size: 10.5px;
}

.br-name {
  color: #1565C0;
  font-weight: 700;
  font-size: 12px;
}

.sync-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ahead {
  color: #1565C0;
  font-size: 11px;
}

.behind {
  color: var(--warn);
  font-size: 11px;
}

.change-count {
  margin-left: auto;
  color: var(--dim);
  font-size: 10.5px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 6px;
}

.empty-head {
  color: var(--muted);
  font-size: 11px;
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
  font-size: 12px;
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
  outline: 2px solid var(--blue, #1565c0);
  outline-offset: -2px;
}

/* ---- Status badge ---- */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 700;
  flex: none;
  user-select: none;
}

.badge.modified  { background: #e8f0fe; color: #1565C0; }
.badge.added     { background: #e6f4ea; color: #1e7e34; }
.badge.deleted   { background: #fce8e6; color: #c5221f; }
.badge.renamed   { background: #fef3e2; color: #b06000; }
.badge.untracked { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }
.badge.conflicted{ background: #fce8e6; color: #c5221f; font-size: 9px; }
.badge.ignored   { background: var(--soft, #f0f0f5); color: var(--faint, #c0c5cc); }
.badge.clean     { background: transparent; color: var(--faint, #c0c5cc); }
.badge.unknown   { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }

/* ---- File path ---- */
.fpath {
  color: var(--ink);
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 11px;
  flex: none;
}

.back-btn:hover {
  background: var(--panel2, #f5f6f8);
  color: var(--ink);
}

.back-btn:focus-visible {
  outline: 2px solid var(--blue, #1565c0);
  outline-offset: 1px;
}

.diff-path {
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  min-width: 0;
}

.diff-lines {
  flex: 1;
  overflow: auto;
  padding: 4px 0 12px;
  font-size: 12px;
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

/* Added lines — green tint that adapts to the active theme background. */
.dl-add {
  background: color-mix(in srgb, var(--ok) 12%, var(--bg));
}
.dl-add .dl-sign,
.dl-add .dl-text {
  color: var(--ok, #0e7a38);
}

/* Removed lines — red tint. */
.dl-del {
  background: color-mix(in srgb, var(--err) 12%, var(--bg));
}
.dl-del .dl-sign,
.dl-del .dl-text {
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
    font-size: 13px;
  }
  .ch-row:active { background: var(--panel2, #f5f6f8); }
  .badge { width: 18px; height: 18px; }
  .fpath { font-size: 13px; }

  /* Diff-head Back → real tap target. */
  .diff-head { padding: 8px 12px; gap: 10px; }
  .back-btn {
    min-height: 36px;
    padding: 6px 12px;
    font-size: 12px;
    border-radius: 7px;
  }
  .back-btn:active { background: var(--panel2, #f5f6f8); }
  .diff-path { font-size: 12.5px; }

  /* Line panel: horizontal scroll for long lines; keep the mono gutter intact. */
  .diff-lines {
    overflow-x: auto;
    font-size: 12px;
  }
}
</style>
