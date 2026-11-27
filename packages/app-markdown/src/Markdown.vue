<!-- @moonshot-ai/app-markdown — Markdown.vue -->
<script lang="ts">
import { setCustomComponents } from 'markstream-vue';
import MarkdownImage from './MarkdownImage.vue';

setCustomComponents('kimi-markdown', { image: MarkdownImage });
</script>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, shallowRef, watch } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import { MarkdownRender, enableKatex, enableMermaid, languageMap } from 'markstream-vue';
import { ensureMarkdownWorkers } from './lib/markdownWorkers';
import { useIsDark } from '@moonshot-ai/app-core/composables';
import { HistoryStateKey, OpenFileLinkKey, OpenLocalHtmlFileKey, OpenSidebarBrowserUrlKey, PinScrollKey, ResolveImageKey } from '@moonshot-ai/app-core/contracts';
import { classifyMentionHref, decodeSessionMention, decodeSkillMention, mentionActionLine, mentionActionPath, mentionActionSuffix, sessionMentionPath, unescapeLinkDest, unescapeRenderedLinkText } from '@moonshot-ai/app-composer/model';
import { mentionHrefToPath, mentionIconSvg, truncateMentionName } from '@moonshot-ai/app-composer/features/mention';
import { collectFilePathAliases, findFilePathLinks, isRelativeLinkCandidate, type FilePathResolution } from './lib/filePathLinks';
import { splitFrontmatter } from './lib/frontmatter';
import Frontmatter from './Frontmatter.vue';
import { configureMarkdownIt } from './lib/inlineMath';
import { markdownRenderPlan } from './lib/markdownPerformance';
import { splitDiffFences } from './lib/codeFences';
import { imageSources, rewriteImageSources } from './lib/imageSources';
import { MARKDOWN_CODE_THEME, MARKDOWN_CODE_THEME_DARK } from './lib/codeTheme';
import { isMarkdownCodeHeader, markdownFenceSources } from './lib/codePreview';
import { listMarkerWidth } from './lib/listMarkerWidth';
import { HistoryImageCacheKey } from './lib/historyImages';
import { createMarkdownImageSizes, MarkdownImageSizesKey, pendingImageIndex, pendingImageSrc, type ImageSize } from './lib/imageSizes';
import { copyCodeBlockFallback, copyTextToClipboard } from './lib/clipboard';
import { markdownTableSources } from './lib/tableSource';
import { createCodeScrollbars } from './lib/codeScrollbars';
import { CODE_BLOCK_UNSAFE_CSS, diffWrapKeys, ensureCodeBlockToggles, ensureCodeCopyTooltip, pruneWrapKeys, toggleWrapIndex, type CodeBlockToggleLabels } from './lib/codeWrap';
import { ensureCodeTooltip, hideCodeTooltipIfAnchorGone, hideCodeTooltipIfAnchorWithin } from './lib/codeTooltip';
import { ensureLinkTooltip, syncLinkTooltipWithAnchor, hideLinkTooltipIfAnchorWithin } from './lib/linkTooltip';
import {
  destroyTableWideToggles,
  ensureTableWideToggle,
  positionTableActions,
  pruneTableWideToggles,
  TABLE_TOGGLE_EVENT,
  tableWidthTransitionMs,
  toggleTableWide,
  type TableWideToggleLabels,
} from './lib/tableWide';
import { destroyTableSelections, ensureTableSelection, pruneTableSelections, tableSelectionText, type TableSelectionLabels } from './lib/tableSelection';
import { streamingLinkAction } from './lib/streamingLinkGuard';
import { localFilePreviewPath, localHtmlFileUrl } from './lib/localHtmlLinks';
import { Icon, IconButton, SegmentedControl, Tooltip } from '@moonshot-ai/app-ui';
import 'markstream-vue/index.px.css';
import './codeScrollbars.css';
import 'katex/dist/katex.min.css';

interface FilePreviewRequest {
  path: string;
  line?: number;
  urlSuffix?: string;
  assumed?: boolean;
}
Object.assign(languageMap, { typescript: 'TypeScript', ts: 'TypeScript', javascript: 'JavaScript', js: 'JavaScript' });
enableKatex();

enableMermaid();

ensureMarkdownWorkers();

const { t } = useKimiI18n();

const injectedResolveImage = inject(ResolveImageKey, undefined);
const resolveImageFn = computed(() => {
  const fn = props.resolveImage ?? injectedResolveImage;
  return fn === undefined ? undefined : (src: string) => fn(decodeImageSrc(src));
});
const openSidebarBrowserUrl = inject(OpenSidebarBrowserUrlKey, undefined);
const resolveOpenLocalHtmlFile = inject(OpenLocalHtmlFileKey, undefined);
const openFileLink = inject(OpenFileLinkKey, undefined);
const pinScroll = inject(PinScrollKey, undefined);
const mdRef = ref<HTMLElement | null>(null);
const props = withDefaults(
  defineProps<{
    text: string;
    openFile?: (target: FilePreviewRequest) => void;
    resolveFilePath?: (path: string) => FilePathResolution | null;
    resolveImage?: (src: string) => Promise<string>;
    resolveMentionPath?: (path: string) => string;
    streaming?: boolean;
    stateKey?: string;
  }>(),
  { streaming: false },
);

function openFileTarget(target: FilePreviewRequest): void {
  const open = props.openFile;
  if (open === undefined) return;
  if (openFileLink === undefined) open(target);
  else openFileLink(target, open);
}

const historyState = inject(HistoryStateKey, undefined);
const historyKey = `markdown:${props.stateKey ?? 'body'}`;
const imageCache = historyState ? inject(HistoryImageCacheKey, undefined) : undefined;
const imageStateKey = `${historyKey}:image-key`;
const imageKey = imageCache ? (historyState?.get(imageStateKey) ?? {}) as object : undefined;
if (imageKey) historyState!.set(imageStateKey, imageKey);
const saved = historyState?.get(historyKey) as { text: string; code: { wrap: boolean; nums: boolean }[]; tables: boolean[]; details: boolean[]; scroll: { top: number; left: number }[]; wraps: string[]; numbers: string[]; previews?: number[] } | undefined;
const retained = saved?.text === props.text ? saved : undefined;
const pendingPreviews = new Set(retained?.previews ?? []);
let savedCode: { wrap: boolean; nums: boolean }[] = retained?.code ?? [];
let savedTables: boolean[] = retained?.tables ?? [];
let savedDetails: boolean[] = retained?.details ?? [];
let savedScroll: { top: number; left: number }[] = retained?.scroll ?? [];
let restoredElements = new WeakSet<Element>();
let restoredScroll = new WeakSet<Element>();

function historyNodes<T extends Element>(root: HTMLElement, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector)).filter(node => !node.closest('.markdown-code-preview'));
}

function scrollSurfaces(): (HTMLElement | null)[] {
  const root = mdRef.value;
  if (!root) return [];
  return Array.from(historyNodes<HTMLElement>(root, '.code-block-container, .diff-pre, .table-node-wrapper, .node-content > pre[data-markstream-pre]'), (el) =>
    el.classList.contains('code-block-container')
      ? el.querySelector('diffs-container')?.shadowRoot?.querySelector<HTMLElement>('code[data-code]') ?? el.querySelector<HTMLElement>('pre')
      : el,
  );
}

function saveWindowState(): void {
  const root = mdRef.value;
  if (!root) return;
  savedCode = Array.from(historyNodes<HTMLElement>(root, '.code-block-container'), (el) => ({
    wrap: el.classList.contains('md-code-wrap'), nums: el.classList.contains('md-code-nums'),
  }));
  savedTables = Array.from(historyNodes<HTMLElement>(root, '.table-node-wrapper'), (el) => el.classList.contains('md-table-wide'));
  savedDetails = Array.from(historyNodes<HTMLDetailsElement>(root, 'details'), (el) => el.open);
  savedScroll = scrollSurfaces().map((el) => ({ top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0 }));
  restoredElements = new WeakSet();
  restoredScroll = new WeakSet();
}

watch(() => props.text, () => {
  pendingPreviews.clear();
  previewedCode.clear();
  savedCode = [];
  savedTables = [];
  savedDetails = [];
  savedScroll = [];
});

function restoreWindowState(): void {
  const root = mdRef.value;
  if (!root || !historyState) return;
  historyNodes<HTMLElement>(root, '.code-block-container').forEach((el, index) => {
    const saved = savedCode[index];
    if (!saved || restoredElements.has(el)) return;
    el.classList.toggle('md-code-wrap', saved.wrap);
    el.classList.toggle('md-code-nums', saved.nums);
    ensureCodeBlockToggles(el, codeBlockToggleLabels());
    restoredElements.add(el);
  });
  historyNodes<HTMLElement>(root, '.table-node-wrapper').forEach((el, index) => {
    if (savedTables[index] === undefined || restoredElements.has(el)) return;
    if (savedTables[index] !== el.classList.contains('md-table-wide')) toggleTableWide(el, tableWideLabels());
    restoredElements.add(el);
  });
  historyNodes<HTMLDetailsElement>(root, 'details').forEach((el, index) => {
    if (savedDetails[index] === undefined || restoredElements.has(el)) return;
    el.open = savedDetails[index]!;
    restoredElements.add(el);
  });
  scrollSurfaces().forEach((el, index) => {
    const saved = savedScroll[index];
    if (!saved || !el || restoredScroll.has(el)) return;
    el.scrollTop = saved.top;
    el.scrollLeft = saved.left;
    if (Math.abs(el.scrollTop - saved.top) < 1 && Math.abs(el.scrollLeft - saved.left) < 1) restoredScroll.add(el);
  });
}

const final = computed(() => !props.streaming);

const frontmatterSplit = computed(() => splitFrontmatter(props.text ?? ''));
const frontmatter = computed(() => frontmatterSplit.value.frontmatter);
const markdownBody = computed(() => frontmatterSplit.value.body);

const filePathAliases = computed(() => collectFilePathAliases(markdownBody.value));
const renderPlan = computed(() => markdownRenderPlan(markdownBody.value));

const isDark = useIsDark();

const allowBatchRender = computed(() => !props.streaming && !historyState);

const resolvedImages = reactive(new Map<string, string>(imageKey ? imageCache?.get(imageKey, props.text) : undefined));
const pendingImages = new Set<string>();

const images = computed(() => imageSources(markdownBody.value));

function isLocalImageSrc(src: string): boolean {
  return !/^(https?:|data:|blob:)/i.test(src);
}

function decodeImageSrc(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

function queueImageResolution(): void {
  const resolveImage = resolveImageFn.value;
  if (!resolveImage) return;
  const epoch = imageResolutionEpoch;
  for (const { src } of images.value) {
    if (!src || !isLocalImageSrc(src)) continue;
    if (resolvedImages.has(src) || pendingImages.has(src)) continue;
    pendingImages.add(src);
    resolveImage(src)
      .then((url) => {
        if (epoch !== imageResolutionEpoch) return;
        const resolved = url !== src ? url : '';
        resolvedImages.set(src, resolved);
        if (resolved && imageKey) imageCache?.set(imageKey, props.text, resolvedImages);
      })
      .catch(() => {
        if (epoch !== imageResolutionEpoch) return;
        resolvedImages.set(src, '');
      })
      .finally(() => {
        pendingImages.delete(src);
      });
  }
}

let imageResolutionEpoch = 0;

watch(resolveImageFn, () => {
  imageResolutionEpoch += 1;
  resolvedImages.clear();
  pendingImages.clear();
  queueImageResolution();
})

function rewriteImageSrcs(text: string): string {
  const resolveImage = resolveImageFn.value;
  if (!resolveImage) return text;
  const sub = (src: string): string | null => {
    if (!isLocalImageSrc(src)) return null;
    const resolved = resolvedImages.get(src);
    if (resolved === undefined) return pendingImageSrc(images.value.findIndex(image => image.src === src));
    return resolved === '' ? null : resolved;
  };
  return rewriteImageSources(text, images.value, sub);
}

watch(
  markdownBody,
  () => queueImageResolution(),
  { immediate: true },
);

const imageSizesKey = `${historyKey}:image-sizes`;
const imageSizes = reactive((historyState?.get(imageSizesKey) as Map<string, ImageSize> | undefined) ?? new Map<string, ImageSize>());
historyState?.set(imageSizesKey, imageSizes);

function imageSourceOf(src: string): { key: string; pending: boolean } {
  const index = pendingImageIndex(src);
  if (index !== null) return { key: images.value[index]?.src ?? src, pending: true };
  for (const [original, resolved] of resolvedImages) {
    if (resolved === src) return { key: original, pending: false };
  }
  return { key: src, pending: false };
}

provide(MarkdownImageSizesKey, createMarkdownImageSizes(imageSizes, imageSourceOf));

function resolveCandidate(rawPath: string): FilePathResolution | null {
  const resolver = props.resolveFilePath;
  return resolver !== undefined && isRelativeLinkCandidate(rawPath) ? resolver(rawPath) : null;
}

function resolvedOpenTarget(rawPath: string, line?: number): FilePreviewRequest {
  const resolved = resolveCandidate(rawPath);
  const target: FilePreviewRequest = { path: resolved !== null && !resolved.assumed ? resolved.path : rawPath };
  if (line !== undefined) target.line = line;
  if (resolved?.assumed === true) target.assumed = true;
  return target;
}

function fileLinkTitle(rawPath: string, line?: number): string {
  const base = resolveCandidate(rawPath)?.path ?? rawPath;
  return line !== undefined ? `${base}:${line}` : base;
}

function refreshFileLinkResolutions(): void {
  const root = mdRef.value;
  if (!root || props.resolveFilePath === undefined) return;
  for (const link of root.querySelectorAll<HTMLElement>('.md-file-link[data-raw-path]')) {
    const raw = link.dataset.rawPath!;
    const line = link.dataset.line === undefined ? undefined : Number(link.dataset.line);
    const resolved = resolveCandidate(raw);
    link.title = fileLinkTitle(raw, line);
    link.dataset.filePath = resolved !== null && !resolved.assumed ? resolved.path : raw;
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a.mention-pill[data-raw-action-path]')) {
    const resolved = resolveCandidate(link.dataset.rawActionPath!);
    if (resolved !== null) {
      link.dataset.mentionPath = resolved.path;
      link.dataset.mentionActionPath = resolved.path;
    }
  }
}

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
      !parent.closest('a, pre, .md-file-link, .md-frontmatter, svg') &&
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
      const resolved = resolveCandidate(match.path);
      const link = document.createElement('span');
      link.className = 'md-file-link';
      link.setAttribute('role', 'button');
      link.tabIndex = 0;
      const icon = document.createElement('span');
      icon.className = 'mention-pill-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = mentionIconSvg('file', match.path, match.text);
      const label = document.createElement('span');
      label.className = 'mention-pill-name';
      label.textContent = match.text;
      link.append(icon, label);
      link.title = fileLinkTitle(match.path, match.line);
      link.dataset.filePath = resolved !== null && !resolved.assumed ? resolved.path : match.path;
      link.dataset.rawPath = match.path;
      if (match.line !== undefined) link.dataset.line = String(match.line);
      const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        openFileTarget(resolvedOpenTarget(match.path, match.line));
      };
      link.addEventListener('click', activate);
      link.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) openFileTarget(resolvedOpenTarget(match.path, match.line));
      });
      frag.append(link);
      cursor = match.end;
    }
    if (cursor < text.data.length) {
      frag.append(document.createTextNode(text.data.slice(cursor)));
    }
    text.parentNode.replaceChild(frag, text);
  }
}

function processMarkdownLinks(): void {
  if (!mdRef.value) return;
  for (const link of mdRef.value.querySelectorAll('a[title]')) {
    link.removeAttribute('title');
  }
  if (props.streaming) return;
  const links = mdRef.value.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const link of links) {
    if (link.dataset.mdLinkHandled === 'true') continue;
    if (link.closest('svg')) continue;
    const href = link.getAttribute('href') ?? '';
    const kind = classifyMentionHref(href);
    if (kind === null) continue;
    if (link.querySelector('img')) continue;
    link.dataset.mdLinkHandled = 'true';
    link.removeAttribute('title');
    const pathLike = kind === 'file' || kind === 'folder';
    const skill = kind === 'skill' ? decodeSkillMention(href) : undefined;
    const session = kind === 'session' ? decodeSessionMention(href) : null;
    const path = skill?.path ?? (session === null ? mentionHrefToPath(href) : sessionMentionPath(session));
    const name = unescapeRenderedLinkText(link.textContent ?? '');
    link.classList.add('mention-pill', `mention-${kind}`);
    link.dataset.mentionKind = kind;
    link.dataset.mentionName = skill?.name ?? name;
    link.dataset.mentionPath = pathLike ? (props.resolveMentionPath?.(path) ?? path) : path;
    if (pathLike) {
      const actionPath =
        props.resolveMentionPath?.(unescapeLinkDest(mentionActionPath(href), false)) ??
        unescapeLinkDest(mentionActionPath(href), false);
      if (actionPath !== link.dataset.mentionPath) link.dataset.mentionActionPath = actionPath;
    }
    if (!pathLike || props.openFile) link.removeAttribute('href');
    if (kind === 'skill' || (kind === 'file' && props.openFile)) {
      link.tabIndex = 0;
      link.setAttribute('role', 'button');
    }
    const displayName = truncateMentionName(name);
    const label = document.createElement('span');
    label.className = 'mention-pill-name';
    label.textContent = displayName;
    link.replaceChildren(label);
    if (!link.querySelector('.mention-pill-icon')) {
      const icon = document.createElement('span');
      icon.className = 'mention-pill-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = mentionIconSvg(kind, path, name);
      link.prepend(icon);
    }
    const actionLine = mentionActionLine(href);
    const actionSuffix = mentionActionSuffix(href);
    const fileTarget: FilePreviewRequest = {
      path: unescapeLinkDest(mentionActionPath(href), false),
      ...(actionLine === undefined ? {} : { line: actionLine }),
      ...(actionSuffix === '' ? {} : { urlSuffix: actionSuffix }),
    };
    if (kind === 'file' && props.resolveFilePath) {
      link.dataset.rawActionPath = fileTarget.path;
      const resolved = resolveCandidate(fileTarget.path);
      if (resolved !== null) {
        link.dataset.mentionPath = resolved.path;
        link.dataset.mentionActionPath = resolved.path;
      }
    }
    link.addEventListener('click', (event) => {
      if (kind !== 'skill' && !props.openFile) return;
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'file') openFileTarget({ ...fileTarget, ...resolvedOpenTarget(fileTarget.path) });
    });
    if (kind === 'file' && props.openFile) {
      link.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        openFileTarget({ ...fileTarget, ...resolvedOpenTarget(fileTarget.path) });
      });
    }
  }
}

function onLocalFileLinkClick(event: MouseEvent): void {
  if (event.type === 'auxclick' && event.button !== 1) return;
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!link || !mdRef.value?.contains(link) || link.closest('svg')) return;
  const href = link.getAttribute('href') ?? '';
  const url = localHtmlFileUrl(href);
  const open = url === null ? undefined : resolveOpenLocalHtmlFile?.();
  if (url !== null && open !== undefined) {
    event.preventDefault();
    event.stopImmediatePropagation();
    open(url);
    return;
  }
  if (url !== null || resolveOpenLocalHtmlFile === undefined || props.openFile === undefined) return;
  const path = localFilePreviewPath(href);
  if (path === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openFileTarget({ path });
}

function onStreamingLinkClick(event: MouseEvent): void {
  if (!props.streaming) return;
  if (event.type === 'auxclick' && event.button !== 1) return;
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!link || !mdRef.value?.contains(link)) return;
  if (link.closest('svg')) return;
  const action = streamingLinkAction(
    link.getAttribute('href') ?? '',
    props.openFile !== undefined,
  );
  if (action.type === 'passthrough') return;
  event.preventDefault();
  event.stopPropagation();
  if (action.type === 'open-file') {
    openFileTarget({ ...resolvedOpenTarget(action.path, action.line), ...(action.urlSuffix === undefined ? {} : { urlSuffix: action.urlSuffix }) });
  } else if (action.type === 'open-external') {
    window.open(action.url, '_blank', 'noopener');
  }
}

function tableWideLabels(): TableWideToggleLabels {
  return {
    widen: t('conversation.widenTable'),
    restore: t('conversation.restoreTableWidth'),
    copy: t('conversation.copyTable'),
  };
}

function tableSelectionLabels(): TableSelectionLabels {
  return {
    selectColumn: t('conversation.selectTableColumn'),
  };
}

function resolveTableSource(wrapper: HTMLElement): string | null {
  const root = mdRef.value;
  if (!root) return null;
  const wrappers = Array.from(root.querySelectorAll<HTMLElement>('.table-node-wrapper')).filter(el => el.closest('.markdown-code-preview') === null);
  const index = wrappers.indexOf(wrapper);
  if (index < 0) return null;
  return markdownTableSources(markdownBody.value)[index] ?? null;
}

function resolveTableCopy(wrapper: HTMLElement): string | null {
  return tableSelectionText(wrapper) ?? resolveTableSource(wrapper);
}

function processTableWideToggles(): void {
  if (!mdRef.value || props.streaming) return;
  pruneTableWideToggles(mdRef.value);
  const labels = tableWideLabels();
  for (const wrapper of mdRef.value.querySelectorAll<HTMLElement>('.table-node-wrapper')) {
    ensureTableWideToggle(wrapper, labels, wrapper.closest('.markdown-code-preview') ? undefined : resolveTableCopy);
  }
}

function processTableSelections(): void {
  if (!mdRef.value || props.streaming) return;
  pruneTableSelections(mdRef.value);
  const labels = tableSelectionLabels();
  for (const wrapper of mdRef.value.querySelectorAll<HTMLElement>('.table-node-wrapper')) {
    if (!wrapper.closest('.markdown-code-preview')) ensureTableSelection(wrapper, labels);
  }
}

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

function processCodeCopyTooltips(): void {
  if (!mdRef.value) return;
  const copy = t('filePreview.copyCode');
  for (const container of mdRef.value.querySelectorAll<HTMLElement>('.code-block-container')) {
    ensureCodeCopyTooltip(container, copy);
  }
}

interface CodePreview {
  id: number;
  container: HTMLElement;
  header: HTMLElement;
  code: string;
  sourceIndex: number;
  plan: ReturnType<typeof markdownRenderPlan>;
}
const codePreviews = shallowRef<CodePreview[]>([]);
const previewSources = computed(() => props.streaming ? [] : markdownFenceSources(rewriteImageSrcs(markdownBody.value)));
const previewedCode = reactive(new Set<number>());
let nextPreviewId = 0;

function processCodePreviews(): void {
  if (!mdRef.value) return;
  if (props.streaming) {
    for (const entry of codePreviews.value) entry.container.classList.remove('markdown-preview-active');
    codePreviews.value = [];
    previewedCode.clear();
    return;
  }
  const previous = codePreviews.value;
  const next: CodePreview[] = [];
  let sourceIndex = 0;
  for (const container of mdRef.value.querySelectorAll<HTMLElement>('.code-block-container')) {
    if (container.closest('.markdown-code-preview')) continue;
    const header = container.querySelector<HTMLElement>('.code-block-header');
    const title = header?.querySelector('.code-header-title')?.textContent;
    const caption = header?.querySelector('.code-header-caption')?.textContent;
    if (!header || !isMarkdownCodeHeader(title, caption)) continue;
    const index = sourceIndex++;
    const code = previewSources.value[index];
    if (code == null) continue;
    const old = previous.find(entry => entry.container === container);
    const entry = old?.code === code && old.header === header && old.sourceIndex === index ? old : { id: old?.id ?? nextPreviewId++, container, header, code, sourceIndex: index, plan: markdownRenderPlan(code) };
    if (pendingPreviews.delete(index)) previewedCode.add(entry.sourceIndex);
    container.classList.toggle('markdown-preview-active', previewedCode.has(entry.sourceIndex));
    next.push(entry);
  }
  if (next.length !== previous.length || next.some((entry, index) => entry !== previous[index])) {
    for (const entry of previous) {
      if (!next.some(current => current.container === entry.container)) entry.container.classList.remove('markdown-preview-active');
    }
    codePreviews.value = next;
    for (const index of previewedCode) if (index >= previewSources.value.length) previewedCode.delete(index);
  }
}

function setCodePreview(entry: CodePreview, value: string): void {
  if (value === 'preview') previewedCode.add(entry.sourceIndex);
  else previewedCode.delete(entry.sourceIndex);
  entry.container.classList.toggle('markdown-preview-active', value === 'preview');
}

function processInlinePunctuation(): void {
  for (const node of mdRef.value?.querySelectorAll<HTMLElement>('.text-node') ?? []) {
    if (node.closest('pre, code, svg, .md-frontmatter')) continue;
    node.classList.toggle('md-punctuation-run', /^[ \t]*[、。，；：！？（）「」『』【】《》〈〉〔〕［］｛｝]+[ \t]*$/u.test(node.textContent ?? ''));
  }
}

function processOrderedListMarkers(): void {
  for (const list of mdRef.value?.querySelectorAll<HTMLOListElement>('ol') ?? []) {
    const items = Array.from(list.children).filter((child): child is HTMLLIElement => child instanceof HTMLLIElement);
    const start = list.reversed && !list.hasAttribute('start') ? items.length : list.start;
    const width = listMarkerWidth(start, items.map(item => item.hasAttribute('value') ? item.value : null), list.reversed);
    if (list.style.getPropertyValue('--md-list-marker-width') !== width) list.style.setProperty('--md-list-marker-width', width);
  }
}

function positionAllTableActions(): void {
  if (!mdRef.value || props.streaming) return;
  for (const wrapper of mdRef.value.querySelectorAll<HTMLElement>('.table-node-wrapper')) {
    positionTableActions(wrapper);
  }
}

let disposed = false;
let fileLinkProcessingPending = false;

function scheduleFileLinkProcessing(): void {
  if (disposed || fileLinkProcessingPending) return;
  fileLinkProcessingPending = true;
  void nextTick().then(() => {
    fileLinkProcessingPending = false;
    if (disposed) return;
    hideCodeTooltipIfAnchorGone();
    syncLinkTooltipWithAnchor();
    processCodePreviews();
    if (!props.streaming) {
      processInlinePunctuation();
      processOrderedListMarkers();
    }
    processFileLinks();
    processMarkdownLinks();
    processTableWideToggles();
    processTableSelections();
    processCodeCopyTooltips();
    processCodeBlockToggles();
    codeScrollbars?.sync();
    restoreWindowState();
  });
}

watch(() => props.text, scheduleFileLinkProcessing);
watch(() => props.streaming, scheduleFileLinkProcessing);
watch(() => props.resolveFilePath, refreshFileLinkResolutions);
watch(
  () => [
    t('conversation.wrapCode'),
    t('conversation.unwrapCode'),
    t('conversation.showLineNumbers'),
    t('conversation.hideLineNumbers'),
    t('filePreview.copyCode'),
    t('conversation.widenTable'),
    t('conversation.restoreTableWidth'),
    t('conversation.copyTable'),
    t('conversation.selectTableColumn'),
  ],
  () => {
    processCodeCopyTooltips();
    processCodeBlockToggles();
    processTableWideToggles();
    processTableSelections();
  },
);

function onTableToggle(event: Event): void {
  if (event.target instanceof HTMLElement) pinScroll?.(event.target, tableWidthTransitionMs());
}

let codeScrollbars: ReturnType<typeof createCodeScrollbars> | null = null;
let observer: MutationObserver | null = null;
let tableWideResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  ensureCodeTooltip();
  ensureLinkTooltip({
    openExternalLabel: () => t('conversation.openLinkExternally'),
    openInSidebarLabel: () => t('conversation.openLinkInSidebar'),
    resolveOpenInSidebar: openSidebarBrowserUrl,
  });
  scheduleFileLinkProcessing();
  if (mdRef.value) {
    codeScrollbars = createCodeScrollbars(mdRef.value);
    observer = new MutationObserver(scheduleFileLinkProcessing);
    observer.observe(mdRef.value, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-markstream-enhancement-state'] });
    tableWideResizeObserver = new ResizeObserver(() => {
      syncLinkTooltipWithAnchor();
      positionAllTableActions();
      restoreWindowState();
    });
    tableWideResizeObserver.observe(mdRef.value);
    mdRef.value.addEventListener('click', onLocalFileLinkClick);
    mdRef.value.addEventListener('auxclick', onLocalFileLinkClick);
    mdRef.value.addEventListener(TABLE_TOGGLE_EVENT, onTableToggle);
    mdRef.value.addEventListener('click', onStreamingLinkClick);
    mdRef.value.addEventListener('auxclick', onStreamingLinkClick);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  fileLinkProcessingPending = false;
  if (historyState) {
    saveWindowState();
    historyState.set(historyKey, { text: props.text, code: savedCode, tables: savedTables, details: savedDetails, scroll: savedScroll, wraps: [...wrappedDiffs], numbers: [...numberedDiffs], previews: [...new Set([...pendingPreviews, ...codePreviews.value.filter(entry => previewedCode.has(entry.sourceIndex)).map(entry => entry.sourceIndex)])] });
  }
  codeScrollbars?.destroy();
  codeScrollbars = null;
  if (mdRef.value) {
    destroyTableWideToggles(mdRef.value);
    destroyTableSelections(mdRef.value);
  }
  observer?.disconnect();
  tableWideResizeObserver?.disconnect();
  mdRef.value?.removeEventListener('click', onLocalFileLinkClick);
  mdRef.value?.removeEventListener('auxclick', onLocalFileLinkClick);
  mdRef.value?.removeEventListener(TABLE_TOGGLE_EVENT, onTableToggle);
  mdRef.value?.removeEventListener('click', onStreamingLinkClick);
  mdRef.value?.removeEventListener('auxclick', onStreamingLinkClick);
  hideCodeTooltipIfAnchorWithin(mdRef.value);
  hideLinkTooltipIfAnchorWithin(mdRef.value);
});

const CODE_LIGHT_THEME = MARKDOWN_CODE_THEME;
const CODE_DARK_THEME = MARKDOWN_CODE_THEME_DARK;
const CODE_THEMES = [CODE_DARK_THEME, CODE_LIGHT_THEME] as const;

const codeBlockOptions = {
  disableLineNumbers: true,
  fontFamily: 'var(--markdown-code-font-family)',
  unsafeCSS: CODE_BLOCK_UNSAFE_CSS,
  overflow: 'scroll' as const,
};

const codeBlockProps = {
  showHeader: true,
  showCopyButton: true,
  showExpandButton: false,
  showPreviewButton: false,
  showCollapseButton: false,
  showFontSizeButtons: false,
  showTooltips: false,
};

const segments = computed(() => splitDiffFences(rewriteImageSrcs(markdownBody.value)));

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

const wrappedDiffs = reactive(new Set<string>(retained?.wraps));
const numberedDiffs = reactive(new Set<string>(retained?.numbers));
const diffKeys = computed(() =>
  diffWrapKeys(segments.value.map((seg) => (seg.kind === 'diff' ? seg.code : ''))),
);
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
watch([() => numberedDiffs.size, segments], async () => {
  await nextTick();
  mdRef.value
    ?.querySelectorAll<HTMLElement>('.diff-wrap .diff-pre')
    .forEach((pre) => {
      if (!pre.closest('.diff-wrap')?.classList.contains('md-code-nums')) {
        pre.style.removeProperty('--md-nums-gutter');
        return;
      }
      const rows = pre.querySelectorAll('.diff-line:not(.diff-hunk)').length;
      pre.style.setProperty('--md-nums-gutter', `${Math.max(String(rows).length + 1, 4)}ch`);
    });
});
</script>

<template>
  <div ref="mdRef" class="md">
    <Frontmatter v-if="frontmatter !== null" :source="frontmatter" />
    <template v-for="(seg, i) in segments" :key="i">
      <MarkdownRender
        custom-id="kimi-markdown"
        v-if="seg.kind === 'md'"
        :content="seg.text"
        :custom-markdown-it="configureMarkdownIt"
        mode="chat"
        :render-code-blocks-as-pre="renderPlan.renderCodeBlocksAsPre"
        :is-dark="isDark"
        :code-block-light-theme="CODE_LIGHT_THEME"
        :code-block-dark-theme="CODE_DARK_THEME"
        :themes="CODE_THEMES"
        :code-block-options="codeBlockOptions"
        :code-block-props="codeBlockProps"
        :final="final"
        :show-tooltips="false"
        :smooth-streaming="streaming"
        :batch-rendering="allowBatchRender"
        :defer-nodes-until-visible="false"
        :viewport-priority="!historyState"
        :node-virtual="false"
        @copy="copyCodeBlockFallback"
      />

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
    <template v-for="entry in codePreviews" :key="entry.id">
      <Teleport :to="entry.header">
        <SegmentedControl
          class="markdown-preview-toggle"
          :model-value="previewedCode.has(entry.sourceIndex) ? 'preview' : 'code'"
          :options="[{ value: 'code', label: t('filePreview.markdownCode') }, { value: 'preview', label: t('filePreview.preview') }]"
          @update:model-value="setCodePreview(entry, $event)"
        />
      </Teleport>
      <Teleport :to="entry.container">
        <div v-if="previewedCode.has(entry.sourceIndex)" class="markdown-code-preview">
          <MarkdownRender
            custom-id="kimi-markdown"
            :content="entry.code"
            :render-code-blocks-as-pre="entry.plan.renderCodeBlocksAsPre"
            @copy="copyCodeBlockFallback"
            :custom-markdown-it="configureMarkdownIt"
            :is-dark="isDark"
            :code-block-light-theme="CODE_LIGHT_THEME"
            :code-block-dark-theme="CODE_DARK_THEME"
            :code-block-props="codeBlockProps"
            :code-block-options="codeBlockOptions"
            :themes="CODE_THEMES"
            :node-virtual="false"
            :final="true"
            :show-tooltips="false"
          />
        </div>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.md,
.md :deep(.markdown-renderer) {
  font: var(--markdown-font-weight-regular) var(--markdown-body-font-size)/var(--markdown-body-line-height) var(--markdown-font-family);
  color: var(--markdown-text-color);
  letter-spacing: var(--markdown-letter-spacing);
  word-break: break-word;
}
.md :deep(.markstream-vue) {
  --ms-font-sans: var(--markdown-font-family);
  --ms-font-mono: var(--markdown-code-font-family);
  --ms-text-body: var(--markdown-body-font-size);
  --ms-leading-body: var(--markdown-body-line-height);
  --ms-text-label: var(--markdown-code-header-font-size);
  --ms-flow-paragraph-y: 0;
  --ms-flow-list-y: 0;
  --ms-flow-list-item-y: 0;
  --ms-flow-table-y: 0;
  --ms-flow-blockquote-y: 0;
  --ms-flow-codeblock-y: 0;
  --ms-flow-diagram-y: 0;
  --ms-flow-hr-y: 0;
  --ms-action-btn-icon: var(--markdown-code-action-icon-size);
  --ms-size-image-max-width: 100%;
  --code-bg: var(--markdown-code-background);
  --code-fg: var(--markdown-text-color);
  --code-border: var(--markdown-border-color);
  --code-header-bg: var(--markdown-code-header-background);
  --code-action-fg: var(--markdown-secondary-icon-color);
  --code-action-hover-fg: var(--markdown-text-color);
  --markstream-code-fallback-bg: var(--markdown-code-background);
  --markstream-code-fallback-fg: var(--markdown-text-color);
  --markstream-code-border-color: var(--markdown-border-color);
  --inline-code-bg: var(--markdown-inline-code-background);
  --inline-code-fg: var(--markdown-text-color);
  --inline-code-border: transparent;
  --diagram-bg: var(--markdown-code-background);
  --diagram-border: var(--markdown-border-color);
  --diagram-header-bg: var(--markdown-code-header-background);
}
.md :deep(.md-file-link) {
  appearance: none;
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-05);
  max-width: 100%;
  border: 0;
  margin-inline: 0;
  padding: 0;
  background: transparent;
  color: var(--p-pill-fg);
  font: inherit;
  white-space: nowrap;
  vertical-align: baseline;
  text-decoration: none;
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.md :deep(.md-file-link:hover) {
  color: var(--color-link-hover);
  text-decoration: underline;
}
.md :deep(.md-file-link .mention-pill-icon) {
  color: var(--p-pill-icon);
}
.md :deep(.md-file-link .mention-pill-name) {
  max-width: none;
}
.md :deep(.md-file-link:hover .mention-pill-icon) {
  color: inherit;
}
.md :deep(.md-file-link:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
  border-radius: var(--radius-xs);
}
.md :deep(pre),
.md :deep(code),
.md :deep(diffs-container) { text-autospace: no-autospace; }
.md :deep(p),
.md :deep(li) {
  font-size: inherit;
  line-height: inherit;
}
.md :deep(strong) {
  color: var(--markdown-text-color);
  font-weight: var(--markdown-font-weight-emphasis);
}
.md :deep(:is(h1, h2, h3, h4, h5, h6)) {
  color: var(--markdown-text-color);
  font-weight: var(--markdown-font-weight-emphasis);
  margin: 0;
  padding: 0;
  border: 0;
}
.md :deep(h1) { font-size: var(--markdown-h1-font-size); line-height: var(--markdown-h1-line-height); }
.md :deep(h2) { font-size: var(--markdown-h2-font-size); line-height: var(--markdown-h2-line-height); }
.md :deep(:is(h3, h4, h5, h6)) { font-size: var(--markdown-h3-font-size); line-height: var(--markdown-h3-line-height); }
.md :deep(p) { margin: 0; }
.md :deep(.text-node.md-punctuation-run) { white-space: nowrap; }
.md :deep(.markdown-renderer > .node-slot) {
  padding-top: var(--markdown-block-space-before);
  margin: 0;
}
.md :deep(.markdown-renderer > .node-slot:has(> .node-content > :is(h1, h2, h3, h4, h5, h6))) {
  padding-top: var(--markdown-heading-space-before);
}
.md :deep(.node-slot:has(> .node-content > p) + .node-slot:has(> .node-content > p)) {
  padding-top: var(--markdown-paragraph-gap);
}
.md :deep(.node-slot:has(> .node-content > hr)) {
  padding-top: var(--markdown-divider-space-before);
}
.md :deep(:is(li, blockquote, td, th) .markdown-renderer > .node-slot:first-child),
.md :deep(li .markdown-renderer > .node-slot:has(> .node-content > :is(ul, ol))) {
  padding-top: 0;
}
.md :deep(:is(ul, ol)) {
  list-style: revert;
  margin: 0;
  padding: 0 0 0 var(--markdown-list-indent);
}
.md :deep(ul) { list-style-type: disc; }
.md :deep(ol) { padding-left: max(var(--markdown-list-indent), var(--md-list-marker-width, 4ch)); }
.md :deep(ol > li::marker) { font-variant-numeric: tabular-nums; }
.md :deep(:is(ul, ol) ul) { list-style-type: circle; }
.md :deep(li) {
  list-style-type: inherit;
  margin: 0;
  padding: 0;
}
.md :deep(li::marker) { color: var(--markdown-text-color); }
.md :deep(li + li) { margin-top: var(--markdown-list-item-gap); }
.md :deep(li + li:has(> :is(ul, ol))) { margin-top: var(--markdown-list-group-gap); }
.md :deep(li > :is(ul, ol)) { margin-top: var(--markdown-list-item-gap); }
.md :deep(li:has(> .paragraph-node > .checkbox-node, > .markdown-renderer > .node-slot > .node-content > .paragraph-node > .checkbox-node)) {
  list-style: none;
  margin-left: calc(-1 * var(--markdown-list-indent));
  padding-left: calc(var(--markdown-task-size) + var(--markdown-task-label-gap));
  position: relative;
  min-height: var(--markdown-task-size);
}
.md :deep(li:has(> .paragraph-node > .checkbox-node, > .markdown-renderer > .node-slot > .node-content > .paragraph-node > .checkbox-node) + li) { margin-top: var(--markdown-task-item-gap); }
.md :deep(.paragraph-node:has(> .checkbox-node)) { position: relative; }
.md :deep(.checkbox-node) {
  position: absolute;
  top: calc((1lh - var(--markdown-task-size)) / 2);
  inset-inline-start: calc(-1 * (var(--markdown-task-size) + var(--markdown-task-label-gap)));
  width: var(--markdown-task-size);
  height: var(--markdown-task-size);
  margin: 0;
  align-items: center;
  justify-content: center;
  color: var(--markdown-task-checked-color);
}
.md :deep(:not(pre) > code),
.md :deep(.inline-code) {
  font: var(--markdown-font-weight-regular) var(--markdown-code-font-size)/var(--markdown-code-line-height) var(--markdown-code-font-family);
  font-size-adjust: var(--markdown-inline-code-font-size-adjust);
  background: var(--markdown-inline-code-background);
  color: var(--markdown-text-color);
  border: 0;
  padding: var(--markdown-inline-code-padding-block) var(--markdown-inline-code-padding-inline);
  border-radius: var(--markdown-inline-code-radius);
  box-decoration-break: clone;
}
.md :deep(:is(h1, h2, h3, h4, h5, h6) :not(pre) > code),
.md :deep(:is(h1, h2, h3, h4, h5, h6) .inline-code) {
  font-size: inherit;
}
.md :deep(:is(strong, b) code) { font-weight: var(--markdown-font-weight-emphasis); }

.md :deep(.code-block-container) {
  margin: 0;
  border: var(--markdown-code-border-width) solid var(--markdown-border-color);
  border-radius: var(--markdown-code-radius);
  background: var(--markdown-code-background);
  box-shadow: var(--markdown-code-shadow);
  overflow: hidden;
  --vscode-editor-font-size: var(--markdown-code-font-size);
  --vscode-editor-line-height: calc(var(--markdown-code-font-size) * var(--markdown-code-line-height));
}
.md :deep(.code-block-header),
.md :deep(.mermaid-block-header),
.diff-bar {
  -webkit-user-select: none;
  user-select: none;
}

.md :deep(.code-block-header) {
  background: var(--markdown-code-header-background);
  border-bottom: 0;
  padding: var(--markdown-code-header-padding-block) var(--markdown-code-header-padding-end) var(--markdown-code-header-padding-block) var(--markdown-code-header-padding-start);
  min-height: var(--markdown-code-header-min-height);
  backdrop-filter: blur(var(--markdown-code-backdrop-blur));
  border-radius: 0;
  color: var(--markdown-secondary-icon-color);
  font: var(--markdown-font-weight-regular) var(--markdown-code-header-font-size)/var(--markdown-code-header-line-height) var(--markdown-font-family);
  --ms-gap-header-main: var(--markdown-code-action-gap);
  --ms-gap-header-actions: var(--markdown-code-action-gap);
}
.md :deep(.code-block-header *) {
  color: var(--markdown-secondary-icon-color);
  font: var(--markdown-font-weight-regular) var(--markdown-code-header-font-size)/var(--markdown-code-header-line-height) var(--markdown-font-family);
}
.md :deep(.code-block-header .code-header-main) {
  font-family: var(--markdown-font-family);
}
.md :deep(.code-block-header .code-header-title) {
  font-size: var(--markdown-code-font-size);
  font-weight: var(--markdown-font-weight-regular);
}
.md :deep(.code-block-header .code-action-btn) {
  color: var(--markdown-secondary-icon-color);
  background: transparent;
  border: none;
  border-radius: var(--markdown-code-action-radius);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.md :deep(.code-block-header .code-action-btn:hover) {
  background: var(--markdown-code-action-hover-background);
  color: var(--markdown-text-color);
}
.md :deep(.code-block-header .code-action-btn:hover *) {
  color: var(--markdown-text-color);
}
.md :deep(.code-block-header .code-action-btn:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md :deep(.code-block-header .code-action-btn *) {
  pointer-events: none;
}
.md :deep(.code-block-header .md-code-wrap-toggle[aria-pressed='true']),
.md :deep(.code-block-header .md-code-nums-toggle[aria-pressed='true']) {
  background: var(--markdown-code-toggle-background);
  color: var(--markdown-text-color);
}
.md :deep(.code-block-header .md-code-wrap-toggle[aria-pressed='true'] *),
.md :deep(.code-block-header .md-code-nums-toggle[aria-pressed='true'] *) {
  background: transparent;
  color: var(--markdown-text-color);
}
.md :deep(.code-block-header .md-code-wrap-toggle[aria-pressed='true']:hover),
.md :deep(.code-block-header .md-code-nums-toggle[aria-pressed='true']:hover) {
  background: var(--markdown-code-toggle-background);
}
.md :deep(.code-block-container.md-code-wrap pre) {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  overflow-x: hidden !important;
}
.md :deep(.code-block-container ::selection),
.md :deep(.diff-wrap ::selection) {
  background: var(--color-code-selection);
  color: var(--color-code-selection-text);
}
.md :deep(.code-block-shell-content),
.md :deep(pre[data-markstream-pre]) {
  max-height: var(--markdown-code-max-height);
  overflow: auto;
  background: var(--markdown-code-background);
}
.md :deep(.code-editor-container) {
  height: auto !important;
  min-height: 0 !important;
  max-height: var(--markdown-code-max-height) !important;
  overflow: hidden !important;
  line-height: var(--markdown-code-line-height);
  --diffs-gap-block: 0;
  --diffs-font-size: var(--markdown-code-font-size);
  --diffs-font-family: var(--markdown-code-font-family);
}
.md :deep(.code-editor-container diffs-container) {
  --diffs-line-height: var(--markdown-code-line-height);
}
.md :deep(.code-pre-fallback > .markstream-pre__line-numbers) {
  display: none;
}
.md :deep(.code-block-container .code-pre-fallback) {
  min-height: 0 !important;
  margin: 0;
  padding-top: 0 !important;
  padding-inline: var(--markdown-code-padding-inline) !important;
  padding-bottom: var(--markdown-code-padding-bottom) !important;
  font-family: var(--markdown-code-font-family) !important;
  font-size: var(--markdown-code-font-size) !important;
  line-height: var(--markdown-code-line-height) !important;
  scrollbar-width: none;
}
.md :deep(.code-block-container .code-pre-fallback::-webkit-scrollbar) {
  display: none;
}
.md :deep(.code-block-container pre:not(.code-pre-fallback):not(.markstream-pre--line-numbers)),
.md :deep(pre[data-markstream-pre]:not(.code-pre-fallback):not(.markstream-pre--line-numbers)) {
  margin: 0;
  padding: 0 var(--markdown-code-padding-inline) var(--markdown-code-padding-bottom);
  overflow-x: auto;
  font: var(--markdown-code-font-size)/var(--markdown-code-line-height) var(--markdown-code-font-family);
}
.md :deep(.code-block-container pre code) {
  font: inherit;
  color: var(--markdown-text-color);
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
}
.md :deep(pre[data-markstream-pre]),
.md :deep(.code-pre-fallback),
.md :deep(.code-block-shell-content pre:not(.shiki)),
.md :deep(.code-block-shell-content pre:not(.shiki) code) {
  color: var(--markdown-text-color);
}

.md :deep(a) {
  color: var(--markdown-link-color);
  text-decoration: underline;
  text-underline-offset: auto;
}
.md :deep(a:not(.mention-pill):not(:has(img))) {
  margin-inline: 0;
  padding: 0;
  text-decoration: none;
  transition: color var(--duration-fast) var(--ease-out);
}
.md :deep(a:not(.mention-pill):not(:has(img)):hover) {
  color: var(--color-link-hover);
  text-decoration: underline;
}

.md :deep(a.mention-pill) {
  text-decoration: none;
}
.md :deep(a.mention-pill:hover) {
  color: var(--color-link-hover);
}
.md :deep(a.mention-file:hover),
.md :deep(a.mention-skill:not(.mention-inert):hover) {
  text-decoration: underline;
}
.md :deep(a.mention-folder:hover) {
  text-decoration: none;
}

.md :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 0 var(--markdown-math-display-padding-bottom);
  margin: 0;
}

.md :deep(.math-inline) {
  vertical-align: baseline;
}

.md :deep(blockquote) {
  position: relative;
  margin: 0;
  padding: 0 0 0 var(--markdown-quote-gutter);
  font-size: var(--markdown-quote-font-size);
  line-height: var(--markdown-quote-line-height);
  border-left: none;
  color: var(--markdown-text-color);
}
.md :deep(blockquote)::before {
  content: '';
  position: absolute;
  left: calc((var(--markdown-quote-gutter) - var(--markdown-quote-rule-width)) / 2);
  top: var(--markdown-quote-rule-inset);
  bottom: var(--markdown-quote-rule-inset);
  width: var(--markdown-quote-rule-width);
  border-radius: var(--markdown-quote-rule-radius);
  background: var(--markdown-quote-rule-color);
}
.md :deep(.blockquote > .paragraph-node) {
  margin: 0;
}
.md :deep(.blockquote > .paragraph-node + .paragraph-node) {
  margin-top: var(--markdown-paragraph-gap);
}

.md :deep(hr) {
  border: none;
  border-top: var(--markdown-divider-width) solid var(--markdown-border-color);
  margin: 0;
}

.md :deep(.table-node-wrapper) {
  width: 100%;
  max-width: 100% !important;
  min-width: 0;
  overflow-x: auto !important;
  scrollbar-gutter: auto !important;
  position: relative;
  left: 50%;
  transform: translateX(-50%);
  border: var(--markdown-table-border-width) solid var(--markdown-border-color);
  border-radius: var(--markdown-table-radius);
  --table-cell-cap: var(--p-table-cell-max);
}
@supports (interpolate-size: allow-keywords) {
  .md :deep(.table-node-wrapper) {
    interpolate-size: allow-keywords;
    transition:
      width var(--duration-base) var(--ease-out),
      min-width var(--duration-base) var(--ease-out),
      max-width var(--duration-base) var(--ease-out),
      margin-left var(--duration-base) var(--ease-out);
  }
  @media (prefers-reduced-motion: reduce) {
    .md :deep(.table-node-wrapper) { transition: none; }
  }
}
.md :deep(.md-table-scroll-host) { position: relative; min-width: 0; }
.md :deep(.md-table-scroll-host > .md-code-scrollbar) {
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--markdown-code-scrollbar-transition-duration) var(--ease-out);
}
.md :deep(.md-table-scroll-host:is(:hover, :focus-within) > .md-code-scrollbar),
.md :deep(.md-table-scroll-host.md-table-scrolling > .md-code-scrollbar) {
  opacity: 1;
  pointer-events: auto;
}
@media (prefers-reduced-motion: reduce) {
  .md :deep(.md-table-scroll-host > .md-code-scrollbar) { transition: none; }
}

.md :deep(table) {
  border-collapse: separate;
  border-spacing: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  font-size: var(--markdown-table-font-size);
  line-height: var(--markdown-table-line-height);
  margin: 0;
  width: max-content !important;
  min-width: 100%;
  max-width: none !important;
  table-layout: auto !important;
}
.md :deep(table :is(th, td)) {
  border: 0;
  border-bottom: var(--markdown-table-row-border-width) solid var(--markdown-border-color);
  padding: var(--markdown-table-cell-padding-block) var(--markdown-table-cell-padding-end) var(--markdown-table-cell-padding-block) var(--markdown-table-cell-padding-start);
  text-align: left;
  vertical-align: top;
  max-width: var(--table-cell-cap);
  background: transparent;
}
.md :deep(table :is(th, td):first-child) { padding-left: var(--markdown-table-radius); }
.md :deep(table :is(th, td):not(:first-child)) { border-left: var(--markdown-table-column-border-width) solid var(--markdown-border-color); }
.md :deep(table :is(th, td):nth-child(2)) { border-left-width: var(--markdown-table-header-column-border-width); }
.md :deep(table:has(> colgroup) :is(th, td)) { overflow-wrap: anywhere; }
.md :deep(table thead th) {
  border-bottom-width: var(--markdown-table-header-border-width);
  font-weight: var(--markdown-font-weight-emphasis);
  background: transparent;
}
.md :deep(table tbody tr:last-child td) { border-bottom: 0; }
.md :deep(table tbody tr:nth-child(n)) { background: transparent; }
.md :deep(.table-node .text-node) { display: inline; }
.md :deep(table .markdown-renderer) {
  font-size: inherit;
  line-height: inherit;
}

.md :deep(.table-node-wrapper.md-table-scroll-overflow > table) {
  mask-image: linear-gradient(
    to right,
    transparent var(--md-table-visible-start),
    black calc(var(--md-table-visible-start) + var(--md-table-fade-start)),
    black calc(var(--md-table-visible-end) - var(--md-table-fade-end)),
    transparent var(--md-table-visible-end)
  );
}
.md :deep(.md-table-actions) {
  position: absolute;
  z-index: var(--markdown-z-controls);
  display: flex;
  flex-direction: column;
  gap: var(--markdown-code-action-gap);
}
.md :deep(.md-table-toggle),
.md :deep(.md-table-copy) {
  display: none;
  align-items: center;
  justify-content: center;
  width: var(--markdown-code-action-size);
  height: var(--markdown-code-action-size);
  color: var(--markdown-secondary-icon-color);
  background: var(--markdown-code-header-background);
  border: 1px solid var(--markdown-border-color);
  border-radius: var(--markdown-code-action-radius);
  box-shadow: none;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
@container (min-width: 760px) {
  .md :deep(.table-node-wrapper:has(+ .md-table-actions)) {
    min-height: var(--markdown-code-action-size);
  }
  .md :deep(.table-node-wrapper:has(+ .md-table-actions > .md-table-copy)) {
    min-height: calc(2 * var(--markdown-code-action-size) + var(--markdown-code-action-gap));
  }
  .md :deep(.md-table-toggle),
  .md :deep(.md-table-copy) {
    display: inline-flex;
  }
}
.md :deep(.table-node-wrapper:is(:hover, :focus-within) + .md-table-actions) :is(.md-table-toggle, .md-table-copy),
.md :deep(.md-table-actions:is(:hover, :focus-within)) :is(.md-table-toggle, .md-table-copy),
.md :deep(.table-node-wrapper.md-table-wide + .md-table-actions) .md-table-toggle {
  opacity: 1;
}
@media (hover: none) {
  .md :deep(.md-table-toggle),
  .md :deep(.md-table-copy) { opacity: 1; }
}
.md :deep(.md-table-toggle:hover),
.md :deep(.md-table-copy:hover) {
  background: var(--markdown-code-background);
  color: var(--markdown-text-color);
}
.md :deep(.md-table-toggle:focus-visible),
.md :deep(.md-table-copy:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md :deep(.md-table-toggle) svg,
.md :deep(.md-table-copy) svg {
  display: block;
}

.md :deep(.table-node) tbody tr:hover {
  background-color: transparent !important;
}

.md :deep(.table-node-wrapper:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md :deep(.table-node-wrapper.md-table-selecting),
.md :deep(.table-node-wrapper.md-table-selecting *) {
  cursor: cell !important;
  user-select: none !important;
}
.md :deep(table [data-md-table-cell]) { cursor: text; }
.md :deep(table thead [data-md-table-cell]) { cursor: pointer; }
.md :deep(table [data-md-table-cell].md-table-cell-selected) {
  background: var(--markdown-table-selection-background);
}
.md :deep(.table-node-wrapper.md-table-has-selection + .md-table-actions) :is(.md-table-toggle, .md-table-copy) {
  opacity: 1;
}

.diff-wrap {
  margin-top: var(--markdown-block-space-before);
  border: var(--markdown-code-border-width) solid var(--markdown-border-color);
  border-radius: var(--markdown-code-radius);
  background: var(--markdown-code-background);
  box-shadow: var(--markdown-code-shadow);
  overflow: hidden;
}
.diff-bar {
  display: flex;
  align-items: center;
  gap: var(--markdown-code-action-gap);
  min-height: var(--markdown-code-header-min-height);
  padding: var(--markdown-code-header-padding-block) var(--markdown-code-header-padding-end) var(--markdown-code-header-padding-block) var(--markdown-code-header-padding-start);
  background: var(--markdown-code-header-background);
  color: var(--markdown-text-color);
  font: var(--markdown-code-header-font-size)/var(--markdown-code-header-line-height) var(--markdown-font-family);
}
.diff-lang {
  margin-right: auto;
}
.diff-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--markdown-secondary-icon-color);
  background: transparent;
  border: none;
  border-radius: var(--markdown-code-action-radius);
  cursor: pointer;
  padding: 2px 6px;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.diff-copy:hover {
  background: var(--markdown-code-background);
  color: var(--markdown-text-color);
}
.diff-copy:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.diff-bar :deep(.ui-icon-button[aria-pressed='true']) {
  background: var(--markdown-code-toggle-background);
  color: var(--markdown-text-color);
}
.diff-bar :deep(.ui-icon-button[aria-pressed='true']:hover) {
  background: var(--markdown-code-toggle-background);
}
.diff-bar :deep(.ui-icon-button svg) {
  width: var(--markdown-code-action-icon-size);
  height: var(--markdown-code-action-icon-size);
}
.diff-wrap.md-code-wrap .diff-pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-wrap.md-code-wrap .diff-pre code {
  width: auto;
}
.diff-wrap.md-code-wrap:not(.md-code-nums) .diff-line {
  padding-left: calc(var(--markdown-code-padding-inline) + var(--diff-sign-col));
}
.diff-wrap.md-code-wrap:not(.md-code-nums) .diff-sign {
  margin-left: calc(-1 * var(--diff-sign-col));
}
.diff-wrap.md-code-nums .diff-pre {
  counter-reset: md-diff-line;
  position: relative;
  isolation: isolate;
}
.diff-wrap.md-code-nums .diff-line {
  padding-left: calc(var(--markdown-code-padding-inline) + var(--md-nums-gutter, 4ch) + var(--diff-sign-col));
}
.diff-wrap.md-code-nums .diff-line:not(.diff-hunk) {
  counter-increment: md-diff-line;
}
.diff-wrap.md-code-nums .diff-line:not(.diff-hunk)::before {
  content: counter(md-diff-line);
  display: inline-block;
  position: sticky;
  left: 0;
  box-sizing: content-box;
  padding-left: var(--markdown-code-padding-inline);
  padding-right: 1ch;
  background: var(--markdown-code-gutter-background);
  z-index: var(--markdown-z-controls);
  width: calc(var(--md-nums-gutter, 4ch) - 1ch);
  overflow: visible;
  margin-left: calc(-1 * (var(--md-nums-gutter, 4ch) + var(--diff-sign-col) + var(--markdown-code-padding-inline)));
  margin-right: 0;
  text-align: right;
  color: var(--markdown-secondary-icon-color);
  user-select: none;
}
.diff-pre {
  max-height: var(--markdown-code-max-height);
  overflow-y: auto;
  margin: 0;
  padding: 0 0 var(--markdown-code-padding-bottom);
  overflow-x: auto;
  background: var(--markdown-code-background);
}
.diff-pre code {
  display: block;
  width: max-content;
  min-width: 100%;
  font: var(--markdown-code-font-size)/var(--markdown-code-line-height) var(--markdown-code-font-family);
  color: var(--markdown-text-color);
}
.diff-line {
  display: block;
  width: 100%;
  padding: 0 var(--markdown-code-padding-inline);
}
.diff-sign {
  display: inline-block;
  width: var(--diff-sign-col);
  text-align: center;
  color: var(--markdown-secondary-icon-color);
  user-select: none;
}
.diff-text {
  color: var(--markdown-text-color);
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
  background: var(--markdown-code-header-background);
}
.diff-hunk .diff-text {
  color: var(--markdown-secondary-icon-color);
}

.md :deep(.code-block-header .code-header-title) { color: var(--markdown-text-color); }
.md :deep(.code-block-header .code-action-btn),
.md :deep(.mermaid-action-btn),
.diff-bar :deep(.ui-icon-button),
.diff-copy {
  width: var(--markdown-code-action-size);
  height: var(--markdown-code-action-size);
  padding: 0;
  flex: none;
}
.md :deep(.code-block-header .code-action-btn svg),
.md :deep(.mermaid-action-btn svg) {
  width: var(--markdown-code-action-icon-size);
  height: var(--markdown-code-action-icon-size);
}
.md :deep(.checkbox-node svg) {
  width: var(--markdown-task-size);
  height: var(--markdown-task-size);
}
.md :deep(.checkbox-node rect) { rx: 50%; }
.md :deep(.checkbox-checked rect) { x: 2px; y: 2px; width: 20px; height: 20px; }
.md :deep(.checkbox-unchecked rect) { stroke-width: 1.2px; }
.md :deep(.checkbox-checked) { color: var(--markdown-task-checked-color); }
.md :deep(.checkbox-unchecked) { color: var(--markdown-task-unchecked-color); }
.md :deep(.checkbox-checked path) { stroke: var(--markdown-task-check-color); }
.md :deep(.mermaid-block-container) {
  margin: 0;
  border: var(--markdown-code-border-width) solid var(--markdown-border-color);
  border-radius: var(--markdown-code-radius);
  background: var(--markdown-code-background);
  overflow: hidden;
}
.md :deep(.mermaid-block-header) {
  gap: var(--markdown-code-action-gap);
  border: 0;
  min-height: var(--markdown-code-header-min-height);
  padding: var(--markdown-code-header-padding-block) var(--markdown-code-header-padding-end) var(--markdown-code-header-padding-block) var(--markdown-code-header-padding-start);
  backdrop-filter: blur(var(--markdown-code-backdrop-blur));
  font: var(--markdown-font-weight-regular) var(--markdown-code-header-font-size)/var(--markdown-code-header-line-height) var(--markdown-font-family);
}
.md :deep(.mermaid-action-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}
.md :deep(.mermaid-action-btn:not(:has(svg))) {
  width: auto;
  min-width: var(--markdown-code-action-size);
  padding-inline: 0.5rem;
}
.md :deep(.mermaid-action-btn svg) { flex: none; }
.md :deep(:is(.code-block-container, .mermaid-block-container)) { isolation: isolate; }
.md :deep(:is(.code-block-header, .mermaid-block-header)) {
  border-start-start-radius: calc(var(--markdown-code-radius) - var(--markdown-code-border-width));
  border-start-end-radius: calc(var(--markdown-code-radius) - var(--markdown-code-border-width));
}
.md :deep(.mermaid-label-text) { color: var(--markdown-text-color); }
.md :deep(.mermaid-mode-toggle-group) {
  background: var(--markdown-code-toggle-background);
  border-radius: var(--markdown-code-toggle-radius);
  padding: var(--markdown-code-toggle-padding);
}
.md :deep(.mermaid-mode-btn) {
  padding: var(--markdown-code-toggle-item-padding-block) var(--markdown-code-toggle-item-padding-inline);
  border-radius: var(--markdown-code-toggle-item-inactive-radius);
  font: inherit;
  color: var(--markdown-text-color);
  opacity: 1;
}
.md :deep(.mermaid-header-actions > .mermaid-action-btn) { opacity: 0; }
.md :deep(.mermaid-block-container:is(:hover, :focus-within) .mermaid-action-btn) { opacity: 1; }
.md :deep(.mermaid-source-code) {
  font: var(--markdown-code-font-size)/var(--markdown-code-line-height) var(--markdown-code-font-family);
  color: var(--markdown-text-color);
}
.md :deep(.mermaid-preview-area) { padding: 0 var(--markdown-code-padding-inline) var(--markdown-code-padding-bottom); }
.md :deep(.image-error) { user-select: none; }
.md :deep(.image-node-container) {
  overflow: hidden;
  border-radius: var(--markdown-image-radius);
  border: var(--markdown-image-border-width) solid var(--markdown-border-color);
  max-width: 100%;
  background: var(--markdown-image-background);
}
.md :deep(.image-node__img) {
  display: block;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  height: auto;
}
.md :deep(.image-node-container.md-image-sized .image-node__img) {
  width: var(--md-image-width);
  aspect-ratio: var(--md-image-ratio);
}
.md :deep(.image-node-container.md-image-pending .image-node__img) {
  width: var(--markdown-image-placeholder-width);
  height: var(--markdown-image-placeholder-height);
  opacity: 0;
}
.md :deep(.image-node-container[data-caption]::after) {
  content: attr(data-caption);
  position: absolute;
  inset: auto 0 0;
  padding: var(--markdown-image-caption-padding-block) var(--markdown-image-caption-padding-inline);
  color: var(--markdown-image-caption-color);
  background: var(--markdown-image-caption-background);
  font: var(--markdown-image-caption-font-size)/var(--markdown-image-caption-line-height) var(--markdown-font-family);
  text-shadow: var(--markdown-image-caption-shadow);
  pointer-events: none;
}
@media (hover: none) {
  .md :deep(.mermaid-header-actions > .mermaid-action-btn) { opacity: 1; }
}

.md :deep(.markdown-preview-active > :not(.code-block-header, .markdown-code-preview)) { display: none; }
.md :deep(.markdown-preview-active > .code-block-header :is(.md-code-nums-toggle, .md-code-wrap-toggle)) { display: none; }
.markdown-code-preview { padding: 0 var(--markdown-code-padding-inline) var(--markdown-code-padding-bottom); }
.markdown-preview-toggle.ui-seg {
  border: 0;
  flex: none;
  padding: var(--markdown-code-toggle-padding);
  border-radius: var(--markdown-code-toggle-radius);
  background: var(--markdown-code-toggle-background);
}
.markdown-preview-toggle :deep(.ui-seg__item) {
  border-radius: var(--markdown-code-toggle-item-inactive-radius);
  padding: var(--markdown-code-toggle-item-padding-block) var(--markdown-code-toggle-item-padding-inline);
  min-width: var(--markdown-code-toggle-item-min-width);
  height: auto;
  color: var(--markdown-text-color);
  font: var(--markdown-font-weight-regular) var(--markdown-code-header-font-size)/var(--markdown-code-header-line-height) var(--markdown-font-family);
}
.markdown-preview-toggle :deep(.ui-seg__indicator) { display: none; }
.markdown-preview-toggle :deep(.ui-seg__item.is-on),
.md :deep(.mermaid-mode-btn.is-active) {
  background: var(--markdown-code-toggle-selected-background);
  border-radius: var(--markdown-code-toggle-preview-radius);
  box-shadow: none;
}
.markdown-preview-toggle :deep(.ui-seg__item:focus-visible) { box-shadow: var(--p-focus-ring); }
.md :deep(.code-block-container:has(.markdown-preview-toggle) .code-action-btn) { opacity: 0; }
.md :deep(.code-block-container:is(:hover, :focus-within) .code-action-btn) { opacity: 1; }
.md :deep(.mermaid-block-header > :first-child) { margin-right: auto; }
.md :deep(.mermaid-mode-btn svg) { display: none; }
.md :deep(.mermaid-label-text) { font: inherit; }
.md :deep(.mermaid-mode-toggle-group) { order: 2; }
.md :deep(.mermaid-mode-btn:first-child) { order: 1; }
@media (hover: none) {
  .md :deep(.code-block-container:has(.markdown-preview-toggle) .code-action-btn) { opacity: 1; }
}

.md :deep(.code-block-shell-content:has(.code-editor-container)) { padding: 0; }
.md :deep(:is(.code-block-container, .diff-wrap)) { position: relative; }
.md :deep(.katex-display > .katex) { text-align: left; }
.md :deep(.node-content > pre[data-markstream-pre]) {
  margin: 0;
  max-height: var(--markdown-code-max-height);
  overflow: auto;
  border: var(--markdown-code-border-width) solid var(--markdown-border-color);
  border-radius: var(--markdown-code-radius);
  padding: var(--markdown-code-padding-inline);
}

.md :deep(.mermaid-preview-area svg rect.actor) {
  fill: var(--markdown-diagram-actor-background) !important;
  stroke: var(--markdown-diagram-actor-border-color) !important;
}
.md :deep(.mermaid-preview-area svg text.actor),
.md :deep(.mermaid-preview-area svg text.actor tspan) { fill: var(--markdown-diagram-actor-text-color) !important; }

.md :deep(li > .markdown-renderer:has(> .node-slot > .node-content > .paragraph-node > .checkbox-node)) { contain: layout style; }

</style>
