<!-- apps/kimi-web/src/components/Markdown.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { MarkdownRender } from 'markstream-vue';
// px-based CSS build (our app is px, not rem). Imported here so the styles
// load wherever Markdown is used; scoped overrides below re-skin it to
// Terminal Pro. Importing the same file from multiple components is a no-op
// after the first (Vite dedups the CSS import).
import 'markstream-vue/index.px.css';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    text: string;
    /**
     * True only for the assistant turn that is actively streaming. It drives
     * `final` (= !streaming). Combined with `smooth-streaming="auto"`, markstream
     * animates the typewriter/fade reveal ONLY while a turn is live (final=false);
     * a DONE turn (final=true) — including every message in a reopened historical
     * session — renders statically with no re-stream animation.
     */
    streaming?: boolean;
  }>(),
  { streaming: false },
);

const final = computed(() => !props.streaming);

// Light Shiki theme for code blocks. `github-light` matches Terminal Pro's
// light surface (markstream's default is vitesse-dark/light; we force a light
// theme and isDark=false so code never renders on a dark surface).
const CODE_LIGHT_THEME = 'github-light';

// Props forwarded to each code block. markstream's CodeBlock ships its own
// header with a copy button + language label, so we keep the header + copy
// button (preserving our previous per-block copy affordance) and turn off the
// monaco-only buttons (expand / preview / font-size) that don't fit a chat.
const codeBlockProps = {
  showHeader: true,
  showCopyButton: true,
  showExpandButton: false,
  showPreviewButton: false,
  showCollapseButton: false,
  showFontSizeButtons: false,
};

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
  const text = props.text ?? '';
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
    if (/^@@/.test(line)) return { cls: 'diff-hunk', text: line };
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
  <div class="md">
    <template v-for="(seg, i) in segments" :key="i">
      <!-- Non-diff markdown → markstream (smooth streaming + shiki) -->
      <MarkdownRender
        v-if="seg.kind === 'md'"
        :content="seg.text"
        mode="chat"
        code-renderer="shiki"
        :is-dark="false"
        :code-block-light-theme="CODE_LIGHT_THEME"
        :themes="[CODE_LIGHT_THEME]"
        :code-block-props="codeBlockProps"
        :final="final"
        smooth-streaming="auto"
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

/* Base prose — matched to the sidebar session-title size (12px). */
.md {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
}
.md :deep(.markdown-renderer) {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
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
.md :deep(h1) { font-size: 15px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.md :deep(h2) { font-size: 14px; }
.md :deep(h3) { font-size: 13px; }
.md :deep(h4) { font-size: 12.5px; color: var(--dim); }

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
  font-size: 12px;
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
}
.md :deep(.code-block-header) {
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
  padding: 3px 8px;
  min-height: 0;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.md :deep(.code-block-header *) {
  color: var(--muted);
  font-size: 10px;
}
/* Copy button in the header */
.md :deep(.copy-button) {
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
}
.md :deep(.copy-button:hover) {
  color: var(--blue);
}
.md :deep(.code-block-content),
.md :deep(.markstream-pre) {
  background: var(--panel);
}
.md :deep(.code-block-container pre),
.md :deep(.markstream-pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
}
.md :deep(.code-block-container pre code) {
  font-family: var(--mono);
  font-size: 12px;
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
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

/* Tables */
.md :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  margin: 0.5em 0;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--line);
  padding: 4px 10px;
  text-align: left;
}
.md :deep(th) {
  background: var(--panel2);
  color: var(--ink);
  font-weight: 600;
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
  font-size: 10px;
  color: var(--muted);
  margin-right: auto;
  letter-spacing: 0.04em;
}
.diff-copy {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
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
  font-size: 12px;
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
  background: rgba(14, 122, 56, 0.07);
  border-left-color: var(--ok) !important;
}
.diff-del {
  color: var(--err);
  background: rgba(185, 28, 28, 0.06);
  border-left-color: var(--err) !important;
}
.diff-hunk {
  color: var(--blue);
}
.diff-ctx {
  color: var(--dim);
}
</style>
