<!-- apps/kimi-web/src/components/Markdown.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MarkdownRender } from 'markstream-vue';
import { useIsDark } from '../composables/useIsDark';
import type { FilePreviewRequest } from '../types';
import { collectFilePathAliases, findFilePathLinks } from '../lib/filePathLinks';
import { markdownRenderPlan } from '../lib/markdownPerformance';
// px-based CSS build (our app is px, not rem). Imported here so the styles
// load wherever Markdown is used; scoped overrides below re-skin it to
// Terminal Pro. Importing the same file from multiple components is a no-op
// after the first (Vite dedups the CSS import).
import 'markstream-vue/index.px.css';

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
      !parent.closest('a, pre, .md-file-link') &&
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

// Lines of a diff block, classed by +/- for colouring (escaped by Vue's text
// interpolation in the template).
function diffLines(code: string): { cls: string; text: string }[] {
  return code.split('\n').map((line) => {
    if (/^\+(?!\+\+)/.test(line)) return { cls: 'diff-add', text: line };
    if (/^-(?!--)/.test(line)) return { cls: 'diff-del', text: line };
    if (line.startsWith('@@')) return { cls: 'diff-hunk', text: line };
    return { cls: 'diff-ctx', text: line };
  });
}

// Copy state for local diff blocks (keyed by segment index).
const copiedDiff = ref<number | null>(null);
function copyDiff(code: string, idx: number) {
  navigator.clipboard
    .writeText(code)
    .then(() => {
      copiedDiff.value = idx;
      setTimeout(() => {
        copiedDiff.value = null;
      }, 1400);
    })
    .catch(() => {
      /* ignore */
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
      />

      <!-- ```diff fence → local renderer (preserves +/- markers + colours) -->
      <div v-else class="diff-wrap">
        <div class="diff-bar">
          <span class="diff-lang">diff</span>
          <button class="diff-copy" :title="t('filePreview.copyCode')" @click="copyDiff(seg.code, i)">
            {{ copiedDiff === i ? '✓' : '⧉' }}
          </button>
        </div>
        <pre class="diff-pre"><code><span
          v-for="(ln, j) in diffLines(seg.code)"
          :key="j"
          :class="ln.cls"
        >{{ ln.text }}</span></code></pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ---------------------------------------------------------------------------
   Terminal Pro skin over markstream-vue.

   markstream's CSS is namespaced under `.markstream-vue` / `.markdown-renderer`
   so it does not leak globally; here we override those classes (scoped under
   our `.md` container) to match the rest of the app: mono font, --ink text,
   our spacing, a light --line-bordered code block, and the blue inline-code
   chip. Overrides target the markstream classes via :deep().
--------------------------------------------------------------------------- */

/* Base prose — matched to the sidebar session-title size (14px). */
.md {
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
  font-weight: 500;
}
.md :deep(.markdown-renderer) {
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  line-height: 1.6;
  color: var(--text);
  font-weight: 500;
}
.md :deep(.markstream-vue),
.md :deep(.markdown-renderer) {
  --code-bg: var(--panel);
  --code-fg: var(--text);
  --code-border: var(--line);
  --code-header-bg: var(--panel2);
  --code-action-fg: var(--muted);
  --code-action-hover-fg: var(--blue);
  --markstream-code-fallback-bg: var(--panel);
  --markstream-code-fallback-fg: var(--text);
  --markstream-code-border-color: var(--line);
  --inline-code-bg: var(--panel2);
  --inline-code-fg: var(--blue2);
  --inline-code-border: var(--line);
}
.md :deep(.md-file-link) {
  appearance: none;
  display: inline;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--blue2);
  font: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  cursor: pointer;
}
.md :deep(.md-file-link:hover) {
  color: var(--blue);
}
/* Pin the prose text to the session-title size (14px) explicitly. markstream
   sets no font-size of its own, so without this the rendered <p>/<li> can pick
   up the (larger) UI base font instead of the .markdown-renderer size. */
.md :deep(.markdown-renderer p),
.md :deep(.markdown-renderer li),
.md :deep(.markdown-renderer blockquote),
.md :deep(.markdown-renderer td),
.md :deep(.markdown-renderer th) {
  font-size: var(--ui-font-size);
}

/* Headings */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  color: var(--ink);
  font-weight: 700;
  margin: 0.85em 0 0.35em;
  line-height: 1.3;
}
.md :deep(h1) { font-size: calc(var(--ui-font-size) + 3px); border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.md :deep(h2) { font-size: calc(var(--ui-font-size) + 2px); }
.md :deep(h3) { font-size: calc(var(--ui-font-size) + 1px); }
.md :deep(h4) { font-size: var(--ui-font-size); color: var(--dim); }

/* Paragraphs */
.md :deep(p) {
  margin: 0.4em 0;
}

/* Lists */
.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.4em;
  margin: 0.4em 0;
}
.md :deep(li) {
  margin: 0.15em 0;
}

/* Inline code — small blue chip (matches the old marked output) */
.md :deep(:not(pre) > code),
.md :deep(.inline-code) {
  font-family: var(--mono);
  font-size: var(--ui-font-size-sm);
  background: var(--panel2);
  color: var(--blue2);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--line);
}

/* ---------------------------------------------------------------------------
   Code blocks — light surface, 1px --line border, rounded, our language label
   + copy button (markstream's built-in header).
--------------------------------------------------------------------------- */
.md :deep(.code-block-container) {
  margin: 0.6em 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  overflow: hidden;
  --markstream-code-font-family: var(--mono);
  --vscode-editor-font-size: var(--ui-font-size);
  --vscode-editor-line-height: calc(var(--ui-font-size) * 1.5);
}
.md :deep(.code-block-header) {
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
  padding: 3px 8px;
  min-height: 0;
  color: var(--muted);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  letter-spacing: 0.04em;
}
.md :deep(.code-block-header *) {
  color: var(--muted);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
}
/* Copy button in the header */
.md :deep(.code-block-header .copy-button),
.md :deep(.code-block-header .code-action-btn) {
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
}
.md :deep(.code-block-header .copy-button:hover),
.md :deep(.code-block-header .code-action-btn:hover) {
  color: var(--blue);
}
.md :deep(.code-block-header .copy-button *),
.md :deep(.code-block-header .code-action-btn *) {
  pointer-events: none;
}
.md :deep(.code-block-content),
.md :deep(.markstream-pre) {
  background: var(--panel);
}
.md :deep(.code-block-container pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)),
.md :deep(.markstream-pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
}
.md :deep(.code-block-container pre code) {
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  color: var(--text);
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
}
.md :deep(.markstream-pre),
.md :deep(.code-pre-fallback),
.md :deep(.code-block-content pre:not(.shiki)),
.md :deep(.code-block-content pre:not(.shiki) code) {
  color: var(--text);
}

/* Links — open in a new tab (markstream handles target/rel) */
.md :deep(a) {
  color: var(--blue);
  text-decoration: none;
}
.md :deep(a:hover) {
  text-decoration: underline;
}

/* Blockquote */
.md :deep(blockquote) {
  margin: 0.5em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--line);
  color: var(--dim);
}

/* HR */
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 0.8em 0;
}

/* Tables. markstream-vue renders markdown tables as `.table-node` and relies on
   its own table layout/border model. Keep this generic fallback for any raw
   HTML tables only; skin `.table-node` without overriding its structure. */
.md :deep(table:not(.table-node)) {
  border-collapse: collapse;
  font-size: var(--ui-font-size);
  margin: 0.5em 0;
}
.md :deep(table:not(.table-node) th),
.md :deep(table:not(.table-node) td) {
  border: 1px solid var(--line);
  padding: 4px 10px;
  text-align: left;
}
.md :deep(table:not(.table-node) th) {
  background: var(--panel2);
  color: var(--ink);
  font-weight: 600;
}
.md :deep(.table-node) {
  --table-border: var(--line);
  --table-header-bg: var(--panel2);
  font-size: var(--ui-font-size);
  margin: 0.5em 0;
}
.md :deep(.table-node th),
.md :deep(.table-node td) {
  text-align: left;
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
   Local ```diff renderer — same look as the code blocks above, with the
   original +/- line colouring (green additions, red deletions). markstream
   would strip the markers + drop deletions, so we render diffs ourselves.
--------------------------------------------------------------------------- */
.diff-wrap {
  margin: 0.6em 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  overflow: hidden;
}
.diff-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 3px 8px;
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
}
.diff-lang {
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--muted);
  margin-right: auto;
  letter-spacing: 0.04em;
}
.diff-copy {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-size: var(--ui-font-size-sm);
  padding: 0 2px;
  line-height: 1;
  font-family: var(--mono);
}
.diff-copy:hover {
  color: var(--blue);
}
.diff-pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  background: var(--panel);
}
.diff-pre code {
  font-family: var(--mono);
  font-size: var(--ui-font-size);
}
.diff-pre code span {
  display: block;
  padding-left: 8px;
  border-left: 2px solid transparent;
  margin-left: -12px;
  padding-right: 12px;
}
.diff-add {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
  border-left-color: var(--ok) !important;
}
.diff-del {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 7%, transparent);
  border-left-color: var(--err) !important;
}
.diff-hunk {
  color: var(--blue);
}
.diff-ctx {
  color: var(--dim);
}
</style>
