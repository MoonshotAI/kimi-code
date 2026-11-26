<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ThemedToken } from 'shiki';
import { useIsDark } from '@moonshot-ai/app-core';
import { codeLanguageFromPath, logWarn } from '@moonshot-ai/app-core/lib';
import { splitLines } from '@moonshot-ai/app-core/client';
import type { DiffFullTexts } from '@moonshot-ai/app-core/client';
import type { DiffViewLine } from '@moonshot-ai/app-core/client/types';

const props = withDefaults(
  defineProps<{
    code?: string | string[];
    lines?: DiffViewLine[];
    path?: string;
    lineNumbers?: boolean | number[];
    framed?: boolean;
    fullTexts?: DiffFullTexts | null;
    lineClass?: (lineNo: number) => Record<string, boolean> | undefined;
    wrap?: boolean;
    boldWords?: readonly string[];
  }>(),
  { code: undefined, lines: undefined, path: undefined, lineNumbers: false, framed: true, fullTexts: null, lineClass: undefined, wrap: false },
);

const isDark = useIsDark();
const language = computed(() => codeLanguageFromPath(props.path));
const isDiff = computed(() => props.lines !== undefined);
const showDiffGutter = computed(() => props.lineNumbers === true && isDiff.value);
const showOldGutter = computed(() => (props.lines ?? []).some((l) => l.oldNo !== undefined));
const showNewGutter = computed(() => (props.lines ?? []).some((l) => l.newNo !== undefined));
const plainGutter = computed(() => (Array.isArray(props.lineNumbers) ? props.lineNumbers : null));

const plainRows = computed(() => (Array.isArray(props.code) ? props.code : splitLines(props.code ?? '')));

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

const HIGHLIGHT_INTERVAL_MS = 200;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastHighlightAt = 0;

let ticket = 0;
async function highlight(): Promise<void> {
  const mine = ++ticket;
  lastHighlightAt = Date.now();
  const lang = language.value;
  const path = props.path;
  if (!lang) {
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
  } catch (error) {
    if (mine === ticket) clearTokens();
    logWarn('code highlight failed', { lang, path, error });
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

const plainText = computed(() => plainRows.value.join('\n'));
const diffBefore = computed(() => diffTexts.value?.before ?? null);
const diffAfter = computed(() => diffTexts.value?.after ?? null);

watch([plainText, diffBefore, diffAfter], scheduleHighlight);
watch([language, isDark, () => props.fullTexts], () => {
  ticket++;
  clearTokens();
  scheduleHighlight();
});

onMounted(highlight);
onUnmounted(() => {
  ticket++;
  if (throttleTimer !== null) clearTimeout(throttleTimer);
  throttleTimer = null;
});

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
  if (fontStyle & 1) style.fontStyle = 'italic';
  if (fontStyle & 2 || props.boldWords?.includes(token.content.trim())) {
    style.fontWeight = 'var(--weight-semibold)';
  }
  if (fontStyle & 4) style.textDecoration = 'underline';
  return style;
}

const rootRef = ref<HTMLElement | null>(null);

function comparePoints(aNode: Node, aOffset: number, bNode: Node, bOffset: number): -1 | 0 | 1 {
  if (aNode === bNode) return aOffset < bOffset ? -1 : aOffset > bOffset ? 1 : 0;
  const pos = aNode.compareDocumentPosition(bNode);
  if (pos & Node.DOCUMENT_POSITION_CONTAINS) {
    let child: Node = aNode;
    while (child.parentNode !== bNode) child = child.parentNode!;
    let index = 0;
    for (let n = bNode.firstChild; n && n !== child; n = n.nextSibling) index++;
    return index < bOffset ? -1 : 1;
  }
  if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) {
    let child: Node = bNode;
    while (child.parentNode !== aNode) child = child.parentNode!;
    let index = 0;
    for (let n = aNode.firstChild; n && n !== child; n = n.nextSibling) index++;
    return aOffset <= index ? -1 : 1;
  }
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function onCopy(event: ClipboardEvent): void {
  const sel = window.getSelection();
  const root = rootRef.value;
  const clip = event.clipboardData;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root || !clip) return;
  const doc = root.ownerDocument;
  const range = sel.getRangeAt(0);
  const full = doc.createRange();
  full.selectNodeContents(root);
  const before = doc.createRange();
  if (comparePoints(range.startContainer, range.startOffset, full.startContainer, full.startOffset) < 0) {
    before.setStart(range.startContainer, range.startOffset);
    before.setEnd(full.startContainer, full.startOffset);
  }
  const after = doc.createRange();
  if (comparePoints(range.endContainer, range.endOffset, full.endContainer, full.endOffset) > 0) {
    after.setStart(full.endContainer, full.endOffset);
    after.setEnd(range.endContainer, range.endOffset);
  }
  if (before.toString().trim().length > 0 || after.toString().trim().length > 0) return;

  const selected = range.cloneRange();
  if (comparePoints(selected.startContainer, selected.startOffset, full.startContainer, full.startOffset) < 0) selected.setStart(full.startContainer, full.startOffset);
  if (comparePoints(selected.endContainer, selected.endOffset, full.endContainer, full.endOffset) > 0) selected.setEnd(full.endContainer, full.endOffset);

  const parts: string[] = [];
  const textEls = root.querySelectorAll('.hl-row .hl-text');
  let startClamped = false;
  let endClamped = false;
  for (const row of root.querySelectorAll('.hl-row')) {
    const textEl = row.querySelector('.hl-text');
    if (!textEl) continue;
    if (comparePoints(selected.endContainer, selected.endOffset, textEl, 0) <= 0) {
      if (parts.length > 0) break;
      continue;
    }
    if (comparePoints(selected.startContainer, selected.startOffset, textEl, textEl.childNodes.length) > 0) continue;
    const rowRange = doc.createRange();
    rowRange.selectNodeContents(textEl);
    if (comparePoints(selected.startContainer, selected.startOffset, rowRange.startContainer, rowRange.startOffset) > 0) {
      rowRange.setStart(selected.startContainer, selected.startOffset);
      startClamped = true;
    }
    if (comparePoints(selected.endContainer, selected.endOffset, rowRange.endContainer, rowRange.endOffset) < 0) {
      rowRange.setEnd(selected.endContainer, selected.endOffset);
      endClamped = true;
    }
    parts.push(rowRange.toString());
  }
  if (parts.length === 0) return;

  const fragment = selected.cloneContents();
  for (const el of fragment.querySelectorAll('.hl-gutter, .hl-sign')) el.remove();
  for (const textEl of fragment.querySelectorAll('.hl-text')) {
    if (textEl.textContent === '') textEl.appendChild(doc.createElement('br'));
  }
  const htmlHost = doc.createElement('div');
  htmlHost.appendChild(fragment);

  const source = typeof props.code === 'string' ? props.code : null;
  let plain = parts.join('\n');
  if (source !== null) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    plain = parts.map((part) => part.replace(/\r$/, '')).join(eol);
    if (parts.length === textEls.length && !startClamped && !endClamped && /\r?\n$/.test(source)) {
      plain += eol;
    }
  }

  clip.setData('text/plain', plain);
  clip.setData('text/html', htmlHost.innerHTML);
  event.preventDefault();
}

function sign(line: DiffViewLine): string {
  return line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
}
</script>

<template>
  <div ref="rootRef" class="hl-code" :class="{ gutter: showDiffGutter, 'plain-pad': !isDiff && !plainGutter, framed, wrap }" :style="{ '--gutter-ch': `${gutterCh}ch` }" @copy="onCopy">
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
.hl-code {
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  overflow: auto;
  max-height: calc(24 * 1.5 * var(--text-base));
  overscroll-behavior: contain;
  font-family: var(--font-mono);
  font-size: var(--code-font-size);
  line-height: var(--leading-normal);
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
}
.hl-code:not(.framed) {
  border: none;
  border-radius: 0;
  background: transparent;
  max-height: none;
  overflow: visible;
}
.hl-body {
  width: max-content;
  min-width: 100%;
  padding: var(--space-1) 0 var(--space-2);
}
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
  box-sizing: content-box;
  min-width: var(--gutter-ch, 4ch);
  padding: 0 var(--space-2);
  text-align: right;
  color: var(--color-text-faint);
  user-select: none;
  border-right: var(--p-hairline) solid var(--color-line);
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
  flex: none;
  padding-right: 14px;
  white-space: pre;
  color: var(--color-text);
}
.hl-gutter + .hl-text {
  padding-left: var(--space-2);
}
.hl-code.wrap .hl-body {
  width: 100%;
}
.hl-code.wrap .hl-text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
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
.row-hunk {
  background: var(--color-surface-sunken);
}
.row-hunk .hl-text {
  color: var(--color-text-muted);
}
.hl-code.gutter .row-add {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-success) 55%, transparent);
}
.hl-code.gutter .row-del {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-danger) 55%, transparent);
}
</style>
