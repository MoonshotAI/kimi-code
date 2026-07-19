<!-- apps/kimi-web/src/components/HighlightedCode.vue -->
<!-- Shiki syntax highlighting for code surfaces: plain content (Write tool
     card) or line-diff rows (Edit tool card). Renders plain text immediately
     and upgrades in place once the lazily-loaded highlighter resolves; unknown
     languages and highlighter failures stay plain. Themes follow the app
     colour scheme (github-light / github-dark, same as chat markdown code
     blocks). Shiki is imported dynamically so its core stays out of the main
     bundle. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ThemedToken } from 'shiki';
import { useIsDark } from '@moonshot-ai/web-core';
import { codeLanguageFromPath } from '../lib/codeLanguage';
import { splitLines } from '../lib/diffLines';
import type { DiffViewLine } from '../types';

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
  }>(),
  { code: undefined, lines: undefined, path: undefined, lineNumbers: false },
);

const isDark = useIsDark();
const language = computed(() => codeLanguageFromPath(props.path));
const isDiff = computed(() => props.lines !== undefined);
const showDiffGutter = computed(() => props.lineNumbers === true && isDiff.value);
/** Per-row numbers for plain mode, or null when the gutter stays off. */
const plainGutter = computed(() => (Array.isArray(props.lineNumbers) ? props.lineNumbers : null));

/** Display rows for plain mode — the skeleton regardless of highlighter state
    (token rows are aligned onto it by index). */
const plainRows = computed(() => (Array.isArray(props.code) ? props.code : splitLines(props.code ?? '')));

/** The two texts a line diff is drawn from: every oldNo row in order forms the
    before text, every newNo row the after text. */
const diffTexts = computed(() => {
  const lines = props.lines;
  if (!lines) return null;
  return {
    before: lines.filter((l) => l.oldNo !== undefined).map((l) => l.text).join('\n'),
    after: lines.filter((l) => l.newNo !== undefined).map((l) => l.text).join('\n'),
  };
});

const plainTokens = ref<ThemedToken[][] | null>(null);
const beforeTokens = ref<ThemedToken[][] | null>(null);
const afterTokens = ref<ThemedToken[][] | null>(null);

// Only the latest request may commit: inputs/theme can change again while an
// earlier highlight is still in flight.
let ticket = 0;
async function highlight(): Promise<void> {
  const mine = ++ticket;
  const clear = (): void => {
    plainTokens.value = null;
    beforeTokens.value = null;
    afterTokens.value = null;
  };
  const lang = language.value;
  // Inputs changed: fall back to the CURRENT plain text immediately instead
  // of showing the previous content's tokens while the new highlight loads.
  clear();
  if (!lang) {
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
    if (mine === ticket) clear();
  }
}

onMounted(highlight);
watch([plainRows, diffTexts, language, isDark], highlight);

/** Tokens for one diff row: deletions read the before text, additions and
    context rows read the after text (same content either way for context).
    Rows without a line number (omission markers) render their text as-is —
    mapping them to some token row would show the wrong content. */
function rowTokens(line: DiffViewLine): ThemedToken[] | null {
  if (line.type === 'del') {
    return line.oldNo === undefined ? null : (beforeTokens.value?.[line.oldNo - 1] ?? null);
  }
  return line.newNo === undefined ? null : (afterTokens.value?.[line.newNo - 1] ?? null);
}

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
  <div class="hl-code" :class="{ gutter: showDiffGutter, 'plain-pad': !isDiff && !plainGutter }">
    <div class="hl-body">
      <template v-if="isDiff">
        <div v-for="(line, i) in lines ?? []" :key="i" class="hl-row" :class="`row-${line.type}`">
          <template v-if="showDiffGutter">
            <span class="hl-gutter">{{ line.oldNo ?? '' }}</span>
            <span class="hl-gutter new">{{ line.newNo ?? '' }}</span>
          </template>
          <span class="hl-sign">{{ sign(line) }}</span>
          <span class="hl-text"><template v-if="rowTokens(line)"><span v-for="(t, j) in rowTokens(line) ?? []" :key="j" :style="tokenStyle(t)">{{ t.content }}</span></template><template v-else>{{ line.text }}</template></span>
        </div>
      </template>
      <template v-else>
        <div v-for="(row, i) in plainRows" :key="i" class="hl-row">
          <span v-if="plainGutter" class="hl-gutter">{{ plainGutter[i] ?? '' }}</span>
          <span class="hl-text"><template v-if="plainTokens?.[i]"><span v-for="(t, j) in plainTokens[i] ?? []" :key="j" :style="tokenStyle(t)">{{ t.content }}</span></template><template v-else>{{ row }}</template></span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Same panel language as the shared OutputPanel: sunken surface, 0.5px
   hairline edge (needed in dark, where sunken == page bg), radius-md. The
   panel owns the scroll viewport — caps long content vertically and scrolls
   horizontally for wide lines. */
.hl-code {
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  overflow: auto;
  max-height: calc(24 * 1.5 * var(--ui-font-size));
  overscroll-behavior: contain;
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: var(--leading-normal);
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
}
/* Grow to the longest row so add/del backgrounds paint edge-to-edge across the
   horizontal scroll (same trick as DiffLines). */
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
  /* ch, not px: tracks the (user-adjustable) code font size and always fits
     four-digit line numbers; grows for longer numbers via min-width. */
  min-width: 4ch;
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
/* Added / removed rows: a faint background carries the change; the code text
   keeps its shiki colours (same choice as DiffLines). */
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
/* With the gutter on (real file line numbers), add DiffLines' left accent bar;
   without it, the edge-to-edge tint plus the coloured sign already carry it. */
.hl-code.gutter .row-add {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-success) 55%, transparent);
}
.hl-code.gutter .row-del {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-danger) 55%, transparent);
}
</style>
