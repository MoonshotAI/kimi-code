<!-- apps/kimi-web/src/components/FilePreview.vue -->
<!-- File preview pane: renders text/markdown/json/image/binary by mime and encoding. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Markdown from './Markdown.vue';

const { t } = useI18n();

export interface FileData {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  languageId?: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
}

const props = defineProps<{
  file: FileData | null;
  loading: boolean;
}>();

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

type ContentKind = 'markdown' | 'json' | 'image' | 'text' | 'binary';

const contentKind = computed<ContentKind>(() => {
  const f = props.file;
  if (!f) return 'binary';
  const mime = f.mime ?? '';
  const lang = f.languageId ?? '';

  if (mime === 'text/markdown' || lang === 'markdown' || lang === 'md') return 'markdown';
  if (mime === 'application/json' || lang === 'json') return 'json';
  if (mime.startsWith('image/')) return 'image';
  if (f.isBinary) return 'binary';
  // text/* and code files
  if (mime.startsWith('text/') || lang !== '') return 'text';
  return 'binary';
});

// ---------------------------------------------------------------------------
// JSON pretty-print
// ---------------------------------------------------------------------------

const prettyJson = computed<string>(() => {
  if (contentKind.value !== 'json' || !props.file) return '';
  try {
    return JSON.stringify(JSON.parse(props.file.content), null, 2);
  } catch {
    return props.file.content;
  }
});

// ---------------------------------------------------------------------------
// Line numbers for code/text
// ---------------------------------------------------------------------------

const lines = computed<string[]>(() => {
  const f = props.file;
  if (!f) return [];
  const src = contentKind.value === 'json' ? prettyJson.value : f.content;
  return src.split('\n');
});

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

function copyContent(): void {
  if (!props.file) return;
  navigator.clipboard.writeText(props.file.content).then(() => {
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1400);
  }).catch(() => {/* ignore */});
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
  <div class="file-preview">
    <!-- Empty state: nothing selected -->
    <div v-if="!file && !loading" class="fp-empty">
      {{ t('filePreview.empty') }}
    </div>

    <!-- Loading state -->
    <div v-else-if="loading" class="fp-loading">
      <span class="spinner"></span>
      <span>{{ t('filePreview.loading') }}</span>
    </div>

    <!-- File loaded -->
    <template v-else-if="file">
      <!-- Header -->
      <div class="fp-header">
        <span class="fp-path" :title="file.path">{{ truncatePath(file.path) }}</span>
        <span class="fp-meta">
          <span v-if="file.lineCount" class="fp-lines">{{ t('filePreview.lineCount', { count: file.lineCount }) }}</span>
          <span class="fp-size">{{ formatSize(file.size) }}</span>
        </span>
        <button
          v-if="!file.isBinary && contentKind !== 'image'"
          class="fp-copy"
          :class="{ copied }"
          @click="copyContent"
        >
          {{ copied ? t('filePreview.copied') : t('filePreview.copy') }}
        </button>
      </div>

      <!-- Body: Markdown -->
      <div v-if="contentKind === 'markdown'" class="fp-body fp-markdown">
        <Markdown :text="file.content" />
      </div>

      <!-- Body: JSON -->
      <div v-else-if="contentKind === 'json'" class="fp-body fp-code">
        <div class="fp-line-table">
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            class="fp-line-row"
          >
            <span class="fp-gutter">{{ idx + 1 }}</span>
            <span class="fp-line-text">{{ line }}</span>
          </div>
        </div>
      </div>

      <!-- Body: Image (base64) -->
      <div v-else-if="contentKind === 'image'" class="fp-body fp-image-wrap">
        <template v-if="file.encoding === 'base64'">
          <img
            :src="`data:${file.mime};base64,${file.content}`"
            :alt="file.path"
            class="fp-image"
          />
        </template>
        <div v-else class="fp-binary-card">
          <span class="fp-binary-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M7 10h6M10 7v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
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
          >
            <span class="fp-gutter">{{ idx + 1 }}</span>
            <span class="fp-line-text">{{ line }}</span>
          </div>
        </div>
      </div>

      <!-- Body: Binary / unknown -->
      <div v-else class="fp-body fp-binary-wrap">
        <div class="fp-binary-card">
          <span class="fp-binary-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 3h7l4 4v10H5V3z" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M12 3v4h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
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
  font-size: 12px;
}

/* ---- Header ---- */
.fp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  flex: none;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}

.fp-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  font-size: 12px;
  color: var(--ink);
  font-weight: 500;
}

.fp-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.fp-lines,
.fp-size {
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}

.fp-copy {
  flex: none;
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--mono);
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--dim);
  cursor: pointer;
  white-space: nowrap;
}
.fp-copy:hover {
  background: var(--soft);
  color: var(--blue2);
  border-color: var(--bd);
}
.fp-copy.copied {
  color: var(--ok);
  border-color: #a8d5b5;
}

/* ---- Body ---- */
.fp-body {
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
  font-size: 12px;
  line-height: 1.6;
}

.fp-line-row {
  display: table-row;
}

.fp-line-row:hover {
  background: var(--panel2);
}

.fp-gutter {
  display: table-cell;
  width: 44px;
  padding: 0 10px 0 12px;
  text-align: right;
  color: var(--faint);
  user-select: none;
  font-size: 11px;
  white-space: nowrap;
  border-right: 1px solid var(--line2);
  vertical-align: top;
}

.fp-line-text {
  display: table-cell;
  padding: 0 12px;
  color: var(--ink);
  white-space: pre;
  vertical-align: top;
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
  font-size: 12px;
  margin: 32px auto;
  max-width: 480px;
}

.fp-binary-icon {
  color: var(--faint);
  flex: none;
}

/* ---- Spinner ---- */
@keyframes spin { to { transform: rotate(360deg); } }

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--line);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ---- Mobile (≤640px): a comfier header (copy is a real tap target), and the
        code body keeps its line-number gutter while scrolling sideways for long
        lines. Markdown/images fit the full width. ---- */
@media (max-width: 640px) {
  .fp-header { padding: 8px 12px; gap: 8px; }
  .fp-copy {
    min-height: 32px;
    padding: 5px 12px;
    font-size: 12px;
    border-radius: 6px;
  }
  /* Hide the line-count chip on the narrowest screens to keep the header tidy;
     the size chip + copy stay. */
  .fp-lines { display: none; }
  .fp-markdown { padding: 14px 16px; }
  .fp-body.fp-code { -webkit-overflow-scrolling: touch; }
}
</style>
