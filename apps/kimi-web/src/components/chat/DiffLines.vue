<!-- apps/kimi-web/src/components/chat/DiffLines.vue -->
<!-- Pure line-by-line diff renderer. Shared by the ~/diff panel (DiffView) and
     inline tool-call edit previews (ToolCall). Owns only the rows + their
     styling; the parent controls the surrounding height / scroll. -->
<script setup lang="ts">
import type { DiffViewLine } from '../../types';

defineProps<{
  lines: DiffViewLine[];
}>();

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
  <div class="diff-lines">
    <div v-for="(line, i) in lines" :key="i" class="dl" :class="rowClass(line)">
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
</template>

<style scoped>
.diff-lines {
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
  /* Size each row to its content so the add/del background paints across the
     whole line. Without this, the row is only as wide as the viewport and the
     background stops where the text overflows horizontally. */
  width: max-content;
  min-width: 100%;
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
  /* Do not shrink: the row is sized to its content (see .dl width: max-content)
     so the text keeps its full width and the background covers it. */
  flex: none;
  padding-right: 14px;
  white-space: pre;
  color: var(--text);
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

@media (max-width: 640px) {
  .diff-lines {
    overflow-x: auto;
    font-size: var(--ui-font-size);
  }
}
</style>
