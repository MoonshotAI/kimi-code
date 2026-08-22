<!-- @moonshot-ai/app-markdown — Markdown.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import { MarkdownRender, enableKatex, enableMermaid } from 'markstream-vue';
import { ensureMarkdownWorkers } from './lib/markdownWorkers';
import { useIsDark } from '@moonshot-ai/app-core';
import type { ResolveImage } from '@moonshot-ai/app-core/contracts';
import { classifyMentionHref, decodeSkillName, fileMentionIconSvg, mentionActionPath, mentionHrefToPath, mentionIconSvg, truncateMentionName, unescapeRenderedLinkText } from '@moonshot-ai/app-composer';
import { collectFilePathAliases, findFilePathLinks } from './lib/filePathLinks';
import { splitFrontmatter } from './lib/frontmatter';
import { configureMarkdownIt } from './lib/inlineMath';
import { markdownRenderPlan } from './lib/markdownPerformance';
import { copyCodeBlockFallback, copyTextToClipboard } from './lib/clipboard';
import { CODE_BLOCK_UNSAFE_CSS, diffWrapKeys, ensureCodeBlockToggles, ensureCodeCopyTooltip, pruneWrapKeys, toggleWrapIndex, type CodeBlockToggleLabels } from './lib/codeWrap';
import { ensureCodeTooltip, hideCodeTooltipIfAnchorGone, hideCodeTooltipIfAnchorWithin } from './lib/codeTooltip';
import {
  ensureTableWideToggle,
  updateTableWideToggle,
  type TableWideToggleLabels,
} from './lib/tableWide';

// Shape of the `openFile` prop payload. Declared locally so the package has no
// reverse dependency on the host app's types; structurally compatible with the
// host's `FilePreviewRequest` (`{ path: string; line?: number }`).
interface FilePreviewRequest {
  path: string;
  line?: number;
}
import { Icon, IconButton, Tooltip } from '@moonshot-ai/app-ui';
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

// Off-main-thread KaTeX/Mermaid workers: one shared process-wide pair, created
// once by the once-guard in lib/markdownWorkers.ts. Mounting/unmounting any
// number of Markdown instances re-runs this line but never tears the pair
// down — a previous per-instance clear+set here terminated the shared workers
// (aborting every other mounted message's in-flight renders) and rebuilt them
// on each mount.
ensureMarkdownWorkers();

const { t } = useKimiI18n();

const resolveImage = inject<ResolveImage>('resolveImage');
const mdRef = ref<HTMLElement | null>(null);
const props = withDefaults(
  defineProps<{
    text: string;
    openFile?: (target: FilePreviewRequest) => void;
    /**
     * Resolve a mention pill's decoded link path before it lands in
     * dataset.mentionPath (tooltip text, copy button, existence probe).
     * Hosts rendering a Markdown FILE (FilePreview) pass a resolver that
     * maps relative link targets onto that file's directory, so the global
     * mention tooltip — which probes from the workspace root — sees the
     * real path. Display only: the click target still flows through
     * openFile unchanged. Absent → the decoded path is used as-is.
     */
    resolveMentionPath?: (path: string) => string;
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

// YAML frontmatter is split off BEFORE anything parses the text: markstream/
// markdown-it has no frontmatter support, so an intact block renders the
// opening `---` as an <hr> and the closing `---` as a setext underline that
// swallows the metadata into a giant <h2>. Every downstream consumer — file
// aliases, render plan, image rewriting, diff segmentation — only ever sees
// the body; the raw YAML renders as a plain meta block above it (template).
const frontmatterSplit = computed(() => splitFrontmatter(props.text ?? ''));
const frontmatter = computed(() => frontmatterSplit.value.frontmatter);
const markdownBody = computed(() => frontmatterSplit.value.body);

const filePathAliases = computed(() => collectFilePathAliases(markdownBody.value));
const renderPlan = computed(() => {
  // While a turn is actively streaming, never downgrade the code renderer:
  // markstream keys each code block on the renderer value, so flipping
  // shiki→pre mid-stream remounts every block (visible jitter + lost
  // highlighting) right in the "fast output" scenario this is meant to fix.
  // Plan for heaviness only once the turn has settled — already-loaded history
  // is never `streaming`, so the large/heavy-session case still gets `pre`.
  if (props.streaming) return { codeRenderer: 'shiki' as const, codeFenceCount: 0, codeChars: 0 };
  return markdownRenderPlan(markdownBody.value);
});

// Code blocks follow the app colour scheme (shiki re-renders on flip). Resolved
// directly from app-core's colour-scheme singleton (no host provide/inject
// bridge); falls back to light when the document carries no scheme.
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
  markdownBody,
  (body) => queueImageResolution(body),
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

function processMarkdownLinks(): void {
  if (!mdRef.value || props.streaming) return;
  const links = mdRef.value.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const link of links) {
    if (link.dataset.mdLinkHandled === 'true') continue;
    // Skip links inside Mermaid SVGs — their hrefs are diagram semantics, not
    // workspace file paths.
    if (link.closest('svg')) continue;
    const href = link.getAttribute('href') ?? '';
    // Local links (workspace paths, kimi-code://skill/…) render as mention
    // pills — the same vocabulary as the composer's atoms. External and
    // in-page-anchor links stay ordinary.
    const kind = classifyMentionHref(href);
    if (kind === null) continue;
    // A clickable thumbnail ([![alt](thumb.png)](full.png)) keeps its <img>
    // subtree — pill decoration would replace the link's children with a name
    // span and erase it.
    if (link.querySelector('img')) continue;
    link.dataset.mdLinkHandled = 'true';
    // An author-set title ([README](README.md "Documentation")) would double
    // up with the mentionTooltip bubble — pills never keep a native title.
    link.removeAttribute('title');
    // File/folder hrefs are raw workspace paths: `#`/`?` are legitimate
    // filename characters, so the DISPLAY path (dataset.mentionPath —
    // tooltip, copy) keeps them via a single decodeURIComponent
    // (mentionHrefToPath; the composer escapes `%` as `%25` and Markdown
    // rendering percent-encodes spaces/non-ASCII, so one decode restores
    // the real filesystem path). Only ACTION sites (the click below, the
    // mentionTooltip probe) strip an unencoded `#`/`?` tail
    // (mentionActionPath) so `[Usage](README.md#usage)` opens README.md.
    // Skill hrefs (kimi-code://skill/<encoded name>) keep their URL form —
    // nothing resolves them as paths.
    const path = kind === 'skill' ? href : mentionHrefToPath(href);
    // The rendered link text is the WIRE label after the renderer consumed
    // the CommonMark backslash layer — decode only the serializer's private
    // percent layers (unescapeRenderedLinkText): a real 'a%20b.md' would
    // otherwise show as 'a%2520b.md', and a literal backslash in the name
    // (a\[b.md) must survive (unescapeLinkText would strip it a second time).
    const name = unescapeRenderedLinkText(link.textContent ?? '');
    link.classList.add('mention-pill', `mention-${kind}`);
    // Hover tooltip + skill-click routing read these (mentionTooltip
    // singleton); no native title — that would double up with the bubble.
    // A skill pill's identity is the link TARGET's tail, not the label
    // (`[发布](kimi-code://skill/deploy)` must resolve 'deploy') — same as
    // parseMentionLinks on the composer side; the label is display-only.
    link.dataset.mentionKind = kind;
    link.dataset.mentionName = kind === 'skill' ? decodeSkillName(href) : name;
    // File/folder pills carry the host-resolved path when a resolver is
    // provided (FilePreview maps relative targets onto the previewed file's
    // directory) so the workspace-rooted tooltip probe/copy see it too.
    link.dataset.mentionPath = kind === 'skill' ? path : (props.resolveMentionPath?.(path) ?? path);
    // …and, when it differs, the exact ACTION variant (read by the
    // mentionTooltip probe as data-mention-action-path): strip the
    // fragment/query on the RAW href first — a literal '#'- or '?'-filename
    // survives — then decode and host-resolve. The display path alone can't
    // tell a fragment tail from a filename character.
    if (kind !== 'skill') {
      const actionPath =
        props.resolveMentionPath?.(mentionHrefToPath(mentionActionPath(href))) ??
        mentionHrefToPath(mentionActionPath(href));
      if (actionPath !== link.dataset.mentionPath) link.dataset.mentionActionPath = actionPath;
    }
    // Link navigation ends here for routed surfaces: a pill on a host with
    // openFile and EVERY skill pill act through app routes (the preview
    // panel / mentionTooltip's skill activation), never through the browser
    // — keeping the href would leave middle-click and the context menu's
    // "open in new tab" navigating a workspace path (or kimi-code://) as a
    // web URL. The href goes; explicit tabIndex + button role keep the pill
    // in the keyboard order with honest semantics (Enter/Space on a file
    // pill fire the action below; skill pills are routed by mentionTooltip's
    // document-level keydown). Folder pills stay inert: the href is dropped
    // where the host can open files (Tab/Enter must not land on a dead
    // link) and kept as a plain navigation fallback on surfaces WITHOUT
    // openFile (UpdateIndicator, QuestionCard — there a dead static text is
    // worse than a plain navigation, so file pills keep theirs too).
    // Class/dataset stay for styling and the tooltip; idempotency is
    // unaffected — the href-less pill simply falls out of the a[href]
    // selection on re-runs, with mdLinkHandled already set.
    if (kind === 'skill' || props.openFile) link.removeAttribute('href');
    if (kind === 'skill' || (kind === 'file' && props.openFile)) {
      link.tabIndex = 0;
      link.setAttribute('role', 'button');
    }
    // Over-long labels middle-truncate (extension preserved); the full name
    // stays in the data attributes and the tooltip carries the full path.
    const displayName = truncateMentionName(name);
    // The display name lives in a .mention-pill-name span, not an anonymous
    // text node — the shared max-width/ellipsis rules only reach the span,
    // and a nowrap pill must not stretch a narrow message column.
    const label = document.createElement('span');
    label.className = 'mention-pill-name';
    label.textContent = displayName;
    link.replaceChildren(label);
    if (!link.querySelector('.mention-pill-icon')) {
      const icon = document.createElement('span');
      icon.className = 'mention-pill-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML =
        kind === 'skill'
          ? mentionIconSvg('skill', '', name)
          : fileMentionIconSvg(path, name, kind === 'folder');
      link.prepend(icon);
    }
    link.addEventListener('click', (event) => {
      // Hosts without an openFile handler (UpdateIndicator, QuestionCard, …)
      // keep the link's default behavior — swallowing the click would turn it
      // into a dead link. Skill pills are the exception: their click is always
      // routed (and swallowed) by the mentionTooltip singleton.
      if (kind !== 'skill' && !props.openFile) return;
      event.preventDefault();
      event.stopPropagation();
      // Only files have a click target today (the preview panel); folder and
      // skill pills are inert. The click is an ACTION: strip an unencoded
      // `#`/`?` tail from the raw href, then decode (see mentionActionPath) —
      // dataset.mentionPath above keeps the full display path.
      if (kind === 'file') props.openFile?.({ path: mentionHrefToPath(mentionActionPath(href)) });
    });
    if (kind === 'file' && props.openFile) {
      // The href is gone (above), so the anchor no longer activates on
      // Enter — and role=button owes Space too. Both fire the same action
      // as the click.
      link.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        props.openFile?.({ path: mentionHrefToPath(mentionActionPath(href)) });
      });
    }
  }
}

// Widen-table toggles — injected into each `.table-node-wrapper` (only inside
// the ChatPane assistant-message host, see tableWide.ts). Same lifecycle as
// the file-link processing above: skip while streaming (markstream keeps
// rebuilding the table DOM mid-stream), then settle once the turn ends.
function tableWideLabels(): TableWideToggleLabels {
  return {
    widen: t('conversation.widenTable'),
    restore: t('conversation.restoreTableWidth'),
  };
}

function processTableWideToggles(): void {
  if (!mdRef.value || props.streaming) return;
  const labels = tableWideLabels();
  for (const wrapper of mdRef.value.querySelectorAll<HTMLElement>('.table-node-wrapper')) {
    ensureTableWideToggle(wrapper, labels);
  }
}

// Header toggles (line numbers + word wrap) — injected into each
// `.code-block-container`'s header action row (see codeWrap.ts). Same
// lifecycle as the table-wide toggles above: skip while streaming (markstream
// keeps rebuilding block DOM mid-stream, and an injected control must never
// disturb the streaming highlight path), then settle once the turn ends.
function codeBlockToggleLabels(): CodeBlockToggleLabels {
  return {
    wrap: t('conversation.wrapCode'),
    unwrap: t('conversation.unwrapCode'),
    showNums: t('conversation.showLineNumbers'),
    hideNums: t('conversation.hideLineNumbers'),
    copy: t('filePreview.copyCode'),
  };
}

function processCodeBlockToggles(): void {
  if (!mdRef.value || props.streaming) return;
  const labels = codeBlockToggleLabels();
  for (const container of mdRef.value.querySelectorAll<HTMLElement>('.code-block-container')) {
    ensureCodeBlockToggles(container, labels);
  }
}

// Copy-button tooltips — markstream's own bubble is English-only and disabled
// (showTooltips: false), so the header copy button gets a localized
// data-md-tip attribute here (served by the codeTooltip singleton). Unlike
// the wrap toggle this ALSO runs while streaming: the copy button is live
// mid-stream, and the stamp is idempotent + attribute-only (it cannot loop
// the observer), so markstream rebuilding block DOM mid-stream is harmless —
// the next pass re-stamps whatever was recreated.
function processCodeCopyTooltips(): void {
  if (!mdRef.value) return;
  const copy = t('filePreview.copyCode');
  for (const container of mdRef.value.querySelectorAll<HTMLElement>('.code-block-container')) {
    ensureCodeCopyTooltip(container, copy);
  }
}

function updateTableWideToggles(): void {
  // Skip while streaming: the .md root resizes constantly mid-stream and each
  // update measures header rects (forced reflow) — pointless, because toggle
  // injection itself is deferred until the turn settles.
  if (!mdRef.value || props.streaming) return;
  for (const wrapper of mdRef.value.querySelectorAll<HTMLElement>('.table-node-wrapper')) {
    updateTableWideToggle(wrapper);
  }
}

function scheduleFileLinkProcessing(): void {
  void nextTick().then(() => {
    // A streaming re-render may have removed the tooltip's anchor without a
    // mouseout — close the stale bubble on the same pass.
    hideCodeTooltipIfAnchorGone();
    processFileLinks();
    processMarkdownLinks();
    processTableWideToggles();
    processCodeCopyTooltips();
    processCodeBlockToggles();
  });
}

watch(() => props.text, scheduleFileLinkProcessing);
watch(() => props.streaming, scheduleFileLinkProcessing);
// Locale switch: t() tracks the active locale inside a watcher getter, so
// this fires on language change and re-labels every injected toggle
// (ensureCodeBlockToggles refreshes existing buttons; the local diff toggle
// labels are template bindings and re-render on their own).
watch(
  () => [
    t('conversation.wrapCode'),
    t('conversation.unwrapCode'),
    t('conversation.showLineNumbers'),
    t('conversation.hideLineNumbers'),
    t('filePreview.copyCode'),
  ],
  () => {
    processCodeCopyTooltips();
    processCodeBlockToggles();
  },
);

let observer: MutationObserver | null = null;
// Column-width changes alter whether each table overflows its wrapper, so the
// toggle's visibility is re-evaluated whenever the markdown root resizes.
let tableWideResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  // The document-level tooltip singleton serving the injected header buttons
  // (data-md-tip) — idempotent, one bubble + one listener set for the app.
  ensureCodeTooltip();
  scheduleFileLinkProcessing();
  if (mdRef.value) {
    observer = new MutationObserver(scheduleFileLinkProcessing);
    observer.observe(mdRef.value, { childList: true, subtree: true });
    tableWideResizeObserver = new ResizeObserver(updateTableWideToggles);
    tableWideResizeObserver.observe(mdRef.value);
  }
});
onBeforeUnmount(() => {
  observer?.disconnect();
  tableWideResizeObserver?.disconnect();
  // Close the shared tooltip if its anchor lived in THIS instance. Must run
  // BEFORE unmount: onUnmounted would already find mdRef nulled (the subtree
  // is gone first), while a page switch removes the root without a mouseout.
  // Anchors in other live Markdown instances survive.
  hideCodeTooltipIfAnchorWithin(mdRef.value);
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
// skeleton state until the highlighter finished — and when a screenful of code
// mounts at once (switching to a long session, or a fast burst of output) the
// highlighter can't keep up, so the skeletons get stuck and the whole page
// reads as blank placeholders. Pinning `loading` to false drops the skeleton
// entirely: the block renders its plain-text fallback immediately and upgrades
// to the highlighted version when the highlighter is ready. Streaming blocks
// are unaffected (their `stream` is true, so the skeleton gate was already
// false).
// Chat code blocks show no gutter: line numbers eat 3+ characters of reading
// width and every chat block starts at line 1 anyway. stream-diffs derives its
// gutter from `lineNumbers === false` (boolean, not monaco's 'off' string).
// This rides inside codeBlockProps because markstream only forwards the
// top-level codeBlockMonacoOptions to the 'monaco' renderer kind — the 'shiki'
// kind's props object omits it, while codeBlockProps reach the same component.
//
// fontSize / fontFamily matter as much as the gutter: since 1.0.9 the shiki
// renderer (stream-diffs) applies these options as inline styles on the code
// container (`applyEditorStyles`), so CSS overrides cannot beat them — the
// values must be passed here. fontSize mirrors --text-sm (13px). The loading
// fallback's padding is NOT set here: a numeric option would duplicate the
// spacing tokens and drift from them — the fallback's padding comes from the
// same token-driven CSS rules as the settled renderer (see the
// `.code-pre-fallback` rule below), so the fallback → settled swap stays
// stable even when the tokens change.
//
// `unsafeCSS` is pierre's sanctioned channel for host styles inside its
// shadow root (injected as the last cascade layer, so it beats pierre's base
// layer without !important; markstream forwards it from here and prepends
// its own rule). The rules themselves — code-column inset alignment and the
// line-number counter — live in codeWrap.ts
// (CODE_BLOCK_UNSAFE_CSS) next to the rest of the toggle machinery.
const codeBlockProps = {
  showHeader: true,
  showCopyButton: true,
  showExpandButton: false,
  showPreviewButton: false,
  showCollapseButton: false,
  showFontSizeButtons: false,
  // markstream's built-in tooltip bubble is English-only; we disable it and
  // stamp localized native titles on the copy button instead (codeWrap.ts),
  // which also avoids a double tooltip (bubble + native title) on hover.
  showTooltips: false,
  loading: false,
  monacoOptions: {
    lineNumbers: false,
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    unsafeCSS: CODE_BLOCK_UNSAFE_CSS,
    // Pin the default to no-wrap (horizontal scroll) instead of inheriting
    // markstream's wrap-by-default: the per-block wrap toggle (codeWrap.ts)
    // starts from the unwrapped state, so the rendered default must match.
    // The toggle itself never touches this option — it flips the block's
    // `md-code-wrap` class + the pierre shadow pre's data-overflow — so
    // turning wrap on for one block never remounts it or its siblings.
    wordWrap: 'off',
  },
};

// Root cause for the "large session turns into code skeletons" failure:
// markstream mounts every code block in the loaded transcript, then the
// highlighter has to tokenize all of them. `loading: false` removes the
// visible skeleton gate, but it still leaves a long highlighter queue on very
// large messages. Heavy messages therefore use markstream's plain <pre>
// renderer: no highlighter queue, no skeleton path, and the content remains
// immediately readable.

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
  const text = rewriteImageSrcs(markdownBody.value);
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

// Word-wrap and line-numbers state for local diff blocks — the diff-bar
// twins of the markstream header toggles (codeWrap.ts). Keyed per block
// (code text + same-content occurrence index — a best-effort identity, see
// the trade-off note on codeWrap.ts diffWrapKeys): keys follow each block
// when new message content inserts/removes/reorders segments, and identical
// blocks stay independent. Non-diff slots get a placeholder key so the
// array stays index-aligned with `segments`.
const wrappedDiffs = reactive(new Set<string>());
const numberedDiffs = reactive(new Set<string>());
const diffKeys = computed(() =>
  diffWrapKeys(segments.value.map((seg) => (seg.kind === 'diff' ? seg.code : ''))),
);
// Prune keys whose block no longer exists (deleted, or its code edited), so
// the Sets can't accumulate stale entries over a long session.
watch(diffKeys, (keys) => {
  pruneWrapKeys(wrappedDiffs, keys);
  pruneWrapKeys(numberedDiffs, keys);
});
function isDiffWrapped(i: number): boolean {
  const key = diffKeys.value[i];
  return key !== undefined && wrappedDiffs.has(key);
}
function toggleDiffWrap(i: number): void {
  const key = diffKeys.value[i];
  if (key !== undefined) toggleWrapIndex(wrappedDiffs, key);
}
function isDiffNumbered(i: number): boolean {
  const key = diffKeys.value[i];
  return key !== undefined && numberedDiffs.has(key);
}
function toggleDiffNums(i: number): void {
  const key = diffKeys.value[i];
  if (key !== undefined) toggleWrapIndex(numberedDiffs, key);
}
</script>

<template>
  <div ref="mdRef" class="md">
    <!-- YAML frontmatter → plain meta block (raw YAML verbatim, never parsed) -->
    <pre v-if="frontmatter !== null" class="md-frontmatter">{{ frontmatter }}</pre>
    <template v-for="(seg, i) in segments" :key="i">
      <!-- Non-diff markdown → markstream (smooth streaming + monaco code blocks) -->
      <MarkdownRender
        v-if="seg.kind === 'md'"
        :content="seg.text"
        :custom-markdown-it="configureMarkdownIt"
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
      <div
        v-else
        class="diff-wrap"
        :class="{ 'md-code-wrap': isDiffWrapped(i), 'md-code-nums': isDiffNumbered(i) }"
      >
        <div class="diff-bar">
          <span class="diff-lang">diff</span>
          <IconButton
            size="sm"
            :label="isDiffNumbered(i) ? t('conversation.hideLineNumbers') : t('conversation.showLineNumbers')"
            :tooltip="isDiffNumbered(i) ? t('conversation.hideLineNumbers') : t('conversation.showLineNumbers')"
            :aria-pressed="isDiffNumbered(i)"
            @click="toggleDiffNums(i)"
          >
            <Icon name="list-numbers" size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            :label="isDiffWrapped(i) ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
            :tooltip="isDiffWrapped(i) ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
            :aria-pressed="isDiffWrapped(i)"
            @click="toggleDiffWrap(i)"
          >
            <Icon :name="isDiffWrapped(i) ? 'text-wrap-disabled' : 'text-wrap'" size="sm" />
          </IconButton>
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
  font: 400 var(--content-font-size)/1.6 var(--font-ui);
  /* §03: MD body line-height is an integer px (size × 1.625), not a ratio. */
  line-height: round(calc(var(--content-font-size) * 1.625), 1px);
  color: var(--color-text);
  word-break: break-word;
}
.md :deep(.markdown-renderer) {
  font: 400 var(--content-font-size)/1.6 var(--font-ui);
  line-height: round(calc(var(--content-font-size) * 1.625), 1px);
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
  --inline-code-bg: var(--color-inline-code-bg);
  --inline-code-fg: var(--color-text);
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
.md :deep(.inline-code .md-file-link) {
  text-underline-offset: 1.5px;
}
/* Pin the prose text size explicitly. markstream sets no font-size of its own,
   so without this the rendered <p>/<li> can pick up a different base size.
   It DOES set line-height on its .paragraph-node/.list-item-node wrappers
   (a loose 1.75), so the §03 integer-px body leading is pinned here too —
   size × 1.625 rounded to 1px, same as the container rule.
   Quotes and tables are the §03 secondary level (--md-b2). */
.md :deep(.markdown-renderer p),
.md :deep(.markdown-renderer li) {
  font-size: var(--content-font-size);
  line-height: round(calc(var(--content-font-size) * 1.625), 1px);
}
.md :deep(.markdown-renderer blockquote),
.md :deep(.markdown-renderer td),
.md :deep(.markdown-renderer th) {
  font-size: var(--md-b2);
}

/* Themed surfaces swallow white-on-transparent (light) or black-on-transparent
   (dark) images; the checkerboard canvas keeps both visible. */
.md :deep(.markdown-renderer img) {
  background: var(--media-alpha-canvas);
}

/* Emphasis — keep the weight strong, but soften the ink slightly. */
.md :deep(strong) {
  color: color-mix(in srgb, var(--color-text) 86%, var(--color-text-muted));
  font-weight: var(--weight-semibold);
}

/* Headings — §03 MD group sizes with integer-px line heights (size × ratio).
   h4 has no spec level: it takes the secondary-body size, muted. */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  color: var(--color-text);
  font-optical-sizing: auto;
  font-weight: 600;
  margin: 0.85em 0 0.35em;
}
.md :deep(h1) { font-size: var(--md-h1); line-height: round(calc(var(--md-h1) * 1.63), 1px); border-bottom: 1px solid var(--color-line); padding-bottom: 4px; }
.md :deep(h2) { font-size: var(--md-h2); line-height: round(calc(var(--md-h2) * 1.60), 1px); }
.md :deep(h3) { font-size: var(--md-h3); line-height: round(calc(var(--md-h3) * 1.56), 1px); }
.md :deep(h4) { font-size: var(--md-b2); line-height: round(calc(var(--md-b2) * 1.60), 1px); color: var(--color-text-muted); }

/* Paragraphs — carry no margin of their own: inter-block spacing (including
   between consecutive paragraphs) is owned by the .node-slot gap below, so a
   paragraph pair always lands at exactly 1u regardless of font-scale step.
   (The old 0.8rem was pinned to the root 16px and never scaled.) */
.md :deep(p) {
  margin: 0;
}

/* ---------------------------------------------------------------------------
   Block spacing — Figma "After" markdown spec, expressed in u = body font
   size (--content-font-size) so every font-scale step scales
   proportionally (spec was measured at u=16): default block gap 1u (16px),
   h1/h2 blocks 2u (32px), h3/h4 blocks 1.5u (24px), first block 0.
   markstream wraps every top-level block in a plain-block .node-slot, so
   margins collapse through it: smaller inner margins (heading 0.85em, code
   block 0.6em) never exceed the slot gap, they just merge into it.
--------------------------------------------------------------------------- */
.md :deep(.node-slot + .node-slot) {
  margin-top: var(--content-font-size);
}
.md :deep(.node-slot + .node-slot:has(h1)),
.md :deep(.node-slot + .node-slot:has(h2)) {
  margin-top: calc(var(--content-font-size) * 2);
}
.md :deep(.node-slot + .node-slot:has(h3)),
.md :deep(.node-slot + .node-slot:has(h4)) {
  margin-top: calc(var(--content-font-size) * 1.5);
}

/* ---------------------------------------------------------------------------
   Lists — "After" marker-column system, in u = --content-font-size:
   · every row = 2u marker column + text, so text starts at 2u (32px @u=16)
   · nested level adds a 1.5u indent column → text at 3.5u (56px)
   · row gap 0.75u (12px), rounded to integer px
   · ul L1: 0.375u filled dot (6px@16), centred in the 2u column and on the
     first text line ((1lh − dot)/2); L2 and deeper: same-size hollow dot
   · ol: counter centred in the 2u column at body size/line-height
   Native markers are disabled (list-style:none) and drawn by li::before so
   column width and centring hold at every font-scale step. Overrides must
   beat markstream's .list-node/.list-item[data-v] scoped rules — the .md
   prefix plus element/class selectors does that without !important.
--------------------------------------------------------------------------- */
.md :deep(ul),
.md :deep(ol) {
  --md-dot: round(calc(var(--content-font-size) * 0.375), 1px);
  list-style: none;
  margin: 0;
  padding-left: calc(var(--content-font-size) * 2);
}
.md :deep(li) {
  position: relative;
  margin: 0;
  padding: 0;
}
.md :deep(li + li) {
  margin-top: round(calc(var(--content-font-size) * 0.75), 1px);
}
/* Nested list: extra 1.5u indent column, and the same 0.75u row gap between
   the parent row's text and the first child row. */
.md :deep(li > ul),
.md :deep(li > ol) {
  margin-top: round(calc(var(--content-font-size) * 0.75), 1px);
  padding-left: calc(var(--content-font-size) * 1.5);
}
.md :deep(ul > li)::before {
  content: '';
  position: absolute;
  /* centred in the 2u column: −(2u + dot)/2 from the text edge */
  left: calc((var(--md-dot) + var(--content-font-size) * 2) / -2);
  /* centred on the first text line: (1lh − dot)/2 from the row top */
  top: calc((round(calc(var(--content-font-size) * 1.625), 1px) - var(--md-dot)) / 2);
  width: var(--md-dot);
  height: var(--md-dot);
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-text) 90%, transparent);
}
/* GFM task-list items carry their own checkbox as the marker — no dot. Loose
   lists wrap the inline content in <p>, so match the paragraph-wrapped
   checkbox too. */
.md :deep(ul > li:has(> input[type='checkbox']))::before,
.md :deep(ul > li:has(> p > input[type='checkbox']))::before {
  content: none;
}
.md :deep(ul ul > li)::before {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--color-text) 90%, transparent);
  box-sizing: border-box;
}
.md :deep(ol) {
  counter-reset: md-ol;
}
/* An explicit list start or per-item value can't reach the CSS counter —
   those lists fall back to native decimal markers, which honor both. */
.md :deep(ol[start]),
.md :deep(ol:has(> li[value])) {
  counter-reset: none;
  list-style: decimal;
}
.md :deep(ol[start] > li),
.md :deep(ol:has(> li[value]) > li) {
  counter-increment: none;
}
.md :deep(ol[start] > li)::before,
.md :deep(ol:has(> li[value]) > li)::before {
  content: none;
}
.md :deep(ol > li) {
  counter-increment: md-ol;
}
.md :deep(ol > li)::before {
  content: counter(md-ol) '.';
  position: absolute;
  top: 0;
  left: calc(var(--content-font-size) * -2);
  width: calc(var(--content-font-size) * 2);
  line-height: round(calc(var(--content-font-size) * 1.625), 1px);
  text-align: center;
  color: var(--color-text);
}

/* Inline code — small mono chip */
.md :deep(:not(pre) > code),
.md :deep(.inline-code) {
  font: .9em var(--font-mono);
  background: var(--color-inline-code-bg);
  color: var(--color-text);
  border: 0;
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
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  --vscode-editor-font-size: var(--text-sm);
  --vscode-editor-line-height: calc(var(--text-sm) * var(--leading-normal));
}
.md :deep(.code-block-header) {
  background: var(--color-surface);
  border-bottom: 0.5px solid var(--color-line);
  padding: 4px 6px 4px 12px;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
  /* Tighter language icon ↔ name gap than upstream's 10px (--ms-space-2_5);
     --space-1-5 is the design system's icon↔label gap step. */
  --ms-gap-header-main: var(--space-1-5);
}
.md :deep(.code-block-header *) {
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
}
.md :deep(.code-block-header .code-header-main) {
  font-family: var(--font-ui);
}
/* Language name — the block's title, not chrome: one type step up from the
   header text (--text-xs → --text-sm) at medium weight. */
.md :deep(.code-block-header .code-header-title) {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
/* Copy button — mirrors the §03 IconButton: muted glyph, sunken hover, soft
   radius, and the shared focus ring. markstream renders its own button (the
   `.code-action-btn` class since 1.0.9 — the old `.copy-button` is gone), so
   we restyle it in place instead of swapping in the IconButton primitive. */
.md :deep(.code-block-header .code-action-btn) {
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.md :deep(.code-block-header .code-action-btn:hover) {
  /* The §03 IconButton hover wash: the translucent f1 fill stays visible on
     ANY backdrop — the sunken token it replaced reads nearly identical to
     the header's --color-surface in both themes, so hover looked dead. */
  background: var(--color-hover);
  color: var(--color-text);
}
.md :deep(.code-block-header .code-action-btn:hover *) {
  /* Ink only — the background wash stays on the button (painting a
     translucent fill on descendants would stack it, the pressed-state bug).
     Required because the blanket `.code-block-header *` rule pins the icon
     to --color-text-muted, and the glyph draws with currentColor. */
  color: var(--color-text);
}
.md :deep(.code-block-header .code-action-btn:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md :deep(.code-block-header .code-action-btn *) {
  pointer-events: none;
}
/* Pressed state of the injected toggles (codeWrap.ts): the design system's
   NEUTRAL on-state — the --color-selected fill (never accent: accent is the
   primary-action/link hue, not a state color; see the fills ladder in
   style.css). The fill goes on the BUTTON ONLY: it is translucent, so
   painting it on nested elements too stacked a second, darker layer inside
   the icon (the double-background bug). */
.md :deep(.code-block-header .md-code-wrap-toggle[aria-pressed='true']),
.md :deep(.code-block-header .md-code-nums-toggle[aria-pressed='true']) {
  background: var(--color-selected);
  color: var(--color-text);
}
/* …while DESCENDANTS get only the ink (and a hard-transparent background, so
   nothing upstream can leak a second fill in). The ` *` variant is required
   for the color: the blanket `.code-block-header *` rule above pins every
   descendant to --color-text-muted, and the registry glyph draws with
   currentColor. */
.md :deep(.code-block-header .md-code-wrap-toggle[aria-pressed='true'] *),
.md :deep(.code-block-header .md-code-nums-toggle[aria-pressed='true'] *) {
  background: transparent;
  color: var(--color-text);
}
/* Resting-at-selected hover steps one rung deeper (--color-selected-hover),
   again on the button alone. */
.md :deep(.code-block-header .md-code-wrap-toggle[aria-pressed='true']:hover),
.md :deep(.code-block-header .md-code-nums-toggle[aria-pressed='true']:hover) {
  background: var(--color-selected-hover);
}
/* Word-wrap on (the toggle sets .md-code-wrap on the block container): force
   every light-DOM code path to pre-wrap — the plain-pre renderer is
   CSS-only, while the streaming plain-text pre and the loading fallback
   carry inline white-space, hence !important. The settled shiki block lives
   in pierre's shadow root, which this rule cannot reach; codeWrap.ts flips
   its internal pre's data-overflow attribute instead. */
.md :deep(.code-block-container.md-code-wrap pre) {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
}
/* Text selection on code surfaces — the global --p-selection wash reads only
   ~1.3:1 against the code well (too subtle in review). The per-theme
   --color-code-selection tokens (style.css) keep the major shiki token
   colors at WCAG 1.4.3 (≥4.5:1 — the ink is NOT flattened) while the fill
   sits at ≈1.5:1 vs the well (a product visibility floor, not WCAG — see
   the style.css rationale for the 1.4.11 mis-anchoring retrospective and
   the documented residual colors). Scoped to code blocks + the local diff
   renderer so the rest of the page keeps --p-selection. The pierre shadow
   root is covered separately (CODE_BLOCK_UNSAFE_CSS). */
.md :deep(.code-block-container ::selection),
.md :deep(.diff-wrap ::selection) {
  background: var(--color-code-selection);
  color: var(--color-code-selection-text);
}
/* The code body wrapper was renamed in 1.0.9: `.code-block-content` is gone,
   the shiki (stream-diffs) block now mounts under `.code-block-shell-content`. */
.md :deep(.code-block-shell-content),
.md :deep(.markstream-pre) {
  background: var(--color-well);
}
/* Pierre renders the highlighted code inside a shadow root. Its native gap
   variable inherits through that boundary; the loading fallback (light DOM)
   gets the same --space-2 block padding from its own rule below, so both
   layers track the token. Line height uses the shared --leading-normal
   token (1.5, same as HighlightedCode in the file preview / diff detail) so
   every rendering path tracks it without pinning a px value anywhere. */
.md :deep(.code-editor-container) {
  line-height: var(--leading-normal);
  --diffs-gap-block: var(--space-2);
}
.md :deep(.code-editor-container diffs-container) {
  --diffs-line-height: var(--leading-normal);
}
/* Loading/streaming fallback <pre>: upstream hardcodes show-line-numbers on
   it while the settled stream-diffs block honors lineNumbers:false — the
   gutter (and its reserved padding) popping in and out on every load is a
   visible flash. Hide the fallback gutter, and give the fallback the exact
   settled padding (block --space-2, inline --space-3 aligned with the header
   icon) plus the shared --leading-normal line height over the inline
   1.5×-font-size default upstream stamps on the pre, so the fallback →
   highlighted swap is layout-stable. */
.md :deep(.code-pre-fallback > .markstream-pre__line-numbers) {
  display: none;
}
.md :deep(.code-block-container .code-pre-fallback) {
  padding: var(--space-2) var(--space-3);
  line-height: var(--leading-normal) !important;
}
.md :deep(.code-block-container pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)),
.md :deep(.markstream-pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)) {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow-x: auto;
  font: var(--text-sm)/var(--leading-normal) var(--font-mono);
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
.md :deep(.code-block-shell-content pre:not(.shiki)),
.md :deep(.code-block-shell-content pre:not(.shiki) code) {
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

/* Mention pills inside messages (see processMarkdownLinks): beat the plain
   link skin above — the pill vocabulary lives in app-ui's global sheet. The
   clickable pills (file, skill) get the global hover underline; folder pills
   are inert, so the generic anchor underline must NOT reach them. */
.md :deep(a.mention-pill) {
  color: var(--color-text-muted);
  text-decoration: none;
}
.md :deep(a.mention-folder:hover) {
  text-decoration: none;
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

.md :deep(.math-inline) {
  vertical-align: baseline;
}

/* Blockquote — "After" spec: a 2px bar with a 2px vertical inset (a border
   can't inset, so the bar is drawn by ::before), text starts after a 1.5u
   (24px) bar column with the bar centred in it, and the ink is primary, not
   muted. Size/line-height stay at the §03 secondary level (--md-b2, pinned
   above); block spacing is owned by the .node-slot gap. */
.md :deep(blockquote) {
  position: relative;
  margin: 0;
  padding: 0 0 0 round(calc(var(--content-font-size) * 1.5), 1px);
  border-left: none;
  color: var(--color-text);
}
.md :deep(blockquote)::before {
  content: '';
  position: absolute;
  left: calc(round(calc(var(--content-font-size) * 1.5), 1px) / 2 - 1px);
  top: 2px;
  bottom: 2px;
  width: 2px;
  border-radius: 2px;
  background: var(--color-line);
}
/* markstream gives quote paragraphs its own 1.5em vertical margins (scoped
   class beats a plain `p` selector) — re-pin them to the 1u spec gap. */
.md :deep(.blockquote > .paragraph-node) {
  margin: 0;
}
.md :deep(.blockquote > .paragraph-node + .paragraph-node) {
  margin-top: var(--content-font-size);
}

/* HR — vertical spacing owned by the .node-slot gap (1u above and below,
   matching the spec's 16+16); this rule only draws the line. */
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-line);
  margin: 0;
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
  /* markstream ships `scrollbar-gutter: stable` on the wrapper, which
     reserves a dead 6px strip on the right (macOS always-on scrollbars) —
     table content paints into it but our pinned fade/chip anchor outside it,
     leaving a sliver of clipped text visible past the fade. The wrapper is a
     horizontal-only scroller and never needs the gutter. */
  scrollbar-gutter: auto !important;
  /* Anchor for the widen chip + edge fade overlays (see below). */
  position: relative;
  /* Default cell cap. Chat tables in a wide container get a tighter cap
     (36cqi) from ChatPane.vue so simple tables are more likely to fit the
     reading column; everywhere else (file preview, narrow/mobile chat) the
     full --p-table-cell-max applies. */
  --table-cell-cap: var(--p-table-cell-max);
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
     its column at --table-cell-cap and wrap inside the cell instead. The cap
     defaults to --p-table-cell-max; ChatPane narrows it for default-width
     chat tables (36cqi) in wide containers.
     max-width on the cell itself only works in Firefox — Chromium ignores it
     under table-layout:auto — so the clamp is reinforced on the content box
     below. Wider tables made of many columns still scroll inside the
     wrapper. */
  max-width: var(--table-cell-cap);
}
/* Chromium honors max-width on this inner box even under table-layout:auto:
   markstream wraps plain-text cell content in a .text-node span, and as an
   inline-block its max-content contribution to the column is clamped to
   --table-cell-cap, so the column stops there and the text wraps inside
   (the span is already white-space:pre-wrap + overflow-wrap:break-word).
   Cells mixing several inline children can still exceed the cap by the sum
   of those children — acceptable; the runaway single-prose-cell case is the
   one that matters. */
.md :deep(.table-node .text-node) {
  display: inline-block;
  max-width: var(--table-cell-cap);
  vertical-align: top;
}

/* Widen-table affordance — two overlays injected by tableWide.ts into each
   chat table's wrapper, both pinned to the visible right edge via a
   scrollLeft transform (see pinTableWideToggle):

   1. `.md-table-fade` — a gradient at the table's right edge signalling
      "more content" while clipped. Shown whenever the table overflows
      (carries --show), hidden again once scrolled to the end (.md-table-at-end).
   2. `.md-table-toggle` — a Notion-style 26px icon chip in the table's
      header row (the ⤢/⤡ feather pair). Its top/right insets are measured
      in JS (alignTableWideToggle) so it sits vertically centred on the
      header row with a matching right inset; the 6px values below are only
      pre-measurement fallbacks. Carries --show when the table overflows
      or is widened, but only becomes VISIBLE on wrapper hover/focus-within,
      or persistently while the table is widened (so it can be restored).

   Both render only in a container wide enough for the ChatPane breakout
   (≥760px, matching the breakout `@container` there); with no container
   ancestor (FilePreview and other Markdown hosts) or on mobile-width
   containers they never appear. */
.md :deep(.md-table-fade) {
  display: none;
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 36px;
  z-index: 1;
  /* The tail must be FULLY opaque — a translucent tail lets the clipped
     text ghost through as faint slivers past the fade. */
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--color-bg) 65%, transparent) 55%,
    var(--color-bg)
  );
  pointer-events: none;
  transition: opacity var(--duration-base) var(--ease-out);
}
.md :deep(.md-table-at-end) .md-table-fade {
  opacity: 0;
}
.md :deep(.md-table-toggle) {
  display: none;
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--color-text-muted);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
@container (min-width: 760px) {
  .md :deep(.md-table-fade.md-table-toggle--show),
  .md :deep(.md-table-toggle.md-table-toggle--show) {
    display: block;
  }
  .md :deep(.md-table-toggle.md-table-toggle--show) {
    display: inline-flex;
  }
}
.md :deep(.table-node-wrapper:hover) .md-table-toggle.md-table-toggle--show,
.md :deep(.table-node-wrapper:focus-within) .md-table-toggle.md-table-toggle--show,
.md :deep(.table-node-wrapper.md-table-wide) .md-table-toggle.md-table-toggle--show {
  opacity: 1;
}
.md :deep(.md-table-toggle:hover) {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.md :deep(.md-table-toggle:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md :deep(.md-table-toggle) svg {
  display: block;
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
   Frontmatter meta block — the raw YAML in a quiet well above the body. Same
   chrome as the code blocks (content well, line border, radius md, mono
   text) but muted ink and no header bar; the YAML is shown verbatim, so it
   wraps nowhere and scrolls horizontally like a code block.
--------------------------------------------------------------------------- */
.md-frontmatter {
  margin: 0 0 var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  box-shadow: var(--shadow-xs);
  overflow-x: auto;
  color: var(--color-text-muted);
  font: var(--text-sm)/1.65 var(--font-mono);
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
  /* The sign-column width comes from the shared --diff-sign-col design
     token (style.css): the sign cell, the wrap hanging indent, and the
     line-number counter gutter all derive from it, so a rescale can never
     strand a hardcoded value. */
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
/* Pressed toggles (IconButtons; aria-pressed falls through to the root
   button) — same NEUTRAL on-state as the markstream-header toggles above:
   the --color-selected fill, full-colour ink, one-rung-deeper hover. */
.diff-bar :deep(.ui-icon-button[aria-pressed='true']) {
  background: var(--color-selected);
  color: var(--color-text);
}
.diff-bar :deep(.ui-icon-button[aria-pressed='true']:hover) {
  background: var(--color-selected-hover);
}
/* Diff wrap on (.md-code-wrap on .diff-wrap): the pre wraps; the code
   column's max-content width — what keeps long lines on one line in scroll
   mode — relaxes to the container so lines actually fold. */
.diff-wrap.md-code-wrap .diff-pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-wrap.md-code-wrap .diff-pre code {
  width: auto;
}
/* Wrapped diff WITHOUT line numbers: hang the sign column inside the
   row's left padding, so a folded continuation starts at the code column
   (aligned with the first line's text) instead of dropping under the +/-
   sign and reading like a new diff row. With numbers on, the counter rules
   below already reserve sign+gutter and need no help. */
.diff-wrap.md-code-wrap:not(.md-code-nums) .diff-line {
  padding-left: calc(var(--space-3) + var(--diff-sign-col));
}
.diff-wrap.md-code-wrap:not(.md-code-nums) .diff-sign {
  margin-left: calc(-1 * var(--diff-sign-col));
}
/* Line numbers for diff rows, gated on the per-block numbers toggle
   (.md-code-nums) — same contract as the markstream code blocks
   (codeWrap.ts CODE_BLOCK_UNSAFE_CSS): the toggle is independent of wrap and
   shows numbers in BOTH modes; a wrapped continuation gets none and aligns
   with the code column. Real diff rows are numbered with a pure-CSS counter
   (hunk headers are not file lines and are skipped). The 4ch number gutter
   (3ch digits + 1ch gap) plus the sign column (--diff-sign-col) are carved out of the
   row's left padding, so the gutter's left edge stays at --space-3 and
   continuations land exactly under the text. Generated content never enters
   copy. */
.diff-wrap.md-code-nums .diff-pre {
  counter-reset: md-diff-line;
}
.diff-wrap.md-code-nums .diff-line:not(.diff-hunk) {
  counter-increment: md-diff-line;
  padding-left: calc(var(--space-3) + 4ch + var(--diff-sign-col));
}
.diff-wrap.md-code-nums .diff-line:not(.diff-hunk)::before {
  content: counter(md-diff-line);
  display: inline-block;
  /* Fixed 3ch box, digits right-aligned: 4+-digit numbers overflow left
     (into the --space-3 inset) rather than widening the gutter mid-block. */
  width: 3ch;
  overflow: visible;
  margin-left: calc(-1 * (4ch + var(--diff-sign-col)));
  margin-right: 1ch;
  text-align: right;
  color: var(--color-text-faint);
  user-select: none;
}
.diff-pre {
  margin: 0;
  padding: var(--space-2) 0;
  overflow-x: auto;
  background: var(--color-surface-sunken);
}
/* Same code geometry as the markstream code blocks above: --leading-normal
   line height, and rows inset --space-3 so the diff column aligns with the
   code column (and the header icon). */
.diff-pre code {
  display: block;
  width: max-content;
  min-width: 100%;
  font: var(--text-sm)/var(--leading-normal) var(--font-mono);
  color: var(--color-text);
}
.diff-line {
  display: block;
  width: 100%;
  padding: 0 var(--space-3);
}
.diff-sign {
  display: inline-block;
  width: var(--diff-sign-col);
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
