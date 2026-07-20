<!-- apps/web/src/components/chat/DiffLines.vue -->
<!-- Pure line-by-line diff renderer. Shared by the ~/diff panel (DiffView) and
     inline tool-call edit previews (ToolCall). Owns only the rows + their
     styling; the parent controls the surrounding height / scroll. -->
<script setup lang="ts">
import type { DiffViewLine } from '../../types';

withDefaults(
  defineProps<{
    lines: DiffViewLine[];
    /**
     * Show the old/new line-number gutter columns. Only meaningful when the
     * numbers are real file line numbers (the git diff panel). Inline Edit-card
     * diffs number a synthesized old_string/new_string fragment from 1, so the
     * columns would be misleading — they are turned off there.
     */
    lineNumbers?: boolean;
  }>(),
  { lineNumbers: true },
);

function oldGutter(line: DiffViewLine): string {
  return line.oldNo !== undefined ? String(line.oldNo) : '';
}
function newGutter(line: DiffViewLine): string {
  return line.newNo !== undefined ? String(line.newNo) : '';
}
function rowClass(line: DiffViewLine): string {
  return `dl-${line.type}`;
}
</script>

<template>
  <div class="diff-lines" :class="{ 'no-gutter': !lineNumbers }">
    <div v-for="(line, i) in lines" :key="i" class="dl" :class="rowClass(line)">
      <template v-if="line.type === 'hunk'">
        <span class="hunk-text">{{ line.text }}</span>
      </template>
      <template v-else>
        <template v-if="lineNumbers">
          <span class="dl-gutter old">{{ oldGutter(line) }}</span>
          <span class="dl-gutter new">{{ newGutter(line) }}</span>
        </template>
        <span class="dl-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
        <span class="dl-text">{{ line.text }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diff-lines {
  padding: 4px 0 12px;
  font-size: 14px;
  line-height: 1.5;
  -webkit-overflow-scrolling: touch;
  /* Grow to the longest line so every row can fill one uniform width — this
     keeps add/del backgrounds continuous across the whole horizontal scroll. */
  width: max-content;
  min-width: 100%;
}

.dl {
  display: flex;
  align-items: flex-start;
  min-height: 18px;
  white-space: pre;
  /* Fill the (uniform) width of .diff-lines so the add/del background paints
     end-to-end, even for a short line sitting next to a long one. */
  width: 100%;
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
  /* Do not shrink: the container is sized to the longest line (see .diff-lines
     width: max-content), so the text keeps its full width and rows line up. */
  flex: none;
  padding-right: 14px;
  white-space: pre;
  color: var(--color-text);
}

/* Added / removed lines: a faint background plus a left accent bar mark the
   change, while the code TEXT keeps the normal ink colour. Washing the whole
   line in green/red competed with reading the code itself; the sign (+/-) and
   the accent carry the colour so the content stays legible. */
.dl-add {
  background: var(--color-diff-add-bg);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-success) 55%, transparent);
}
.dl-add .dl-sign {
  color: var(--color-success);
}

.dl-del {
  background: var(--color-diff-del-bg);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-danger) 55%, transparent);
}
.dl-del .dl-sign {
  color: var(--color-danger);
}

/* Let the add/del tint run edge-to-edge: an opaque neutral gutter chopped the
   band into "accent bar | grey corridor | tint", which reads as broken —
   especially inside the narrow inline tool card. The column borders still
   separate the two line-number columns. */
.dl-add .dl-gutter,
.dl-del .dl-gutter {
  background: transparent;
}

/* Without the gutter columns (inline tool card), drop the left accent bar:
   the edge-to-edge tint plus the coloured sign already carry the change. */
.diff-lines.no-gutter .dl-add,
.diff-lines.no-gutter .dl-del {
  box-shadow: none;
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

@media (max-width: 640px) {
  .diff-lines {
    overflow-x: auto;
    font-size: 14px;
  }
}
</style>
