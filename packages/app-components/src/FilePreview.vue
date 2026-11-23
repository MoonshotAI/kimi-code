<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Markdown } from '@moonshot-ai/app-markdown';
import type { FileData, FilePreviewRequest } from '@moonshot-ai/app-core/client/types';
import { copyTextToClipboard, pathDirname, resolveRelativePath } from '@moonshot-ai/app-core/lib';
import { MAX_HIGHLIGHT_CHARS, FILE_PREVIEW_MAX_BYTES } from '@moonshot-ai/app-core/client';
import { OpenFileLinkKey, ResolveImageKey } from '@moonshot-ai/app-core/contracts';
import { OpenInServiceKey, OpenWithDefaultAppKey } from '@moonshot-ai/app-client/contracts';
import { useWarningsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { isOfficeDocumentPath } from '@moonshot-ai/app-core/preview';
import { Button, Icon, IconButton, Menu, MenuItem, PanelHeader, SegmentedControl, Spinner } from '@moonshot-ai/app-ui';
import { stripLeadingSlash } from './lib/displayPath';
import HighlightedCode from './HighlightedCode.vue';
import HtmlOpenActions from './HtmlOpenActions.vue';
import OpenInMenu from './chat/OpenInMenu.vue';
import FileTreePositionMenu from './FileTreePositionMenu.vue';
import type { FileTreePosition } from './composables/useFileTreePosition';

const { t } = useI18n();

const parentResolveImage = inject(ResolveImageKey, async (src: string) => src);
const markdownBaseDir = computed(() => pathDirname(props.file?.path ?? ''));
function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('\\\\')) return src;
  const base = markdownBaseDir.value;
  if (!base) return src;
  return resolveRelativePath(src, base);
}
async function resolveMarkdownImage(src: string): Promise<string> {
  const resolved = resolveImageSrc(src);
  if (parentResolveImage) return parentResolveImage(resolved);
  return resolved;
}
provide(ResolveImageKey, resolveMarkdownImage);
provide(OpenFileLinkKey, undefined);

function resolveMarkdownLinkDir(href: string): string {
  if (href.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(href) || href.startsWith('\\\\')) {
    return href;
  }
  return resolveRelativePath(href, markdownBaseDir.value);
}

function resolveMarkdownFileTarget(target: { path: string; line?: number }): FilePreviewRequest {
  const path = resolveMarkdownLinkDir(target.path);
  return path === target.path ? target : { ...target, path };
}

const props = defineProps<{
  file: FileData | null;
  loading: boolean;
  error?: string | null;
  line?: number;
  downloadUrl?: string | null;
  mediaUrl?: string | null;
  displayPath?: string;
  closable?: boolean;
  externalActions?: boolean;
  assumed?: boolean;
  stale?: boolean;
  refreshing?: boolean;
  treeAvailable?: boolean;
  treeOpen?: boolean;
  treePosition?: FileTreePosition;
  openFile?: (target: FilePreviewRequest) => void;
}>();

const emit = defineEmits<{
  close: [];
  openExternal: [];
  reveal: [];
  refresh: [];
  toggleTree: [];
}>();

function handleMarkdownOpenFile(target: { path: string; line?: number }): void {
  props.openFile?.(resolveMarkdownFileTarget(target));
}

const rootRef = ref<HTMLElement | null>(null);

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
  if (mime.startsWith('text/') || lang !== '') return 'text';
  return 'binary';
});

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

const prettyJson = computed<string>(() => {
  if (contentKind.value !== 'json' || !props.file) return '';
  try {
    return JSON.stringify(JSON.parse(decodedContent.value), null, 2);
  } catch {
    return decodedContent.value;
  }
});

const lines = computed<string[]>(() => {
  if (!props.file) return [];
  const src = contentKind.value === 'json' ? prettyJson.value : decodedContent.value;
  return src.split('\n');
});

const sourceText = computed<string>(() => {
  if (!props.file) return '';
  return contentKind.value === 'json' ? prettyJson.value : decodedContent.value;
});

const jsonReformatted = computed<boolean>(
  () => contentKind.value === 'json' && prettyJson.value !== decodedContent.value,
);

const lineNumberList = computed<number[]>(() => lines.value.map((_, i) => i + 1));

const highlightPath = computed<string | undefined>(() =>
  props.file && sourceText.value.length <= MAX_HIGHLIGHT_CHARS ? props.file.path : undefined,
);

function scrollToLine(line: number | undefined, reset = false): void {
  if (!line) return;
  void nextTick(() => {
    const bodyEl = rootRef.value?.querySelector<HTMLElement>('.fp-body');
    const el = bodyEl?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!bodyEl || !el) return;
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

function lineClass(lineNo: number): Record<string, boolean> {
  return { target: props.line === lineNo };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const copiedPath = ref(false);

function copyPath(): void {
  const path = openTargetPath.value;
  if (!path) return;
  void copyTextToClipboard(path).then((ok) => {
    if (!ok) return;
    copiedPath.value = true;
    setTimeout(() => { copiedPath.value = false; }, 1400);
  });
}

const htmlMode = ref<'preview' | 'source'>('preview');
const markdownMode = ref<'preview' | 'source'>('preview');
const imageFit = ref<'fit' | 'actual'>('fit');
const codeWrap = ref(false);

const showWrapToggle = computed(() => {
  const kind = contentKind.value;
  if (kind === 'text' || kind === 'json') return true;
  if (kind === 'html') return htmlMode.value === 'source';
  if (kind === 'markdown') return markdownMode.value === 'source';
  return false;
});

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
  codeWrap.value = false;
});

const imageSrc = computed<string | null>(() => {
  const f = props.file;
  if (!f || contentKind.value !== 'image') return null;
  if (props.mediaUrl) return props.mediaUrl;
  if (f.encoding === 'base64' && f.content !== '') return `data:${f.mime};base64,${f.content}`;
  if (f.mime === 'image/svg+xml' && f.encoding !== 'base64') {
    return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.content)}`;
  }
  return null;
});

const PDF_VIEWER_PARAMS = '#toolbar=0&navpanes=0';

const pdfSrc = computed<string | null>(() => {
  const f = props.file;
  if (!f || contentKind.value !== 'pdf') return null;
  if (props.mediaUrl) return `${props.mediaUrl}${PDF_VIEWER_PARAMS}`;
  if (f.encoding === 'base64' && f.content !== '') return `data:application/pdf;base64,${f.content}${PDF_VIEWER_PARAMS}`;
  if (props.downloadUrl) return `${props.downloadUrl}${PDF_VIEWER_PARAMS}`;
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

const fileTitle = computed(() => stripLeadingSlash(props.displayPath || props.file?.path || ''));

const openTargetPath = computed(() => props.displayPath || props.file?.path || '');

const openInService = inject(OpenInServiceKey);
const localFiles = computed(() => workspacesStore().isLocalWorkspace);
const hostActions = computed(() => Boolean(props.externalActions) && localFiles.value);
const openWithDefaultApp = inject(OpenWithDefaultAppKey, undefined);
const warningsStore = useWarningsStore();
const canOpenInDefaultApp = computed(
  () => openWithDefaultApp !== undefined && isOfficeDocumentPath(openTargetPath.value),
);

async function openInDefaultApp(): Promise<void> {
  if (!canOpenInDefaultApp.value || openWithDefaultApp === undefined) return;
  try {
    const ok = await openWithDefaultApp(openTargetPath.value);
    if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('filePreview.openFailed') });
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('filePreview.openFailed') });
  }
}

const menuOpen = ref(false);
const menuTriggerRef = ref<InstanceType<typeof IconButton> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});
const downloadRef = ref<HTMLAnchorElement | null>(null);

const hasMenuItems = computed(
  () =>
    hostActions.value ||
    (props.file != null && !props.file.isBinary && contentKind.value !== 'image') ||
    Boolean(props.downloadUrl),
);

function onMenuDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target)) return;
  if ((menuTriggerRef.value?.$el as HTMLElement | undefined)?.contains(target)) return;
  closeMenu();
}

function onMenuScrollResize(): void {
  closeMenu();
}

function onMenuDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeMenu();
}

async function openMenu(): Promise<void> {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  document.addEventListener('mousedown', onMenuDocClick);
  window.addEventListener('keydown', onMenuDocKeydown, true);
  window.addEventListener('resize', onMenuScrollResize);
  window.addEventListener('blur', closeMenu);
  await nextTick();
  const btn = (menuTriggerRef.value?.$el as HTMLElement | undefined) ?? null;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onMenuDocClick);
  window.removeEventListener('keydown', onMenuDocKeydown, true);
  window.removeEventListener('resize', onMenuScrollResize);
  window.removeEventListener('blur', closeMenu);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onMenuDocClick);
  window.removeEventListener('keydown', onMenuDocKeydown, true);
  window.removeEventListener('resize', onMenuScrollResize);
  window.removeEventListener('blur', closeMenu);
});

function menuOpenExternal(): void {
  closeMenu();
  emit('openExternal');
}

function menuCopyContent(): void {
  closeMenu();
  if (!props.file) return;
  void copyTextToClipboard(sourceText.value);
}

function menuDownload(): void {
  closeMenu();
  downloadRef.value?.click();
}
</script>

<template>
  <div ref="rootRef" class="file-preview panel-file-head" :class="{ 'fp-refreshing': refreshing }">
    <PanelHeader v-if="file || loading || error" :title="fileTitle" :title-tooltip="openTargetPath" :closable="false">
        <IconButton
          v-if="treeAvailable"
          class="fp-tree-toggle tree-toggle-head"
          :class="{ 'tree-toggle-left': treePosition === 'left' }"
          size="sm"
          :pressed="treeOpen"
          :label="treeOpen ? t('fileTree.treeHide') : t('fileTree.treeShow')"
          :tooltip="treeOpen ? t('fileTree.treeHide') : t('fileTree.treeShow')"
          @click="emit('toggleTree')"
        >
          <Icon name="folder-tree" size="md" />
        </IconButton>
        <div class="panel-file-head-actions">
          <Button
            variant="secondary"
            size="xs"
            :style="{ visibility: stale ? 'visible' : 'hidden' }"
            :aria-label="t('filePreview.refresh')"
            :disabled="!stale || refreshing"
            @click="emit('refresh')"
          >
            <Icon name="refresh" size="sm" />
            {{ t('filePreview.refresh') }}
          </Button>
          <SegmentedControl
            v-if="contentKind === 'html'"
            :model-value="htmlMode"
            size="xs"
            :options="[
              { value: 'preview', label: t('filePreview.preview') },
              { value: 'source', label: t('filePreview.source') },
            ]"
            @update:model-value="setHtmlMode"
          />
          <HtmlOpenActions v-if="contentKind === 'html'" :path="openTargetPath" />
          <SegmentedControl
            v-if="contentKind === 'markdown'"
            :model-value="markdownMode"
            size="xs"
            :options="[
              { value: 'preview', label: t('filePreview.preview') },
              { value: 'source', label: t('filePreview.source') },
            ]"
            @update:model-value="setMarkdownMode"
          />
          <SegmentedControl
            v-if="contentKind === 'image'"
            :model-value="imageFit"
            size="xs"
            :options="[
              { value: 'fit', label: t('filePreview.fit') },
              { value: 'actual', label: t('filePreview.actual') },
            ]"
            @update:model-value="setImageFit"
          />
          <IconButton
            v-if="showWrapToggle"
            size="sm"
            :label="codeWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
            :tooltip="codeWrap ? t('conversation.unwrapCode') : t('conversation.wrapCode')"
            :aria-pressed="codeWrap"
            @click="codeWrap = !codeWrap"
          >
            <Icon :name="codeWrap ? 'text-wrap-disabled' : 'text-wrap'" size="md" />
          </IconButton>
          <OpenInMenu v-if="openInService && localFiles" :file-path="openTargetPath" />
          <template v-else>
            <IconButton size="sm" :class="{ copied: copiedPath }" :label="copiedPath ? t('filePreview.copied') : t('filePreview.copyPath')" :tooltip="copiedPath ? t('filePreview.copied') : t('filePreview.copyPath')" @click="copyPath">
              <Icon v-if="!copiedPath" name="link" size="md" />
              <Icon v-else class="fp-check" name="check" size="md" />
            </IconButton>
            <IconButton v-if="hostActions" size="sm" :label="t('filePreview.reveal')" :tooltip="t('filePreview.reveal')" @click="emit('reveal')">
              <Icon name="folder" size="md" />
            </IconButton>
            <IconButton
              v-if="hasMenuItems"
              ref="menuTriggerRef"
              size="sm"
              :label="t('filePreview.moreActions')"
              :tooltip="t('filePreview.moreActions')"
              :aria-expanded="menuOpen"
              aria-haspopup="menu"
              @click="openMenu"
            >
              <Icon name="dots-horizontal" size="md" />
            </IconButton>
            <Menu
              v-if="menuOpen"
              ref="menuRef"
              class="ui-menu-floating fp-menu"
              :style="menuStyle"
              @click.stop
            >
              <MenuItem v-if="hostActions" @click="menuOpenExternal">
                <Icon name="external-link" size="sm" />
                {{ t('filePreview.openInEditor') }}
              </MenuItem>
              <MenuItem v-if="file && !file.isBinary && contentKind !== 'image'" @click="menuCopyContent">
                <Icon name="copy" size="sm" />
                {{ t('filePreview.copy') }}
              </MenuItem>
              <MenuItem v-if="downloadUrl" @click="menuDownload">
                <Icon name="download" size="sm" />
                {{ t('filePreview.download') }}
              </MenuItem>
            </Menu>
          </template>
          <FileTreePositionMenu v-if="treeAvailable" class="fp-tree-settings" />
        </div>
      </PanelHeader>
      <a ref="downloadRef" :href="downloadUrl ?? undefined" target="_blank" rel="noreferrer" download hidden />
      <div v-if="assumed && file" class="fp-assumed" :title="openTargetPath">{{ t('filePreview.assumedResolution', { path: openTargetPath }) }}</div>
      <div v-if="file?.truncated" class="fp-truncated">
        {{ t('filePreview.truncatedNotice', { shown: formatSize(FILE_PREVIEW_MAX_BYTES), total: formatSize(file.size) }) }}
      </div>

      <div class="fp-content">
        <div v-if="error && !loading" class="fp-empty fp-error">
          <span>{{ error }}</span>
          <Button v-if="canOpenInDefaultApp" variant="secondary" size="sm" @click="openInDefaultApp">
            <Icon name="external-link" size="sm" />
            {{ t('conversation.openInDefaultApp') }}
          </Button>
          <Button v-if="closable" variant="secondary" size="sm" @click="emit('close')">
            {{ t('filePreview.close') }}
          </Button>
        </div>

        <div v-else-if="!file && !loading" class="fp-empty">
          <slot name="empty">{{ t('filePreview.empty') }}</slot>
        </div>

        <div v-else-if="loading" class="fp-loading">
          <Spinner size="sm" aria-hidden="true" />
          <span>{{ t('filePreview.loading') }}</span>
        </div>

        <template v-else-if="file">
        <!-- Body: Markdown (PREVIEW mode renders HTML whose fenced code blocks
             carry their own block-relative data-line rows — not source-file
             lines: the quote provenance marker keeps them out of
             captureQuoteSource; source mode shows the real line grid) -->
        <div
          v-if="contentKind === 'markdown'"
          class="fp-body"
          :class="{ 'fp-markdown': markdownMode === 'preview' }"
          :data-quote-display-lines="markdownMode === 'preview' || undefined"
        >
          <!-- Keyed by the file path: a switch to a DIFFERENT file with
               identical content leaves :text unchanged, and without the remount
               the decoration pass would keep mention paths resolved against the
               OLD file's directory. -->
          <Markdown
            v-if="markdownMode === 'preview'"
            :key="file?.path"
            :text="decodedContent"
            :open-file="props.openFile ? handleMarkdownOpenFile : undefined"
            :resolve-mention-path="resolveMarkdownLinkDir"
          />
          <div v-else class="fp-code">
            <HighlightedCode :code="lines" :path="highlightPath" :line-numbers="lineNumberList" :framed="false" :line-class="lineClass" :wrap="codeWrap" />
          </div>
        </div>

        <!-- Body: JSON (pretty-printed: only an ACTUALLY reformatted document
             has FORMATTED display lines instead of source-file lines — the
             quote provenance marker tracks jsonReformatted) -->
        <div v-else-if="contentKind === 'json'" class="fp-body fp-code" :data-quote-display-lines="jsonReformatted || undefined">
          <HighlightedCode :code="lines" :path="highlightPath" :line-numbers="lineNumberList" :framed="false" :line-class="lineClass" :wrap="codeWrap" />
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
            <HighlightedCode :code="lines" :path="highlightPath" :line-numbers="lineNumberList" :framed="false" :line-class="lineClass" :wrap="codeWrap" />
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
          <HighlightedCode :code="lines" :path="highlightPath" :line-numbers="lineNumberList" :framed="false" :line-class="lineClass" :wrap="codeWrap" />
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
            <Button v-if="canOpenInDefaultApp" variant="secondary" size="sm" @click="openInDefaultApp">
              <Icon name="external-link" size="sm" />
              {{ t('conversation.openInDefaultApp') }}
            </Button>
          </div>
        </div>
        </template>
        <div v-if="treeOpen" class="fp-sidebar" :class="{ 'fp-sidebar-left': treePosition === 'left' }">
          <slot name="sidebar" />
        </div>
      </div>
  </div>
</template>

<style src="./lib/panel-file-head.css"></style>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  font-family: var(--font-mono);
  min-width: 0;
  container-type: inline-size;
}

.fp-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.fp-content > .fp-body {
  flex: 1;
  min-width: 0;
}

.fp-sidebar {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.fp-sidebar-left {
  order: -1;
}

@container (max-width: 360px) {
  .fp-sidebar,
  .fp-tree-toggle,
  .fp-tree-settings {
    display: none;
  }
}

.fp-empty,
.fp-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text-faint);
  font-size: var(--text-base);
}

.fp-assumed {
  flex: none;
  padding: 5px 12px;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text-faint);
  background: var(--color-surface);
  border-bottom: var(--p-hairline) solid var(--color-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.fp-truncated {
  flex: none;
  padding: 5px 12px;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-warning, var(--color-text-faint));
  background: var(--color-surface);
  border-bottom: var(--p-hairline) solid var(--color-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fp-check {
  color: var(--color-success);
}

.fp-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: var(--pfc-host-h, 0px);
}

.file-preview.fp-refreshing .fp-body {
  opacity: 0.6;
}

.fp-markdown {
  padding: 16px 20px;
  --markdown-font-family: var(--font-ui);
}

.fp-code {
  background: var(--color-bg);
}

.fp-code :deep(.hl-row.target),
.fp-table tr.target th,
.fp-table tr.target td {
  background: var(--color-accent-soft);
}

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

.fp-table-wrap {
  background: var(--color-bg);
}
.fp-table {
  border-collapse: collapse;
  min-width: 100%;
  font: var(--code-font-size)/var(--leading-normal) var(--font-mono);
}
.fp-table th {
  position: sticky;
  left: 0;
  z-index: 1;
  width: 44px;
  min-width: 44px;
  padding: 2px 8px;
  text-align: right;
  color: var(--color-text-quaternary);
  background: var(--color-surface);
  border-right: var(--p-hairline) solid var(--color-subtle);
  user-select: none;
}
.fp-table td {
  padding: 2px 10px;
  border-right: var(--p-hairline) solid var(--color-subtle);
  border-bottom: var(--p-hairline) solid var(--color-subtle);
  white-space: pre;
}

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
  border: var(--p-hairline) solid var(--color-line);
  border-radius: 4px;
  background: var(--media-alpha-canvas);
}
.fp-image.actual {
  max-width: none;
  max-height: none;
}

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
  border: var(--p-hairline) solid var(--color-line);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  margin: 32px auto;
  max-width: 480px;
}

.fp-binary-icon {
  color: var(--color-text-quaternary);
  flex: none;
}
.fp-error {
  flex-direction: column;
  padding: 24px;
  text-align: center;
}

@media (max-width: 640px) {
  .fp-markdown { padding: 14px 16px; }
  .fp-body.fp-code { -webkit-overflow-scrolling: touch; }
}

.fp-empty,
.fp-loading { font-family: var(--font-ui); }
.fp-binary-card { border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-md); }
.fp-binary-label { font-family: var(--font-ui); }
.fp-image { border-radius: var(--radius-md); }
.seg-btn { font-family: var(--font-ui); }
</style>
