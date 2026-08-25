<!-- Shiki syntax highlighting for code surfaces: plain content (Write/Read
     tool cards, file preview) or line-diff rows (Edit tool card, diff panel).
     Renders plain first and upgrades in place once the lazily-loaded
     highlighter resolves; unknown languages and failures stay plain. Themes
     follow the colour scheme (github-light / github-dark). -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ThemedToken } from 'shiki';
import { useIsDark } from '@moonshot-ai/app-core';
import { codeLanguageFromPath } from '@moonshot-ai/app-core/lib';
import { splitLines } from '@moonshot-ai/app-core/client';
import type { DiffFullTexts } from '@moonshot-ai/app-core/client';
import type { DiffViewLine } from '@moonshot-ai/app-core/client/types';

const props = withDefaults(
  defineProps<{
    /** Plain code content (mutually exclusive with `lines`). Pass a string[]
        to give the display rows directly — e.g. Read output whose trailing
        empty row is a real file line that splitLines would drop. */
    code?: string | string[];
    /** Line-diff rows, as built by buildDiffLines (mutually exclusive with
        `code`). Rows are coloured by highlighting the before/after texts and
        mapping tokens back via oldNo/newNo. */
    lines?: DiffViewLine[];
    /** File path used to infer the language; unknown → plain text. */
    path?: string;
    /** Line-number gutter. Diff rows: boolean shows the old/new columns (only
        meaningful with real file line numbers; inline edit diffs leave it
        off). Plain rows: pass a per-row number array (e.g. Read output's real
        file line numbers). */
    lineNumbers?: boolean | number[];
    /** Card chrome (hairline edge, well fill, 24-row cap). Off for the
        right-side panels. */
    framed?: boolean;
    /** Full old/new texts behind the diff; rows index tokens by real line
        number. Null → stitched fragments mapped by position. */
    fullTexts?: DiffFullTexts | null;
    /** Plain mode only: per-row extra classes by gutter line number (-1 when
        unknown). */
    lineClass?: (lineNo: number) => Record<string, boolean> | undefined;
  }>(),
  { code: undefined, lines: undefined, path: undefined, lineNumbers: false, framed: true, fullTexts: null, lineClass: undefined },
);

const isDark = useIsDark();
const language = computed(() => codeLanguageFromPath(props.path));
const isDiff = computed(() => props.lines !== undefined);
const showDiffGutter = computed(() => props.lineNumbers === true && isDiff.value);
/** Gutter columns that exist at all — a pure add/delete file gets no empty
    column for the absent side. */
const showOldGutter = computed(() => (props.lines ?? []).some((l) => l.oldNo !== undefined));
const showNewGutter = computed(() => (props.lines ?? []).some((l) => l.newNo !== undefined));
/** Per-row numbers for plain mode, or null when the gutter stays off. */
const plainGutter = computed(() => (Array.isArray(props.lineNumbers) ? props.lineNumbers : null));

/** Display rows for plain mode — the skeleton regardless of highlighter state
    (token rows are aligned onto it by index). */
const plainRows = computed(() => (Array.isArray(props.code) ? props.code : splitLines(props.code ?? '')));

/** before/after texts to tokenize: the full files when provided, else the
    stitched fragment sides. */
const diffTexts = computed(() => {
  const lines = props.lines;
  if (!lines) return null;
  if (props.fullTexts) return props.fullTexts;
  return {
    before: lines.filter((l) => l.oldNo !== undefined).map((l) => l.text).join('\n'),
    after: lines.filter((l) => l.newNo !== undefined).map((l) => l.text).join('\n'),
  };
});

const plainTokens = ref<ThemedToken[][] | null>(null);
const beforeTokens = ref<ThemedToken[][] | null>(null);
const afterTokens = ref<ThemedToken[][] | null>(null);

function clearTokens(): void {
  plainTokens.value = null;
  beforeTokens.value = null;
  afterTokens.value = null;
}

// Re-tokenizing on every streaming delta — and clearing first — flashed the
// block plain→styled continuously. Throttle instead: the previous tokens stay
// visible while revalidating (rows beyond them render their current text
// plain), at most one highlight per interval. A pure debounce is wrong here:
// the template renders token CONTENTS, so deferring past the stream's end
// would freeze the visible text mid-stream; the trailing timer always
// re-reads the latest inputs, so the settled state is the last one painted.
const HIGHLIGHT_INTERVAL_MS = 200;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastHighlightAt = 0;

// Only the latest request may commit: inputs/theme can change again while an
// earlier highlight is still in flight.
let ticket = 0;
async function highlight(): Promise<void> {
  const mine = ++ticket;
  lastHighlightAt = Date.now();
  const lang = language.value;
  if (!lang) {
    // Unknown language renders plain permanently.
    if (mine === ticket) clearTokens();
    return;
  }
  try {
    const { codeToTokens } = await import('shiki');
    const theme = isDark.value ? 'github-dark' : 'github-light';
    const texts = diffTexts.value;
    if (texts) {
      const [before, after] = await Promise.all([
        texts.before ? codeToTokens(texts.before, { lang, theme }) : Promise.resolve(null),
        texts.after ? codeToTokens(texts.after, { lang, theme }) : Promise.resolve(null),
      ]);
      if (mine !== ticket) return;
      beforeTokens.value = before?.tokens ?? null;
      afterTokens.value = after?.tokens ?? null;
    } else {
      const result = plainRows.value.length > 0 ? await codeToTokens(plainRows.value.join('\n'), { lang, theme }) : null;
      if (mine !== ticket) return;
      plainTokens.value = result?.tokens ?? null;
    }
  } catch {
    // Grammar load failure: keep the plain-text fallback.
    if (mine === ticket) clearTokens();
  }
}

function scheduleHighlight(): void {
  if (throttleTimer !== null) return;
  const wait = Math.max(0, HIGHLIGHT_INTERVAL_MS - (Date.now() - lastHighlightAt));
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    void highlight();
  }, wait);
}

/** The texts actually tokenized — compared BY VALUE. Every streaming delta
    re-runs messagesToTurns, which rebuilds EVERY turn's tool objects; an
    identity-based watch would fire for settled blocks dozens of times per
    second and re-tokenize them for nothing (and before the stale-while-
    revalidate change, that identity churn was exactly what cleared tokens
    and flashed settled blocks while OTHER content streamed below). */
const plainText = computed(() => plainRows.value.join('\n'));
const diffBefore = computed(() => diffTexts.value?.before ?? null);
const diffAfter = computed(() => diffTexts.value?.after ?? null);

// Content changes keep the previous tokens while revalidating (no flash) and
// deliberately do NOT invalidate an in-flight run: killing it on every delta
// starves commits whenever tokenizing outpaces the stream — the block would
// freeze on an old snapshot until the stream pauses. A stale commit is
// bounded to one throttle interval and the next run refreshes it. Only a
// language/theme change invalidates in-flight work (wrong grammar/colours)
// and clears immediately.
watch([plainText, diffBefore, diffAfter], scheduleHighlight);
// fullTexts also invalidates: it flips the token indexing scheme (real line
// numbers vs fragment positions), so the other mode's tokens are wrong
// content, not just stale.
watch([language, isDark, () => props.fullTexts], () => {
  ticket++;
  clearTokens();
  scheduleHighlight();
});

onMounted(highlight);
onUnmounted(() => {
  // In-flight highlights must not commit after unmount.
  ticket++;
  if (throttleTimer !== null) clearTimeout(throttleTimer);
  throttleTimer = null;
});

/** Gutter content width in ch, sized to the longest line number present so
    every row's column is identical. */
const gutterCh = computed(() => {
  let maxNo = 0;
  if (Array.isArray(props.lineNumbers)) {
    for (const n of props.lineNumbers) if (n > maxNo) maxNo = n;
  } else {
    for (const l of props.lines ?? []) {
      if (l.oldNo !== undefined && l.oldNo > maxNo) maxNo = l.oldNo;
      if (l.newNo !== undefined && l.newNo > maxNo) maxNo = l.newNo;
    }
  }
  return Math.max(4, String(maxNo).length);
});

/** Tokens for one diff row: deletions read the before text, additions and
    context rows read the after text (same content either way for context).
    Rows without a line number (omission markers) render their text as-is —
    mapping them to some token row would show the wrong content. */
function rowTokens(line: DiffViewLine): ThemedToken[] | null {
  if (line.type === 'del') {
    if (line.oldNo === undefined) return null;
    const row = props.fullTexts ? line.oldNo - 1 : oldTokenRow.value.get(line.oldNo);
    return row === undefined ? null : (beforeTokens.value?.[row] ?? null);
  }
  if (line.newNo === undefined) return null;
  const row = props.fullTexts ? line.newNo - 1 : newTokenRow.value.get(line.newNo);
  return row === undefined ? null : (afterTokens.value?.[row] ?? null);
}

// Fragment mode only (fullTexts indexes by real line number): map each row's
// line number to its position in the stitched before/after texts.
const oldTokenRow = computed(() => {
  const map = new Map<number, number>();
  let i = 0;
  for (const l of props.lines ?? []) {
    if (l.oldNo !== undefined) map.set(l.oldNo, i++);
  }
  return map;
});
const newTokenRow = computed(() => {
  const map = new Map<number, number>();
  let i = 0;
  for (const l of props.lines ?? []) {
    if (l.newNo !== undefined) map.set(l.newNo, i++);
  }
  return map;
});

function tokenStyle(token: ThemedToken): Record<string, string> {
  const style: Record<string, string> = {};
  if (token.color) style.color = token.color;
  const fontStyle = token.fontStyle ?? 0;
  // shiki FontStyle bit flags: 1 = italic, 2 = bold, 4 = underline.
  if (fontStyle & 1) style.fontStyle = 'italic';
  if (fontStyle & 2) style.fontWeight = 'var(--weight-semibold)';
  if (fontStyle & 4) style.textDecoration = 'underline';
  return style;
}

function sign(line: DiffViewLine): string {
  return line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
}
</script>

<template>
  <div class="hl-code" :class="{ gutter: showDiffGutter, 'plain-pad': !isDiff && !plainGutter, framed }" :style="{ '--gutter-ch': `${gutterCh}ch` }">
    <div class="hl-body">
      <template v-if="isDiff">
        <div v-for="(line, i) in lines ?? []" :key="i" class="hl-row" :class="`row-${line.type}`">
          <template v-if="showDiffGutter">
            <span v-if="showOldGutter" class="hl-gutter">{{ line.oldNo ?? '' }}</span>
            <span v-if="showNewGutter" class="hl-gutter new">{{ line.newNo ?? '' }}</span>
          </template>
          <span class="hl-sign">{{ sign(line) }}</span>
          <span class="hl-text"><template v-if="rowTokens(line)"><span v-for="(t, j) in rowTokens(line) ?? []" :key="j" :style="tokenStyle(t)">{{ t.content }}</span></template><template v-else>{{ line.text }}</template></span>
        </div>
      </template>
      <template v-else>
        <div v-for="(row, i) in plainRows" :key="i" class="hl-row" :class="lineClass?.(plainGutter?.[i] ?? -1)" :data-line="plainGutter?.[i]">
          <span v-if="plainGutter" class="hl-gutter">{{ plainGutter[i] ?? '' }}</span>
          <span class="hl-text"><template v-if="plainTokens?.[i]"><span v-for="(t, j) in plainTokens[i] ?? []" :key="j" :style="tokenStyle(t)">{{ t.content }}</span></template><template v-else>{{ row }}</template></span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Same panel language as the shared OutputPanel: content-well fill, 0.5px
   hairline edge, radius-md. The well lifts the panel off the page in dark
   (where the sunken surface == page bg and would vanish); light is unchanged.
   The panel owns the scroll viewport — caps long content vertically and
   scrolls horizontally for wide lines. */
.hl-code {
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  overflow: auto;
  max-height: calc(24 * 1.5 * var(--ui-font-size));
  overscroll-behavior: contain;
  font-family: var(--font-mono);
  font-size: var(--code-font-size);
  line-height: var(--leading-normal);
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
}
/* Unframed (right-side panels): the panel owns the edge, fill and scroll. */
.hl-code:not(.framed) {
  border: none;
  border-radius: 0;
  background: transparent;
  max-height: none;
  overflow: visible;
}
/* Grow to the longest row so add/del backgrounds paint edge-to-edge across the
   horizontal scroll. */
.hl-body {
  width: max-content;
  min-width: 100%;
  padding: var(--space-1) 0 var(--space-2);
}
/* Plain rows with no gutter column (Write previews): diff rows get their left
   offset from the sign column and Read rows from the number gutter — plain
   rows have neither, so give them the breathing room explicitly. */
.hl-code.plain-pad .hl-body {
  padding-left: var(--space-3);
}
.hl-row {
  display: flex;
  align-items: flex-start;
  min-height: calc(1em * var(--leading-normal));
  white-space: pre;
  width: 100%;
}
.hl-gutter {
  flex: none;
  /* content-box: --gutter-ch measures the digits only. */
  box-sizing: content-box;
  min-width: var(--gutter-ch, 4ch);
  padding: 0 var(--space-2);
  text-align: right;
  color: var(--color-text-faint);
  user-select: none;
  border-right: 0.5px solid var(--color-line);
  font-variant-numeric: tabular-nums;
}
.hl-sign {
  flex: none;
  width: 16px;
  text-align: center;
  color: var(--color-text-muted);
  user-select: none;
}
.hl-text {
  /* Do not shrink: the body is sized to the longest line, so the text keeps
     its full width and rows line up. */
  flex: none;
  padding-right: 14px;
  white-space: pre;
  color: var(--color-text);
}
/* Plain-gutter mode: space the text off the gutter hairline (the sign column
   does this in diff mode). */
.hl-gutter + .hl-text {
  padding-left: var(--space-2);
}
/* Added / removed rows: a faint background carries the change; the code text
   keeps its shiki colours. */
.row-add {
  background: var(--color-diff-add-bg);
}
.row-add .hl-sign {
  color: var(--color-success);
}
.row-del {
  background: var(--color-diff-del-bg);
}
.row-del .hl-sign {
  color: var(--color-danger);
}
/* Hunk header rows (git @@ bands) never tokenize. */
.row-hunk {
  background: var(--color-surface-sunken);
}
.row-hunk .hl-text {
  color: var(--color-text-muted);
}
/* With the gutter on (real file line numbers), add the left accent bar;
   without it, the edge-to-edge tint plus the coloured sign already carry it. */
.hl-code.gutter .row-add {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-success) 55%, transparent);
}
.hl-code.gutter .row-del {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-danger) 55%, transparent);
}
</style>
