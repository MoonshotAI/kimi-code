<!-- apps/kimi-web/src/components/chat/Markdown.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  MarkdownRender,
  enableKatex,
  enableMermaid,
  setKaTeXWorker,
  clearKaTeXWorker,
  setMermaidWorker,
  clearMermaidWorker,
} from 'markstream-vue';
import type { MarkdownIt } from 'markstream-vue';
import { useIsDark } from '../../composables/useIsDark';
import type { FilePreviewRequest } from '../../types';
import { collectFilePathAliases, findFilePathLinks } from '../../lib/filePathLinks';
import { markdownRenderPlan } from '../../lib/markdownPerformance';
import { copyTextToClipboard } from '../../lib/clipboard';
import * as katexWorkerModule from 'markstream-vue/workers/katexRenderer.worker?worker&type=module';
import * as mermaidWorkerModule from 'markstream-vue/workers/mermaidParser.worker?worker&type=module';
import Tooltip from '../ui/Tooltip.vue';
import Icon from '../ui/Icon.vue';
// px-based CSS build (our app is px, not rem). Imported here so the styles
// load wherever Markdown is used; scoped overrides below re-skin it to
// Terminal Pro. Importing the same file from multiple components is a no-op
// after the first (Vite dedups the CSS import).
import 'markstream-vue/index.px.css';
// KaTeX math: markstream renders `$$…$$` display math only after the optional
// katex peer is enabled, and its stylesheet (+ bundled fonts) is what gives
// formulas their layout. enableKatex() registers the default `import('katex')`
// loader; it runs once on first import of this module and is safe at module
// scope. Without the CSS the math renders unstyled, so both must travel
// together.
import 'katex/dist/katex.min.css';
enableKatex();

// Mermaid diagram rendering. enableMermaid() registers the default
// `import('mermaid')` loader — same pattern as enableKatex(). Without a worker,
// mermaid.parse() runs on the main thread; with a worker (set via
// setMermaidWorker), the MermaidBlockNode can validate partial-stream code
// off-thread so the UI stays responsive during live diagram output.
enableMermaid();

// ---------------------------------------------------------------------------
// Off-main-thread workers for KaTeX and Mermaid
//
// Both katex.renderToString and mermaid.parse are CPU-heavy. markstream-vue
// ships pre-built workers (katexRenderer.worker.js, mermaidParser.worker.js)
// that follow the exact protocol its internal worker clients expect. We import
// them via Vite's `?worker&type=module` so they're built as ES module chunks
// (supporting code-splitting, which mermaid needs for per-diagram dynamic
// imports).
//
// markstream-vue's MermaidBlockNode and MathBlockNode auto-detect the presence
// of a worker: when set, heavy parsing/rendering is dispatched off-thread; when
// absent, everything runs on the main thread.
// ---------------------------------------------------------------------------

// Tear down any previous worker (e.g. from HMR) before setting a new one.
clearKaTeXWorker();
clearMermaidWorker();

setKaTeXWorker(new katexWorkerModule.default());
setMermaidWorker(new mermaidWorkerModule.default());

// Only `$$…$$` display math is rendered; single `$` inline math is disabled so
// prices, env vars, and shell paths (`$5`, `$PATH`, `$HOME/bin`) stay literal
// without any escaping or code-detection gymnastics. `math_block` (the $$ rule)
// is left enabled.
function disableInlineMath(md: MarkdownIt): MarkdownIt {
  md.inline.ruler.disable('math');
  return md;
}

const { t } = useI18n();

const resolveImage = inject<(src: string) => Promise<string>>('resolveImage');
const mdRef = ref<HTMLElement | null>(null);
const props = withDefaults(
  defineProps<{
    text: string;
    openFile?: (target: FilePreviewRequest) => void;
    /**
     * True only for the assistant turn that is actively streaming. Drives BOTH
     * `final` (= !streaming) AND markstream's `smooth-streaming`. We bind
     * smooth-streaming to this (not the hardcoded "auto") because "auto" still
     * plays a one-time typewriter/fade reveal when the full content is set on
     * mount — so reopening a historical session re-streamed every message.
     * With smooth-streaming = false for done turns, markstream snaps the text
     * in immediately; only a genuinely live turn (streaming=true) animates.
     */
    streaming?: boolean;
  }>(),
  { streaming: false },
);

const final = computed(() => !props.streaming);
const filePathAliases = computed(() => collectFilePathAliases(props.text ?? ''));
const renderPlan = computed(() => {
  // While a turn is actively streaming, never downgrade the code renderer:
  // markstream keys each code block on the renderer value, so flipping
  // shiki→pre mid-stream remounts every block (visible jitter + lost
  // highlighting) right in the "fast output" scenario this is meant to fix.
  // Plan for heaviness only once the turn has settled — already-loaded history
  // is never `streaming`, so the large/heavy-session case still gets `pre`.
  if (props.streaming) return { codeRenderer: 'shiki' as const, codeFenceCount: 0, codeChars: 0 };
  return markdownRenderPlan(props.text ?? '');
});

// Code blocks follow the app colour scheme (shiki re-renders on flip).
const isDark = useIsDark();

// markstream's chat mode can batch nodes and defer offscreen nodes. Batching is
// safe for settled history, but viewport deferral can leave individual code
// blocks blank in our internal chat scroller when visibility events are missed
// during a session/theme switch. Keep batching for history, but always mount the
// actual nodes so every code block has at least its plain fallback immediately.
const allowBatchRender = computed(() => !props.streaming);

// ---------------------------------------------------------------------------
// Local image resolution — rewrite the SOURCE TEXT before markstream sees it.
//
// The old approach (let markstream render <img src="local/path">, then swap
// the src via DOM after a daemon readFile round-trip) raced the browser: the
// local path 404s immediately, markstream's ImageNode flips to its "failed"
// state and unmounts the <img>, and the late setAttribute lands on a detached
// element — the image stays broken forever. Rewriting the markdown text means
// the parser only ever sees a loadable src: a 1×1 transparent GIF while the
// daemon read is in flight, then the data URL (a src change resets ImageNode).
//
// Note: the parser's sanitizer only allows BITMAP data URIs on <img>
// (png/gif/jpeg/webp/avif/bmp) — svg images stay on their original src.
// ---------------------------------------------------------------------------

const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// src → resolved data URL, or '' when resolution failed (keep the original
// src so the user at least sees an honest broken-image state).
const resolvedImages = reactive(new Map<string, string>());
const pendingImages = new Set<string>();

// ![alt](src) — src up to the first whitespace/closing paren (optional title
// stays in place). <img src="..."> for raw-HTML images.
const MD_IMG_RE = /(!\[[^\]]*\]\()\s*([^)\s]+)([^)]*\))/g;
const HTML_IMG_RE = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi;

function isLocalImageSrc(src: string): boolean {
  return !/^(https?:|data:|blob:)/i.test(src);
}

function queueImageResolution(text: string): void {
  if (!resolveImage) return;
  const srcs: string[] = [];
  for (const re of [MD_IMG_RE, HTML_IMG_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) srcs.push(m[2] ?? '');
  }
  for (const src of srcs) {
    if (!src || !isLocalImageSrc(src)) continue;
    if (resolvedImages.has(src) || pendingImages.has(src)) continue;
    pendingImages.add(src);
    resolveImage(src)
      .then((url) => {
        resolvedImages.set(src, url !== src ? url : '');
      })
      .catch(() => {
        resolvedImages.set(src, '');
      })
      .finally(() => {
        pendingImages.delete(src);
      });
  }
}

/** Substitute local image srcs: resolved → data URL, in-flight → placeholder,
    failed → original (browser shows its normal broken state). */
function rewriteImageSrcs(text: string): string {
  if (!resolveImage) return text;
  const sub = (src: string): string | null => {
    if (!isLocalImageSrc(src)) return null;
    const resolved = resolvedImages.get(src);
    if (resolved === undefined) return IMG_PLACEHOLDER;
    return resolved === '' ? null : resolved;
  };
  return text
    .replace(MD_IMG_RE, (full, pre: string, src: string, post: string) => {
      const next = sub(src);
      return next === null ? full : `${pre}${next}${post}`;
    })
    .replace(HTML_IMG_RE, (full, pre: string, src: string, post: string) => {
      const next = sub(src);
      return next === null ? full : `${pre}${next}${post}`;
    });
}

// NOTE: comes after defineProps — watch() invokes its getter synchronously, so
// referencing `props` above its declaration would throw a TDZ ReferenceError.
watch(
  () => props.text,
  (text) => queueImageResolution(text ?? ''),
  { immediate: true },
);

function processFileLinks(): void {
  if (!mdRef.value || !props.openFile || props.streaming) return;
  const walker = document.createTreeWalker(mdRef.value, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const parent = text.parentElement;
    if (
      parent &&
      !parent.closest('a, pre, .md-file-link, svg') &&
      text.data.trim().length > 0
    ) {
      textNodes.push(text);
    }
    node = walker.nextNode();
  }

  for (const text of textNodes) {
    const matches = findFilePathLinks(text.data, { aliases: filePathAliases.value });
    if (matches.length === 0 || !text.parentNode) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) {
        frag.append(document.createTextNode(text.data.slice(cursor, match.start)));
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'md-file-link';
      button.textContent = match.text;
      button.title = match.line ? `${match.path}:${match.line}` : match.path;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        props.openFile?.({ path: match.path, line: match.line });
      });
      frag.append(button);
      cursor = match.end;
    }
    if (cursor < text.data.length) {
      frag.append(document.createTextNode(text.data.slice(cursor)));
    }
    text.parentNode.replaceChild(frag, text);
  }
}

function isLocalLink(href: string): boolean {
  if (!href) return false;
  if (/^(https?:|mailto:|tel:|data:|blob:|#)/i.test(href)) return false;
  return true;
}

/** Strip `?query` and `#fragment` from a link path so it can be opened as a
    workspace file. Pure `#anchor` links are skipped upstream by isLocalLink. */
function stripFragmentAndQuery(href: string): string {
  let cut = href.length;
  for (const sep of ['#', '?']) {
    const idx = href.indexOf(sep);
    if (idx !== -1 && idx < cut) cut = idx;
  }
  return href.slice(0, cut);
}

function processMarkdownLinks(): void {
  if (!mdRef.value || !props.openFile || props.streaming) return;
  const links = mdRef.value.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const link of links) {
    if (link.dataset.mdLinkHandled === 'true') continue;
    // Skip links inside Mermaid SVGs — their hrefs are diagram semantics, not
    // workspace file paths.
    if (link.closest('svg')) continue;
    const href = link.getAttribute('href') ?? '';
    if (!isLocalLink(href)) continue;
    link.dataset.mdLinkHandled = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      props.openFile?.({ path: stripFragmentAndQuery(href) });
    });
  }
}

function scheduleFileLinkProcessing(): void {
  void nextTick().then(() => {
    processFileLinks();
    processMarkdownLinks();
  });
}

watch(() => props.text, scheduleFileLinkProcessing);
watch(() => props.streaming, scheduleFileLinkProcessing);

let observer: MutationObserver | null = null;
onMounted(() => {
  scheduleFileLinkProcessing();
  if (mdRef.value) {
    observer = new MutationObserver(scheduleFileLinkProcessing);
    observer.observe(mdRef.value, { childList: true, subtree: true });
  }
});
onUnmounted(() => {
  observer?.disconnect();
});

// Shiki themes for code blocks: github-light on the light surface,
// github-dark when the app colour scheme is dark.
const CODE_LIGHT_THEME = 'github-light';
const CODE_DARK_THEME = 'github-dark';

// Props forwarded to each code block. markstream's CodeBlock ships its own
// header with a copy button + language label, so we keep the header + copy
// button (preserving our previous per-block copy affordance) and turn off the
// monaco-only buttons (expand / preview / font-size) that don't fit a chat.
//
// `loading: false` is the important one. markstream's CodeBlock shows a loading
// SKELETON whenever `!stream && loading`, and its `loading` prop DEFAULTS TO
// TRUE. We never set it, so every settled (non-streaming) code block sat in the
// skeleton state until shiki finished highlighting it — and when a screenful of
// code mounts at once (switching to a long session, or a fast burst of output)
// shiki can't keep up, so the skeletons get stuck and the whole page reads as
// blank placeholders. Pinning `loading` to false drops the skeleton entirely:
// the block renders its plain-text fallback immediately and shiki upgrades it to
// the highlighted version when the highlighter is ready. Streaming blocks are
// unaffected (their `stream` is true, so the skeleton gate was already false).
const codeBlockProps = {
  showHeader: true,
  showCopyButton: true,
  showExpandButton: false,
  showPreviewButton: false,
  showCollapseButton: false,
  showFontSizeButtons: false,
  loading: false,
};

function copyCodeBlockFallback(code: string): void {
  // markstream emits `copy` even when it skipped the write because the
  // Clipboard API is unavailable. Reuse our plain-HTTP fallback in that case,
  // while avoiding a duplicate write after markstream succeeds on HTTPS.
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') return;
  void copyTextToClipboard(code);
}

// Root cause for the "large session turns into code skeletons" failure:
// markstream mounts every code block in the loaded transcript, then shiki has
// to tokenize all of them. `loading: false` removes the visible skeleton gate,
// but it still leaves a long shiki queue on very large messages. Heavy messages
// therefore use markstream's plain <pre> renderer: no highlighter queue, no
// skeleton path, and the content remains immediately readable.

// ---------------------------------------------------------------------------
// ```diff fences are handled locally, NOT by markstream.
//
// markstream's parser treats a ```diff fence as a unified diff to *apply*: it
// strips the +/- markers and DROPS deletion lines, rendering only the post-apply
// result. For a chat where we want to *read* the diff (red/green +/- lines),
// that is content loss. So we split the text into diff fences vs. everything
// else: diff fences render with the local renderer below (markers + colours
// preserved), all other markdown goes through markstream.
// ---------------------------------------------------------------------------

type Segment =
  | { kind: 'md'; text: string }
  | { kind: 'diff'; code: string };

// Match a fenced ```diff block (``` or ~~~, optional info after `diff`). The
// closing fence must use the same marker. Capture group 2 is the body.
const DIFF_FENCE_RE = /(^|\n)(?:```|~~~)diff\b[^\n]*\n([\s\S]*?)(?:\n)?(?:```|~~~)(?=\n|$)/g;

const segments = computed<Segment[]>(() => {
  const text = rewriteImageSrcs(props.text ?? '');
  const out: Segment[] = [];
  let lastIndex = 0;
  DIFF_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIFF_FENCE_RE.exec(text)) !== null) {
    // Text before this diff fence (keep the leading newline the regex consumed
    // as a boundary out of the markdown segment).
    const lead = m[1] ?? '';
    const before = text.slice(lastIndex, m.index) + (lead ? lead : '');
    if (before.trim()) out.push({ kind: 'md', text: before });
    out.push({ kind: 'diff', code: m[2] ?? '' });
    lastIndex = DIFF_FENCE_RE.lastIndex;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim() || out.length === 0) out.push({ kind: 'md', text: tail });
  return out;
});

// Lines of a diff block, split into a sign + the code text so the row can be
// skinned like the ~/diff panel (DiffLines.vue): the code text keeps the normal
// ink colour and only the +/- sign carries the add/del colour. The leading
// marker (a single '+', '-', or the context-line space) is stripped from the
// text so the code columns line up. Escaped by Vue's text interpolation.
type DiffRowType = 'add' | 'del' | 'hunk' | 'ctx';
interface DiffRow {
  type: DiffRowType;
  sign: string;
  text: string;
}
function diffLines(code: string): DiffRow[] {
  return code.split('\n').map((line) => {
    if (line.startsWith('@@')) return { type: 'hunk', sign: '', text: line };
    if (/^\+(?!\+\+)/.test(line)) return { type: 'add', sign: '+', text: line.slice(1) };
    if (/^-(?!--)/.test(line)) return { type: 'del', sign: '-', text: line.slice(1) };
    if (line.startsWith(' ')) return { type: 'ctx', sign: '', text: line.slice(1) };
    return { type: 'ctx', sign: '', text: line };
  });
}

// Copy state for local diff blocks (keyed by segment index).
const copiedDiff = ref<number | null>(null);
function copyDiff(code: string, idx: number) {
  void copyTextToClipboard(code).then((ok) => {
    if (!ok) return;
    copiedDiff.value = idx;
    setTimeout(() => {
      copiedDiff.value = null;
    }, 1400);
  });
}
</script>

<template>
  <div ref="mdRef" class="md">
    <template v-for="(seg, i) in segments" :key="i">
      <!-- Non-diff markdown → markstream (smooth streaming + shiki) -->
      <MarkdownRender
        v-if="seg.kind === 'md'"
        :content="seg.text"
        :custom-markdown-it="disableInlineMath"
        mode="chat"
        :code-renderer="renderPlan.codeRenderer"
        :is-dark="isDark"
        :code-block-light-theme="CODE_LIGHT_THEME"
        :code-block-dark-theme="CODE_DARK_THEME"
        :themes="[CODE_LIGHT_THEME, CODE_DARK_THEME]"
        :code-block-props="codeBlockProps"
        :final="final"
        :smooth-streaming="streaming"
        :batch-rendering="allowBatchRender"
        :defer-nodes-until-visible="false"
        @copy="copyCodeBlockFallback"
      />

      <!-- ```diff fence → local renderer (preserves +/- markers + colours) -->
      <div v-else class="diff-wrap">
        <div class="diff-bar">
          <span class="diff-lang">diff</span>
          <Tooltip :text="t('filePreview.copyCode')">
            <button class="diff-copy" :aria-label="t('filePreview.copyCode')" @click="copyDiff(seg.code, i)">
              <Icon :name="copiedDiff === i ? 'check' : 'copy'" size="sm" />
            </button>
          </Tooltip>
        </div>
        <pre class="diff-pre"><code><span
          v-for="(ln, j) in diffLines(seg.code)"
          :key="j"
          class="diff-line"
          :class="`diff-${ln.type}`"
        ><span v-if="ln.type !== 'hunk'" class="diff-sign">{{ ln.sign }}</span><span class="diff-text">{{ ln.text }}</span></span></code></pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------------------
   Terminal Pro skin over markstream-vue.

   markstream's CSS is namespaced under `.markstream-vue` / `.markdown-renderer`
   so it does not leak globally; here we override those classes (scoped under
   our `.md` container) to match the rest of the app: the UI font for prose,
   semantic `--color-*` text, our spacing, a sunken `--color-line`-bordered code
   block, and the accent inline-code chip. Overrides target the markstream
   classes via :deep(). Fonts use the `font:` shorthand throughout.
--------------------------------------------------------------------------- */

/* Base prose — assistant message text. */
.md {
  font: 400 15px/1.6 var(--font-ui);
  color: var(--color-text);
  word-break: break-word;
}
.md :deep(.markdown-renderer) {
  font: 400 15px/1.6 var(--font-ui);
  color: var(--color-text);
}
.md :deep(.markstream-vue),
.md :deep(.markdown-renderer) {
  --code-bg: var(--color-surface-sunken);
  --code-fg: var(--color-text);
  --code-border: var(--color-line);
  --code-header-bg: var(--color-surface);
  --code-action-fg: var(--color-text-muted);
  --code-action-hover-fg: var(--color-accent);
  --markstream-code-fallback-bg: var(--color-surface-sunken);
  --markstream-code-fallback-fg: var(--color-text);
  --markstream-code-border-color: var(--color-line);
  --inline-code-bg: var(--color-surface-sunken);
  --inline-code-fg: var(--color-fg);
  --inline-code-border: transparent;
}
.md :deep(.md-file-link) {
  appearance: none;
  display: inline;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--color-accent-hover);
  font: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  cursor: pointer;
}
.md :deep(.md-file-link:hover) {
  color: var(--color-accent);
}
/* Pin the prose text size explicitly. markstream sets no font-size of its own,
   so without this the rendered <p>/<li> can pick up a different base size. */
.md :deep(.markdown-renderer p),
.md :deep(.markdown-renderer li),
.md :deep(.markdown-renderer blockquote),
.md :deep(.markdown-renderer td),
.md :deep(.markdown-renderer th) {
  font-size: var(--content-font-size);
}

/* Emphasis — keep the weight strong, but soften the ink slightly. */
.md :deep(strong) {
  color: color-mix(in srgb, var(--color-text) 86%, var(--color-text-muted));
  font-weight: var(--weight-semibold);
}

/* Headings */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  color: var(--color-text);
  font-optical-sizing: auto;
  font-weight: 600;
  margin: 0.85em 0 0.35em;
  line-height: var(--leading-tight);
}
.md :deep(h1) { font-size: max(var(--text-xl), calc(var(--content-font-size) + 3px)); border-bottom: 1px solid var(--color-line); padding-bottom: 4px; }
.md :deep(h2) { font-size: max(var(--text-lg), calc(var(--content-font-size) + 2px)); }
.md :deep(h3) { font-size: max(var(--text-lg), calc(var(--content-font-size) + 1px)); }
.md :deep(h4) { font-size: max(var(--text-base), calc(var(--content-font-size) + 1px)); color: var(--color-text-muted); }

/* Paragraphs */
.md :deep(p) {
  margin: 0.8rem 0;
}

/* Spacing between top-level content blocks — markstream wraps each one
   (paragraph, list, heading, code block, …) in a `.node-slot`. Set to the
   largest inner block margin (0.8rem) so it collapses evenly into a uniform gap
   regardless of block type; going lower would let the inner margins take over
   and make spacing uneven. */
.md :deep(.node-slot + .node-slot) {
  margin-top: 0.8rem;
}

/* Lists */
.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.4em;
  margin: 0.6em 0;
}
.md :deep(li) {
  margin: 0.3em 0;
}

/* Inline code — small mono chip */
.md :deep(:not(pre) > code),
.md :deep(.inline-code) {
  font: .9em var(--font-mono);
  background: var(--color-surface-sunken);
  color: var(--color-fg);
  padding: 0 4px;
  border-radius: var(--radius-sm);
}
.md :deep(strong code),
.md :deep(strong .inline-code),
.md :deep(b code),
.md :deep(b .inline-code) {
  font-weight: var(--weight-semibold);
}

/* ---------------------------------------------------------------------------
   Code blocks — sunken surface, 1px line border, radius md, soft shadow, plus
   our language label + copy button (markstream's built-in header).
--------------------------------------------------------------------------- */
.md :deep(.code-block-container) {
  margin: 0.6em 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  --vscode-editor-font-size: var(--text-sm);
  --vscode-editor-line-height: calc(var(--text-sm) * 1.65);
}
.md :deep(.code-block-header) {
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  padding: 4px 12px;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
}
.md :deep(.code-block-header *) {
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
}
.md :deep(.code-block-header .code-header-main) {
  font-family: var(--font-ui);
}
/* Copy button — mirrors the §03 IconButton: muted glyph, sunken hover, soft
   radius, and the shared focus ring. markstream renders its own button, so we
   restyle it in place instead of swapping in the IconButton primitive. */
.md :deep(.code-block-header .copy-button),
.md :deep(.code-block-header .code-action-btn) {
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.md :deep(.code-block-header .copy-button:hover),
.md :deep(.code-block-header .code-action-btn:hover) {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.md :deep(.code-block-header .copy-button:focus-visible),
.md :deep(.code-block-header .code-action-btn:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md :deep(.code-block-header .copy-button *),
.md :deep(.code-block-header .code-action-btn *) {
  pointer-events: none;
}
.md :deep(.code-block-content),
.md :deep(.markstream-pre) {
  background: var(--color-surface-sunken);
}
.md :deep(.code-block-container pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)),
.md :deep(.markstream-pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)) {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font: var(--text-sm)/1.65 var(--font-mono);
}
.md :deep(.code-block-container pre code) {
  font: inherit;
  color: var(--color-text);
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
}
.md :deep(.markstream-pre),
.md :deep(.code-pre-fallback),
.md :deep(.code-block-content pre:not(.shiki)),
.md :deep(.code-block-content pre:not(.shiki) code) {
  color: var(--color-text);
}

/* Links — open in a new tab (markstream handles target/rel) */
.md :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}
.md :deep(a:hover) {
  text-decoration: underline;
}

/* KaTeX math. Colour already inherits (--color-text) since KaTeX draws with
   currentColor, so the only skinning needed is layout: let a wide display
   formula scroll inside its own box instead of overflowing the chat column and
   breaking the mobile layout. Inline math stays in the text flow. */
.md :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  /* room for the horizontal scrollbar so it doesn't clip the bottom of the
     formula (e.g. integral/sum subscripts) */
  padding: 2px 0 6px;
  margin: 0.6em 0;
}

/* Blockquote */
.md :deep(blockquote) {
  margin: 0.5em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--color-line);
  color: var(--color-text-muted);
}

/* HR */
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-line);
  margin: 0.8em 0;
}

/* Tables. markstream-vue renders markdown tables as `.table-node` and relies on
   its own table layout/border model. The rules below are a generic fallback for
   raw HTML tables only; `.table-node` itself is styled further down. */
.md :deep(table:not(.table-node)) {
  border-collapse: collapse;
  font-size: var(--text-lg);
  margin: 0.5em 0;
}
.md :deep(table:not(.table-node) th),
.md :deep(table:not(.table-node) td) {
  border: 1px solid var(--color-line);
  padding: 4px 10px;
  text-align: left;
}
.md :deep(table:not(.table-node) th) {
  background: var(--color-surface);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

/* Markdown tables — wide tables scroll horizontally INSIDE the table's own
   wrapper instead of squeezing into (or overflowing) the reading column.
   The wrapper is a fixed-width local scroll container: it stays pinned to the
   message width (`width:100%`, `min-width:0` so it can shrink inside flex
   tracks) and clips any overflow behind its own `overflow-x:auto` scrollbar —
   the chat pane and the page never scroll sideways. The table itself grows to
   its content width (`width:max-content`, `max-width:none`,
   `table-layout:auto`), so many-column or long-cell tables keep their natural
   layout and only the excess scrolls within the wrapper. `min-width:100%` keeps
   narrow tables stretched to fill the wrapper exactly as before. `!important`
   beats markstream's scoped `.table-node[data-v-…]` rules regardless of
   injection order. */
.md :deep(.table-node-wrapper) {
  width: 100%;
  max-width: 100% !important;
  min-width: 0;
  overflow-x: auto !important;
}

.md :deep(.table-node) {
  --table-border: var(--color-line);
  --table-header-bg: var(--color-surface);
  font-size: var(--text-lg);
  margin: 0.5em 0;
  width: max-content !important;
  min-width: 100%;
  max-width: none !important;
  table-layout: auto !important;
}
.md :deep(.table-node th),
.md :deep(.table-node td) {
  text-align: left;
  vertical-align: top;
  /* Cap runaway columns: a single cell with long prose should stop stretching
     its column at --p-table-cell-max and wrap inside the cell instead.
     max-width on the cell itself only works in Firefox — Chromium ignores it
     under table-layout:auto — so the clamp is reinforced on the content box
     below. Wider tables made of many columns still scroll inside the
     wrapper. */
  max-width: var(--p-table-cell-max);
}
/* Chromium honors max-width on this inner box even under table-layout:auto:
   markstream wraps plain-text cell content in a .text-node span, and as an
   inline-block its max-content contribution to the column is clamped to
   --p-table-cell-max, so the column stops there and the text wraps inside
   (the span is already white-space:pre-wrap + overflow-wrap:break-word).
   Cells mixing several inline children can still exceed the cap by the sum
   of those children — acceptable; the runaway single-prose-cell case is the
   one that matters. */
.md :deep(.table-node .text-node) {
  display: inline-block;
  max-width: var(--p-table-cell-max);
  vertical-align: top;
}

/* Drop markstream-vue's default table-row hover background — the conversation
   tables are read-only, so the hover highlight is just noise. Its rule is the
   component-scoped `.table-node[data-v-…] tbody tr:hover` (a CLASS, not the
   `table-node` element the old override targeted, which is why the hover still
   showed). Match the class and use !important to win regardless of the order
   the scoped component style is injected. */
.md :deep(.table-node) tbody tr:hover {
  background-color: transparent !important;
}

/* ---------------------------------------------------------------------------
   Local ```diff renderer — same chrome as the code blocks above, with the
   diff rows skinned like the ~/diff panel (DiffLines.vue): a soft row
   background and an inset accent bar mark the change, the +/- sign carries
   the colour, and the code text itself keeps the normal ink colour so it
   stays legible. markstream would strip the markers + drop deletions, so we
   render diffs ourselves.
--------------------------------------------------------------------------- */
.diff-wrap {
  margin: 0.6em 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}
.diff-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
}
.diff-lang {
  margin-right: auto;
}
/* Copy button — mirrors the §03 IconButton / code-block action: muted glyph,
   sunken hover, soft radius, shared focus ring. */
.diff-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  padding: 2px 6px;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.diff-copy:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.diff-copy:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.diff-pre {
  margin: 0;
  padding: 12px 0;
  overflow-x: auto;
  background: var(--color-surface-sunken);
}
.diff-pre code {
  display: block;
  width: max-content;
  min-width: 100%;
  font: var(--text-sm)/1.65 var(--font-mono);
  color: var(--color-text);
}
.diff-line {
  display: block;
  width: 100%;
  padding: 0 14px;
}
.diff-sign {
  display: inline-block;
  width: 14px;
  text-align: center;
  color: var(--color-text-muted);
  user-select: none;
}
.diff-text {
  color: var(--color-text);
}
.diff-add {
  background: var(--color-success-soft);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-success) 55%, transparent);
}
.diff-add .diff-sign {
  color: var(--color-success);
}
.diff-del {
  background: var(--color-danger-soft);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-danger) 55%, transparent);
}
.diff-del .diff-sign {
  color: var(--color-danger);
}
.diff-hunk {
  background: var(--color-surface);
}
.diff-hunk .diff-text {
  color: var(--color-text-muted);
}

.md,
.md .markdown-renderer {
  font-family: var(--sans);
}
.md .code-block-container { border-radius: var(--radius-md); }
.md .diff-wrap { border-radius: var(--radius-md); }
.md :not(pre) > code,
.md .inline-code { border-radius: var(--radius-sm); }
</style>
