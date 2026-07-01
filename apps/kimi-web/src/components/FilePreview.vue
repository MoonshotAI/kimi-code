<!-- apps/kimi-web/src/components/FilePreview.vue -->
<!-- File preview pane: renders text/markdown/json/image/binary by mime and encoding. -->
<script setup lang="ts">
import { computed, inject, nextTick, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Markdown from './chat/Markdown.vue';
import type { FileData, FilePreviewRequest } from '../types';
import { copyTextToClipboard } from '../lib/clipboard';
import SegmentedControl from './ui/SegmentedControl.vue';
import Button from './ui/Button.vue';
import IconButton from './ui/IconButton.vue';
import Icon from './ui/Icon.vue';
import PanelHeader from './ui/PanelHeader.vue';
import Tooltip from './ui/Tooltip.vue';

const { t } = useI18n();

// Resolve a relative path (from inside a Markdown file) against that file's
// directory. Handles "./foo", "../foo", and bare "foo" segments.
function resolveRelativePath(src: string, base: string): string {
  const result = base ? base.split('/').filter(Boolean) : [];
  for (const part of src.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      result.pop();
    } else {
      result.push(part);
    }
  }
  return result.join('/');
}

// Wrap the app-level image resolver so that relative image paths inside a
// Markdown file are resolved against that file's directory.
const parentResolveImage = inject<(src: string) => Promise<string>>('resolveImage', async (src: string) => src);
const markdownBaseDir = computed(() => {
  const path = props.file?.path ?? '';
  const lastSlash = path.lastIndexOf('/');
  return lastSlash > 0 ? path.slice(0, lastSlash) : '';
});
function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (src.startsWith('/')) return src;
  const base = markdownBaseDir.value;
  if (!base) return src;
  return resolveRelativePath(src, base);
}
async function resolveMarkdownImage(src: string): Promise<string> {
  const resolved = resolveImageSrc(src);
  if (parentResolveImage) return parentResolveImage(resolved);
  return resolved;
}
provide('resolveImage', resolveMarkdownImage);

// Resolve a Markdown `[link](./foo.md)` target against the current file's
// directory before forwarding it to the app's file opener. Absolute paths and
// URLs/anchors are passed through unchanged (Markdown.vue skips those itself).
// `?query` and `#fragment` are stripped so they don't become part of the path.
function resolveMarkdownFileTarget(target: { path: string; line?: number }): FilePreviewRequest {
  let href = target.path;
  if (/^(https?:|mailto:|tel:|data:|blob:|#)/i.test(href) || href.startsWith('/')) {
    return target;
  }
  for (const sep of ['#', '?']) {
    const idx = href.indexOf(sep);
    if (idx !== -1) href = href.slice(0, idx);
  }
  const base = markdownBaseDir.value;
  return { ...target, path: resolveRelativePath(href, base) };
}

const props = defineProps<{
  file: FileData | null;
  loading: boolean;
  error?: string | null;
  line?: number;
  downloadUrl?: string | null;
  closable?: boolean;
  externalActions?: boolean;
  /** Open a linked file from inside a Markdown preview (resolved against the
      current file's directory before being called). */
  openFile?: (target: FilePreviewRequest) => void;
}>();

const emit = defineEmits<{
  close: [];
  openExternal: [];
  reveal: [];
}>();

function handleMarkdownOpenFile(target: { path: string; line?: number }): void {
  props.openFile?.(resolveMarkdownFileTarget(target));
}

const rootRef = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

type ContentKind = 'markdown' | 'json' | 'html' | 'pdf' | 'csv' | 'image' | 'text' | 'binary';

const contentKind = computed<ContentKind>(() => {
  const f = props.file;
  if (!f) return 'binary';
  const mime = f.mime ?? '';
  const lang = f.languageId ?? '';
  const lowerPath = f.path.toLowerCase();

  if (mime === 'text/markdown' || lang === 'markdown' || lang === 'md' || lowerPath.endsWith('.mdx')) return 'markdown';
  if (mime === 'application/json' || lang === 'json') return 'json';
  if (mime === 'text/html' || lang === 'html' || lowerPath.endsWith('.html') || lowerPath.endsWith('.htm')) return 'html';
  if (mime === 'application/pdf' || lowerPath.endsWith('.pdf')) return 'pdf';
  if (mime === 'text/csv' || lang === 'csv' || lowerPath.endsWith('.csv')) return 'csv';
  if (mime.startsWith('image/')) return 'image';
  if (f.isBinary) return 'binary';
  // text/* and code files
  if (mime.startsWith('text/') || lang !== '') return 'text';
  return 'binary';
});

// ---------------------------------------------------------------------------
// Content decoding
//
// The daemon returns `encoding: 'base64'` for some files (e.g. when content has
// bytes the JSON transport can't carry verbatim). Image/PDF previews build a
// `data:` URL from that base64 directly, but every *text* view (markdown, code,
// json, html, csv, copy) needs the decoded text — otherwise it renders the raw
// base64 string. atob() yields Latin-1 bytes, so decode them as UTF-8 to keep
// non-ASCII content (e.g. Chinese) intact.
// ---------------------------------------------------------------------------

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const decodedContent = computed<string>(() => {
  const f = props.file;
  if (!f) return '';
  if (f.encoding === 'base64') {
    try {
      return decodeBase64Utf8(f.content);
    } catch {
      return f.content;
    }
  }
  return f.content;
});

// ---------------------------------------------------------------------------
// JSON pretty-print
// ---------------------------------------------------------------------------

const prettyJson = computed<string>(() => {
  if (contentKind.value !== 'json' || !props.file) return '';
  try {
    return JSON.stringify(JSON.parse(decodedContent.value), null, 2);
  } catch {
    return decodedContent.value;
  }
});

// ---------------------------------------------------------------------------
// Line numbers for code/text
// ---------------------------------------------------------------------------

const lines = computed<string[]>(() => {
  if (!props.file) return [];
  const src = contentKind.value === 'json' ? prettyJson.value : decodedContent.value;
  return src.split('\n');
});

const sourceText = computed<string>(() => {
  if (!props.file) return '';
  return contentKind.value === 'json' ? prettyJson.value : decodedContent.value;
});

// ---------------------------------------------------------------------------
// Search + jump-to-line
// ---------------------------------------------------------------------------

const searchQuery = ref('');
const activeMatch = ref(0);

const searchMatches = computed<number[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  lines.value.forEach((line, idx) => {
    if (line.toLowerCase().includes(q)) out.push(idx + 1);
  });
  return out;
});

watch(searchQuery, () => {
  activeMatch.value = 0;
});

function scrollToLine(line: number | undefined, reset = false): void {
  if (!line) return;
  void nextTick(() => {
    const bodyEl = rootRef.value?.querySelector<HTMLElement>('.fp-body');
    const el = bodyEl?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!bodyEl || !el) return;
    // When a new file (or line) is requested, start from the top so the target
    // line is positioned predictably. Without this, switching files while the
    // previous file was scrolled mid-content can make the scroller appear to
    // "jump up" as scrollIntoView tries to center the new target against the
    // stale scroll position.
    if (reset) bodyEl.scrollTop = 0;
    const bodyRect = bodyEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const relativeTop = elRect.top - bodyRect.top + bodyEl.scrollTop;
    bodyEl.scrollTop = relativeTop - bodyEl.clientHeight / 2 + elRect.height / 2;
  });
}

watch(
  () => [props.file?.path, props.line] as const,
  () => scrollToLine(props.line, true),
  { immediate: true },
);

function nextMatch(delta: number): void {
  const matches = searchMatches.value;
  if (matches.length === 0) return;
  activeMatch.value = (activeMatch.value + delta + matches.length) % matches.length;
  scrollToLine(matches[activeMatch.value]);
}

function lineClass(lineNo: number): Record<string, boolean> {
  const matches = searchMatches.value;
  return {
    target: props.line === lineNo,
    hit: matches.includes(lineNo),
    active: matches[activeMatch.value] === lineNo,
  };
}

// ---------------------------------------------------------------------------
// Size formatter
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const copied = ref(false);
const copiedPath = ref(false);

function copyContent(): void {
  if (!props.file) return;
  void copyTextToClipboard(sourceText.value).then((ok) => {
    if (!ok) return;
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1400);
  });
}

function copyPath(): void {
  if (!props.file) return;
  void copyTextToClipboard(props.file.path).then((ok) => {
    if (!ok) return;
    copiedPath.value = true;
    setTimeout(() => { copiedPath.value = false; }, 1400);
  });
}

// ---------------------------------------------------------------------------
// Rich previews
// ---------------------------------------------------------------------------

const htmlMode = ref<'preview' | 'source'>('preview');
const markdownMode = ref<'preview' | 'source'>('preview');
const imageFit = ref<'fit' | 'actual'>('fit');

function setHtmlMode(v: string): void {
  htmlMode.value = v as 'preview' | 'source';
}
function setMarkdownMode(v: string): void {
  markdownMode.value = v as 'preview' | 'source';
}
function setImageFit(v: string): void {
  imageFit.value = v as 'fit' | 'actual';
}

watch(contentKind, (kind) => {
  htmlMode.value = kind === 'html' ? 'preview' : 'source';
  markdownMode.value = 'preview';
  imageFit.value = 'fit';
});

const imageSrc = computed<string | null>(() => {
  const f = props.file;
  if (!f || contentKind.value !== 'image') return null;
  if (f.sourceUrl) return f.sourceUrl;
  if (f.encoding === 'base64') return `data:${f.mime};base64,${f.content}`;
  if (f.mime === 'image/svg+xml') {
    return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.content)}`;
  }
  return null;
});

const pdfSrc = computed<string | null>(() => {
  const f = props.file;
  if (!f || contentKind.value !== 'pdf') return null;
  if (props.downloadUrl) return props.downloadUrl;
  if (f.encoding === 'base64') return `data:${f.mime};base64,${f.content}`;
  return null;
});

const htmlSrcdoc = computed<string>(() => {
  if (!props.file) return '';
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:;">',
    decodedContent.value,
  ].join('');
});

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

const csvRows = computed<string[][]>(() => lines.value.slice(0, 200).map(parseCsvLine));

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function languageKey(): string {
  const f = props.file;
  if (!f) return '';
  const lang = f.languageId?.toLowerCase();
  if (lang) return lang;
  return f.path.split('.').pop()?.toLowerCase() ?? '';
}

function highlightLine(line: string): string {
  const lang = languageKey();
  let html = escapeHtml(line);

  if (contentKind.value === 'json' || lang === 'json' || lang === 'jsonc') {
    html = html.replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2');
    html = html.replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-string">$2</span>');
    html = html.replace(/\b(true|false|null)\b/g, '<span class="tok-literal">$1</span>');
    html = html.replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="tok-number">$2</span>');
    return html;
  }

  if (contentKind.value === 'html' || lang === 'html' || lang === 'xml' || lang === 'svg') {
    html = html.replace(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)(=)/g, ' <span class="tok-attr">$1</span>$2');
    html = html.replace(/(&quot;.*?&quot;)/g, '<span class="tok-string">$1</span>');
    html = html.replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g, '$1<span class="tok-tag">$2</span>');
    return html;
  }

  html = html.replace(
    /\b(async|await|break|case|catch|class|const|continue|else|export|extends|finally|for|from|function|if|import|interface|let|new|return|switch|throw|try|type|while)\b/g,
    '<span class="tok-keyword">$1</span>',
  );
  html = html.replace(/(&quot;.*?&quot;|'.*?')/g, '<span class="tok-string">$1</span>');
  html = html.replace(/(\/\/.*)$/g, '<span class="tok-comment">$1</span>');
  return html;
}

// ---------------------------------------------------------------------------
// Path display (truncate-left for long paths)
// ---------------------------------------------------------------------------

function truncatePath(path: string, maxLen = 55): string {
  if (!path || path.length <= maxLen) return path;
  return '…' + path.slice(path.length - maxLen + 1);
}
</script>

<template>
  <div ref="rootRef" class="file-preview">
    <!-- Empty state: nothing selected -->
    <div v-if="error && !loading" class="fp-empty fp-error">
      <span>{{ error }}</span>
      <Button v-if="closable" variant="secondary" size="sm" @click="emit('close')">
        {{ t('filePreview.close') }}
      </Button>
    </div>

    <div v-else-if="!file && !loading" class="fp-empty">
      {{ t('filePreview.empty') }}
    </div>

    <!-- Loading state -->
    <div v-else-if="loading" class="fp-loading">
      <span class="spinner"></span>
      <span>{{ t('filePreview.loading') }}</span>
    </div>

    <!-- File loaded -->
    <template v-else-if="file">
      <!-- Header: shared "Preview" title; the path is the subtitle -->
      <PanelHeader
        wrap
        :title="t('common.preview')"
        :closable="closable"
        :close-label="t('filePreview.close')"
        @close="emit('close')"
      >
        <Tooltip :text="file.path">
          <span class="fp-path">{{ truncatePath(file.path) }}</span>
        </Tooltip>
        <span class="fp-meta">
          <span v-if="file.lineCount" class="fp-lines">{{ t('filePreview.lineCount', { count: file.lineCount }) }}</span>
          <span class="fp-size">{{ formatSize(file.size) }}</span>
        </span>
        <SegmentedControl
          v-if="contentKind === 'html'"
          :model-value="htmlMode"
          size="sm"
          :options="[
            { value: 'preview', label: t('filePreview.preview') },
            { value: 'source', label: t('filePreview.source') },
          ]"
          @update:model-value="setHtmlMode"
        />
        <SegmentedControl
          v-if="contentKind === 'markdown'"
          :model-value="markdownMode"
          size="sm"
          :options="[
            { value: 'preview', label: t('filePreview.preview') },
            { value: 'source', label: t('filePreview.source') },
          ]"
          @update:model-value="setMarkdownMode"
        />
        <SegmentedControl
          v-if="contentKind === 'image'"
          :model-value="imageFit"
          size="sm"
          :options="[
            { value: 'fit', label: t('filePreview.fit') },
            { value: 'actual', label: t('filePreview.actual') },
          ]"
          @update:model-value="setImageFit"
        />
        <div v-if="contentKind === 'text' || contentKind === 'json' || contentKind === 'html' || contentKind === 'csv'" class="fp-search">
          <input
            v-model="searchQuery"
            class="fp-search-input"
            type="search"
            :placeholder="t('filePreview.search')"
          />
          <span v-if="searchQuery.trim()" class="fp-search-count">
            {{ searchMatches.length }}
          </span>
          <Tooltip :text="t('filePreview.prevMatch')">
            <IconButton size="sm" :disabled="searchMatches.length === 0" :label="t('filePreview.prevMatch')" @click="nextMatch(-1)">
              <Icon name="arrow-up" size="md" />
            </IconButton>
          </Tooltip>
          <Tooltip :text="t('filePreview.nextMatch')">
            <IconButton size="sm" :disabled="searchMatches.length === 0" :label="t('filePreview.nextMatch')" @click="nextMatch(1)">
              <Icon name="arrow-down" size="md" />
            </IconButton>
          </Tooltip>
        </div>
        <!-- Icon actions: text labels made the header wrap to two rows at the
             default panel width — icons + title tooltips keep it single-line. -->
        <Tooltip :text="copiedPath ? t('filePreview.copied') : t('filePreview.copyPath')">
          <IconButton size="sm" :class="{ copied: copiedPath }" :label="copiedPath ? t('filePreview.copied') : t('filePreview.copyPath')" @click="copyPath">
            <Icon v-if="!copiedPath" name="link" size="md" />
            <Icon v-else class="fp-check" name="check" size="md" />
          </IconButton>
        </Tooltip>
        <Tooltip :text="t('filePreview.openInEditor')">
          <IconButton v-if="externalActions" size="sm" :label="t('filePreview.openInEditor')" @click="emit('openExternal')">
            <Icon name="external-link" size="md" />
          </IconButton>
        </Tooltip>
        <Tooltip :text="t('filePreview.reveal')">
          <IconButton v-if="externalActions" size="sm" :label="t('filePreview.reveal')" @click="emit('reveal')">
            <Icon name="folder" size="md" />
          </IconButton>
        </Tooltip>
        <Tooltip :text="t('filePreview.download')">
          <a
            v-if="downloadUrl"
            class="fp-download"
            :href="downloadUrl"
            target="_blank"
            rel="noreferrer"
            download
            :aria-label="t('filePreview.download')"
          >
            <Icon name="download" size="md" />
          </a>
        </Tooltip>
        <Tooltip :text="copied ? t('filePreview.copied') : t('filePreview.copy')">
          <IconButton
            v-if="!file.isBinary && contentKind !== 'image'"
            size="sm"
            :class="{ copied }"
            :label="copied ? t('filePreview.copied') : t('filePreview.copy')"
            @click="copyContent"
          >
            <Icon v-if="!copied" name="copy" size="md" />
            <Icon v-else class="fp-check" name="check" size="md" />
          </IconButton>
        </Tooltip>
      </PanelHeader>

      <!-- Body: Markdown -->
      <div v-if="contentKind === 'markdown'" class="fp-body" :class="{ 'fp-markdown': markdownMode === 'preview' }">
        <Markdown
          v-if="markdownMode === 'preview'"
          :text="decodedContent"
          :open-file="props.openFile ? handleMarkdownOpenFile : undefined"
        />
        <div v-else class="fp-code">
          <div class="fp-line-table">
            <div
              v-for="(line, idx) in lines"
              :key="idx"
              class="fp-line-row"
              :class="lineClass(idx + 1)"
              :data-line="idx + 1"
            >
              <span class="fp-gutter">{{ idx + 1 }}</span>
              <span class="fp-line-text" v-html="highlightLine(line)"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Body: JSON -->
      <div v-else-if="contentKind === 'json'" class="fp-body fp-code">
        <div class="fp-line-table">
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            class="fp-line-row"
            :class="lineClass(idx + 1)"
            :data-line="idx + 1"
          >
            <span class="fp-gutter">{{ idx + 1 }}</span>
            <span class="fp-line-text" v-html="highlightLine(line)"></span>
          </div>
        </div>
      </div>

      <!-- Body: HTML (sandboxed preview + source mode) -->
      <div v-else-if="contentKind === 'html'" class="fp-body">
        <iframe
          v-if="htmlMode === 'preview'"
          class="fp-html-frame"
          sandbox=""
          :srcdoc="htmlSrcdoc"
          :title="file.path"
        ></iframe>
        <div v-else class="fp-code">
          <div class="fp-line-table">
            <div
              v-for="(line, idx) in lines"
              :key="idx"
              class="fp-line-row"
              :class="lineClass(idx + 1)"
              :data-line="idx + 1"
            >
              <span class="fp-gutter">{{ idx + 1 }}</span>
              <span class="fp-line-text" v-html="highlightLine(line)"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Body: PDF -->
      <div v-else-if="contentKind === 'pdf'" class="fp-body fp-pdf-wrap">
        <iframe v-if="pdfSrc" class="fp-pdf-frame" :src="pdfSrc" :title="file.path"></iframe>
        <div v-else class="fp-binary-card">
          <span class="fp-binary-label">{{ t('filePreview.pdfNoPreview') }}</span>
        </div>
      </div>

      <!-- Body: CSV -->
      <div v-else-if="contentKind === 'csv'" class="fp-body fp-table-wrap">
        <table class="fp-table">
          <tbody>
            <tr v-for="(row, ri) in csvRows" :key="ri" :class="lineClass(ri + 1)" :data-line="ri + 1">
              <th>{{ ri + 1 }}</th>
              <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Body: Image (base64) -->
      <div v-else-if="contentKind === 'image'" class="fp-body fp-image-wrap">
        <template v-if="imageSrc">
          <img
            :src="imageSrc"
            :alt="file.path"
            class="fp-image"
            :class="{ actual: imageFit === 'actual' }"
          />
        </template>
        <div v-else class="fp-binary-card">
          <span class="fp-binary-icon">
            <Icon name="image-off" size="lg" />
          </span>
          <span class="fp-binary-label">{{ t('filePreview.imageNoPreview', { mime: file.mime, size: formatSize(file.size) }) }}</span>
        </div>
      </div>

      <!-- Body: Text/Code (with line numbers) -->
      <div v-else-if="contentKind === 'text'" class="fp-body fp-code">
        <div class="fp-line-table">
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            class="fp-line-row"
            :class="lineClass(idx + 1)"
            :data-line="idx + 1"
          >
            <span class="fp-gutter">{{ idx + 1 }}</span>
            <span class="fp-line-text" v-html="highlightLine(line)"></span>
          </div>
        </div>
      </div>

      <!-- Body: Binary / unknown -->
      <div v-else class="fp-body fp-binary-wrap">
        <div class="fp-binary-card">
          <span class="fp-binary-icon">
            <Icon name="file-off" size="lg" />
          </span>
          <span class="fp-binary-label">
            {{ t('filePreview.binaryNoPreview', { mime: file.mime || t('filePreview.unknownType'), size: formatSize(file.size) }) }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  font-family: var(--mono);
  min-width: 0;
  /* Header children use container queries to shed supplementary info (meta)
     before wrapping — keyed to the PANEL width, not the viewport. */
  container-type: inline-size;
}

/* ---- Empty / loading ---- */
.fp-empty,
.fp-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
  font-size: var(--ui-font-size);
}

/* ---- Header ----
   Structure comes from PanelHeader (wrap mode). Only the slot content
   (path subtitle, supplementary meta, inline search) is styled here. */

/* The path is the SUBTITLE — supplementary next to the shared panel title.
   nowrap is load-bearing: without it a long path wraps INSIDE the span and
   stretches the header to multiple lines (ellipsis only works on one line). */
.fp-path {
  /* Low BASIS on purpose: flex-wrap packs lines by basis, so a big basis here
     pushed the actions onto a second row at the default panel width. The path
     then GROWS into whatever space the row has left. */
  flex: 1 1 60px;
  min-width: 40px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
  font-weight: 400;
}

.fp-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

/* Narrow panel: drop the supplementary line/size meta first — wrapping the
   action row is the last resort, not the default-width behaviour. NOTE: must
   come AFTER the .fp-meta base rule (same specificity; order decides). */
@container (max-width: 539px) {
  .fp-meta {
    display: none;
  }
}

.fp-lines,
.fp-size {
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--muted);
  white-space: nowrap;
}

.fp-search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 110px;
  min-width: 70px;
  max-width: 200px;
}

.fp-search-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: var(--text-xs) var(--font-mono);
}
.fp-search-count {
  color: var(--muted);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  min-width: 18px;
  text-align: right;
}

/* Download is a real link (<a href download>), so it can't be an IconButton;
   mirror the IconButton sm look so the action row stays visually uniform. */
.fp-download {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
}
.fp-download:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.fp-download:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.fp-download svg {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
}

/* "Copied" confirmation: tint the check glyph green. */
.fp-check {
  color: var(--color-success);
}

/* ---- Body ---- */
.fp-body {
  --fp-search-hit-bg: color-mix(in srgb, var(--star) 22%, var(--bg));
  --fp-search-active-bg: color-mix(in srgb, var(--star) 36%, var(--bg));
  --fp-token-keyword: color-mix(in srgb, var(--color-accent) 68%, var(--color-danger));
  --fp-token-string: var(--color-success);
  --fp-token-literal: var(--color-accent-hover);
  --fp-token-tag: var(--color-warning);

  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* ---- Markdown ---- */
.fp-markdown {
  padding: 16px 20px;
}

/* ---- Code / text with line numbers ---- */
.fp-code {
  background: var(--bg);
}

.fp-line-table {
  display: table;
  width: 100%;
  border-collapse: collapse;
  font-size: var(--ui-font-size);
  line-height: 1.6;
}

.fp-line-row {
  display: table-row;
}
.fp-line-row.hit .fp-line-text,
.fp-table tr.hit td {
  background: var(--fp-search-hit-bg);
}
.fp-line-row.active .fp-line-text,
.fp-table tr.active td {
  background: var(--fp-search-active-bg);
}
.fp-line-row.target .fp-gutter,
.fp-line-row.target .fp-line-text,
.fp-table tr.target th,
.fp-table tr.target td {
  background: var(--color-accent-soft);
}

.fp-gutter {
  display: table-cell;
  width: 44px;
  padding: 0 10px 0 12px;
  text-align: right;
  color: var(--faint);
  user-select: none;
  font-size: var(--text-base);
  white-space: nowrap;
  border-right: 1px solid var(--line2);
  vertical-align: top;
}

.fp-line-text {
  display: table-cell;
  padding: 0 12px;
  color: var(--color-text);
  white-space: pre;
  vertical-align: top;
}
.fp-line-text :deep(.tok-key),
.fp-line-text :deep(.tok-keyword) {
  color: var(--fp-token-keyword);
  font-weight: 500;
}
.fp-line-text :deep(.tok-string) { color: var(--fp-token-string); }
.fp-line-text :deep(.tok-number),
.fp-line-text :deep(.tok-literal) { color: var(--fp-token-literal); }
.fp-line-text :deep(.tok-comment) { color: var(--muted); font-style: italic; }
.fp-line-text :deep(.tok-tag) { color: var(--fp-token-tag); font-weight: 500; }
.fp-line-text :deep(.tok-attr) { color: var(--fp-token-literal); }

/* ---- HTML / PDF ---- */
.fp-html-frame,
.fp-pdf-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--color-surface-raised);
}
.fp-pdf-wrap {
  background: var(--panel2);
}

/* ---- CSV ---- */
.fp-table-wrap {
  background: var(--bg);
}
.fp-table {
  border-collapse: collapse;
  min-width: 100%;
  font: 12px/1.5 var(--mono);
}
.fp-table th {
  position: sticky;
  left: 0;
  z-index: 1;
  width: 44px;
  min-width: 44px;
  padding: 2px 8px;
  text-align: right;
  color: var(--faint);
  background: var(--panel);
  border-right: 1px solid var(--line2);
  user-select: none;
}
.fp-table td {
  padding: 2px 10px;
  border-right: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
  white-space: pre;
}

/* ---- Image ---- */
.fp-image-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--panel2);
}

.fp-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 4px;
}
.fp-image.actual {
  max-width: none;
  max-height: none;
}

/* ---- Binary card ---- */
.fp-binary-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

.fp-binary-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--muted);
  font-size: var(--ui-font-size);
  margin: 32px auto;
  max-width: 480px;
}

.fp-binary-icon {
  color: var(--faint);
  flex: none;
}
.fp-error {
  flex-direction: column;
  padding: 24px;
  text-align: center;
}

/* ---- Spinner ---- */
@keyframes spin { to { transform: rotate(360deg); } }

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--line);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ---- Mobile (≤640px): a comfier header (copy is a real tap target), and the
        code body keeps its line-number gutter while scrolling sideways for long
        lines. Markdown/images fit the full width. ---- */
@media (max-width: 640px) {
  /* Hide the line-count chip on the narrowest screens to keep the header tidy;
     the size chip + copy stay. */
  .fp-lines { display: none; }
  .fp-markdown { padding: 14px 16px; }
  .fp-body.fp-code { -webkit-overflow-scrolling: touch; }
}

.fp-empty,
.fp-loading { font-family: var(--sans); }
.fp-binary-card { border: 1px solid var(--color-line); border-radius: var(--radius-md); }
.fp-binary-label { font-family: var(--sans); }
.fp-image { border-radius: var(--radius-md); }
.seg-btn { font-family: var(--sans); }
</style>
