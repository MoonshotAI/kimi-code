
import { iconSvg } from '../shared/icons';
import { pastedTextCharCount, pastedTextLineCount, pastedTextPillLabel } from '../model/wireCodec';
import { browserReferenceTooltip } from '../features/browser-reference/tooltip';
import { attachmentIconSvg, attachmentKindIconSvg } from '../features/attachment/pill';
import { truncateMentionName } from '../features/mention/pill';
import { dismissComposerNodeSelection, updateComposerPastedText, watchAttachmentEntries, watchComposerSelections } from '../runtime/editorRegistry';
import { copyTextToClipboard, ensurePointerTracking, isSyntheticPointerMove, lastPointerPosition } from '@moonshot-ai/app-core/lib';
import { getAttachmentTooltipResolver, type AttachmentTooltipInfo } from '../features/attachment/tooltipResolver';
import {
  consumeSelectedMediaEscape,
  formatAttachmentSize,
  isPointInTooltipHoverRegion,
  mediaProgressRingDash,
  pillAttachment,
  pillMention,
  tooltipPillIdentity,
} from './mentionTooltipUtils';

export {
  consumeSelectedMediaEscape,
  isBubbleInternalScroll,
  isPointInTooltipHoverRegion,
  isSameTooltipPill,
  mediaProgressRingDash,
  pillAttachment,
  type TooltipHoverRect,
} from './mentionTooltipUtils';
export {
  setAttachmentTooltipResolver,
  type AttachmentTooltipInfo,
  type AttachmentTooltipResolver,
} from '../features/attachment/tooltipResolver';

export interface MentionTooltipSkillInfo {
  name: string;
  description: string;
  path?: string;
}

export interface AttachmentOpenTarget {
  url: string;
  fileId?: string;
  name: string;
  mediaType?: string;
  kind?: string;
  sessionId?: string;
}

export interface MentionTooltipHost {
  resolveSkill?: (name: string, path?: string) => MentionTooltipSkillInfo | null | undefined;
  openPath?: (target: { path: string }) => void;
  openAttachment?: (target: AttachmentOpenTarget) => void;
  openSkillLabel?: () => string;
  copyPathLabel?: () => string;
  attachmentErrorLabel?: (error: string) => string | undefined;
  resolveAttachmentPreviewUrl?: (target: { fileId: string; sessionId?: string; kind: 'image' | 'video' }) => Promise<string | null>;
  mediaFullscreenLabel?: () => string;
  mediaPreviewStateLabel?: (state: 'loading' | 'uploading' | 'unavailable') => string;
  mediaUploadStateLabel?: (kind: 'uploading' | 'uploaded' | 'failed') => string;
  copyQuoteLabel?: () => string;
  viewPastedTextLabel?: () => string;
  openPastedText?: (text: string, save?: (text: string) => void) => void;
  pastedTextStats?: (lineCount: number, charCount: number) => string;
  copyCommentLabel?: () => string;
  quoteBlockLabel?: () => string;
  commentBlockLabel?: () => string;
  skillsLoaded?: () => boolean;
  probePath?: (path: string, kind: 'file' | 'folder') => Promise<boolean>;
  probeScope?: () => string | null;
}

function tokenPx(name: string, fallback: number): () => number {
  let cached: number | undefined;
  return () => {
    if (cached === undefined) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const parsed = parseFloat(raw);
      cached = Number.isFinite(parsed) ? parsed : fallback;
    }
    return cached;
  };
}
const GAP = tokenPx('--space-1-5', 6);
const VIEWPORT_MARGIN = tokenPx('--p-mention-tip-vmargin', 12);
const SHOW_DELAY = tokenPx('--duration-tooltip', 150);
const HIDE_GRACE = tokenPx('--duration-fast', 120);
const HOVER_SLOP = tokenPx('--space-1', 4);
const COPY_FEEDBACK_MS = tokenPx('--duration-flash', 1000);
const PROBE_CACHE_TTL = 30_000;

function buildPathText(path: string): HTMLElement {
  const text = document.createElement('div');
  text.className = 'mention-tip-path-text';
  const parts = path.split(/([/\\])/);
  let baseIndex = parts.length - 1;
  while (baseIndex > 0 && (parts[baseIndex] === '' || parts[baseIndex] === '/' || parts[baseIndex] === '\\')) baseIndex--;
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i] ?? '';
    if (piece === '') continue;
    const span = document.createElement('span');
    if (piece === '/' || piece === '\\') {
      span.className = 'mention-tip-sep';
      span.textContent = piece;
      text.append(span, document.createElement('wbr'));
      continue;
    }
    if (i === baseIndex) span.className = 'mention-tip-base';
    span.textContent = piece;
    text.append(span);
  }
  return text;
}

function buildCopyButton(value: string, label?: string): HTMLButtonElement {
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mention-tip-copy';
  copy.setAttribute('aria-label', label ?? 'Copy path');
  const copyIcon = iconSvg('copy', 'sm');
  copy.innerHTML = copyIcon;
  copy.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      if (!(await copyTextToClipboard(value))) return;
      copy.innerHTML = iconSvg('check', 'sm');
      window.setTimeout(() => {
        copy.innerHTML = copyIcon;
      }, COPY_FEEDBACK_MS());
    })();
  });
  return copy;
}

export function buildMentionPathTooltip(path: string, opts: { copyLabel?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mention-tip-path';
  el.append(buildPathText(path));
  el.append(buildCopyButton(path, opts.copyLabel));
  return el;
}

export function buildAttachmentTooltip(info: AttachmentTooltipInfo, opts: { copyLabel?: string; errorLabel?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mention-tip-path';
  const icon = document.createElement('span');
  icon.className = 'mention-tip-att-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = attachmentIconSvg();
  el.append(icon);
  if (info.path) {
    el.append(buildPathText(info.path));
  } else {
    const text = document.createElement('div');
    text.className = 'mention-tip-path-text';
    const name = document.createElement('span');
    name.className = 'mention-tip-base';
    name.textContent = info.name;
    text.append(name);
    if (info.size !== undefined) {
      const size = document.createElement('span');
      size.className = 'mention-tip-att-size';
      size.textContent = ` · ${formatAttachmentSize(info.size)}`;
      text.append(size);
    }
    el.append(text);
  }
  el.append(buildCopyButton(info.path ?? info.name, opts.copyLabel));
  if (info.error === undefined) return el;
  const wrap = document.createElement('div');
  wrap.append(el);
  const error = document.createElement('div');
  error.className = 'mention-tip-att-error';
  error.textContent = opts.errorLabel ?? info.error;
  wrap.append(error);
  return wrap;
}

export type MediaUploadState = { kind: 'uploading'; progress?: number } | { kind: 'uploaded' } | { kind: 'failed' };

export function buildAttachmentMediaPopover(
  info: { kind: 'image' | 'video'; name: string; size?: number; error?: string; copyValue?: string },
  opts: {
    uploadState?: MediaUploadState;
    uploadStateLabel?: (kind: 'uploading' | 'uploaded' | 'failed') => string;
    copyLabel?: string;
    fullscreenLabel?: string;
    errorLabel?: string;
    stateLabel?: (state: 'loading' | 'uploading' | 'unavailable') => string | undefined;
    onCopy?: () => void;
    onFullscreen?: () => void;
  } = {},
): {
  root: HTMLElement;
  setPreview: (url: string) => void;
  setPlaceholder: (state: 'icon' | 'loading' | 'uploading' | 'unavailable') => void;
  setUploadState: (state: MediaUploadState) => void;
} {
  const root = document.createElement('div');
  root.className = 'mention-tip-media';

  const preview = document.createElement('div');
  preview.className = 'mention-tip-media-preview';
  const setPlaceholder = (state: 'icon' | 'loading' | 'uploading' | 'unavailable'): void => {
    preview.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'mention-tip-media-placeholder';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = attachmentKindIconSvg(info.kind);
    preview.append(icon);
    if (state !== 'icon') {
      const hint = document.createElement('div');
      hint.className = 'mention-tip-media-hint';
      hint.textContent = opts.stateLabel?.(state) ?? state;
      preview.append(hint);
    }
  };
  const setPreview = (url: string): void => {
    preview.replaceChildren();
    if (info.kind === 'video') {
      const video = document.createElement('video');
      video.className = 'mention-tip-media-el';
      video.src = url;
      video.muted = true;
      video.controls = true;
      video.setAttribute('controlslist', 'nofullscreen nodownload noremoteplayback');
      video.disablePictureInPicture = true;
      video.disableRemotePlayback = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.addEventListener('error', () => setPlaceholder('unavailable'), { once: true });
      preview.append(video);
      return;
    }
    const img = document.createElement('img');
    img.className = 'mention-tip-media-el';
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => setPlaceholder('unavailable'), { once: true });
    preview.append(img);
  };
  setPlaceholder('icon');
  root.append(preview);

  const meta = document.createElement('div');
  meta.className = 'mention-tip-media-meta';
  const kindIcon = document.createElement('span');
  kindIcon.className = 'mention-tip-att-icon';
  kindIcon.setAttribute('aria-hidden', 'true');
  kindIcon.innerHTML = attachmentKindIconSvg(info.kind);
  meta.append(kindIcon);
  const nameEl = document.createElement('span');
  nameEl.className = 'mention-tip-media-name';
  nameEl.textContent = truncateMentionName(info.name);
  meta.append(nameEl);
  if (info.size !== undefined) {
    const size = document.createElement('span');
    size.className = 'mention-tip-att-size';
    size.textContent = ` · ${formatAttachmentSize(info.size)}`;
    meta.append(size);
  }
  root.append(meta);

  if (info.error !== undefined) {
    const error = document.createElement('div');
    error.className = 'mention-tip-media-error';
    error.textContent = opts.errorLabel ?? info.error;
    root.append(error);
  }

  const foot = document.createElement('div');
  foot.className = 'mention-tip-media-foot';
  const stateEl = document.createElement('span');
  stateEl.className = 'mention-tip-media-state';
  foot.append(stateEl);

  const setUploadState = (state: MediaUploadState): void => {
    stateEl.replaceChildren();
    stateEl.classList.toggle('is-danger', state.kind === 'failed');
    if (state.kind === 'uploading' && state.progress !== undefined) {
      const ring = document.createElement('span');
      ring.className = 'mention-tip-media-ring';
      ring.setAttribute('aria-hidden', 'true');
      ring.innerHTML =
        `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" class="mention-tip-media-ring-track" stroke-width="2"/>` +
        `<circle cx="8" cy="8" r="6.5" fill="none" class="mention-tip-media-ring-arc" stroke-width="2" stroke-linecap="round" stroke-dasharray="${mediaProgressRingDash(state.progress)}" transform="rotate(-90 8 8)"/></svg>`;
      stateEl.append(ring);
    } else if (state.kind === 'uploading') {
      const spin = document.createElement('span');
      spin.className = 'mention-tip-media-spin';
      spin.setAttribute('aria-hidden', 'true');
      stateEl.append(spin);
    }
    const text = document.createElement('span');
    const base = opts.uploadStateLabel?.(state.kind) ?? state.kind;
    text.textContent = state.kind === 'uploading' && state.progress !== undefined ? `${base} ${Math.round(state.progress * 100)}%` : base;
    stateEl.append(text);
  };

  const actions = document.createElement('div');
  actions.className = 'mention-tip-media-actions';
  if (info.copyValue !== undefined && info.copyValue !== '') {
    const copyLabel = opts.copyLabel ?? 'Copy path';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mention-tip-media-open';
    copy.setAttribute('aria-label', copyLabel);
    const copyIcon = iconSvg('copy', 'sm');
    copy.innerHTML = `${copyIcon}<span></span>`;
    copy.lastChild!.textContent = copyLabel;
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (!(await copyTextToClipboard(info.copyValue!))) return;
        copy.innerHTML = `${iconSvg('check', 'sm')}<span></span>`;
        copy.lastChild!.textContent = copyLabel;
        window.setTimeout(() => {
          copy.innerHTML = `${copyIcon}<span></span>`;
          copy.lastChild!.textContent = copyLabel;
        }, COPY_FEEDBACK_MS());
        opts.onCopy?.();
      })();
    });
    actions.append(copy);
  }
  if (opts.onFullscreen) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mention-tip-media-open';
    open.innerHTML = `${iconSvg('fullscreen', 'sm')}<span></span>`;
    open.lastChild!.textContent = opts.fullscreenLabel ?? 'View fullscreen';
    const onFullscreen = opts.onFullscreen;
    open.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onFullscreen();
    });
    actions.append(open);
  }
  foot.append(actions);
  if (opts.uploadState !== undefined) setUploadState(opts.uploadState);
  root.append(foot);

  return { root, setPreview, setPlaceholder, setUploadState };
}

function appendCommentBlock(card: HTMLElement, comment: string | undefined, opts: { commentLabel?: string; copyCommentLabel?: string; copyLabel?: string }): void {
  if (!comment?.trim()) return;
  const block = document.createElement('div');
  block.className = 'mention-tip-quote-block';
  const head = document.createElement('div');
  head.className = 'mention-tip-quote-block-head';
  if (opts.commentLabel) {
    const label = document.createElement('div');
    label.className = 'mention-tip-quote-block-label';
    label.textContent = opts.commentLabel;
    head.append(label);
  }
  head.append(buildCopyButton(comment, opts.copyCommentLabel ?? opts.copyLabel));
  const text = document.createElement('div');
  text.className = 'mention-tip-quote-comment';
  text.textContent = comment;
  block.append(head, text);
  card.append(block);
}

export function buildQuoteTooltip(
  text: string,
  opts: { source?: string; comment?: string; copyLabel?: string; copyCommentLabel?: string; quoteLabel?: string; commentLabel?: string } = {},
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mention-tip-quote-card';
  const sourceText = opts.source ?? '';
  if (sourceText.trim() !== '') {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'mention-tip-quote-source';
    sourceEl.textContent = sourceText;
    card.append(sourceEl);
  }
  const quoteBlock = document.createElement('div');
  quoteBlock.className = 'mention-tip-quote-block';
  const quoteHead = document.createElement('div');
  quoteHead.className = 'mention-tip-quote-block-head';
  if (opts.quoteLabel !== undefined && opts.quoteLabel !== '') {
    const label = document.createElement('div');
    label.className = 'mention-tip-quote-block-label';
    label.textContent = opts.quoteLabel;
    quoteHead.append(label);
  }
  quoteHead.append(buildCopyButton(text, opts.copyLabel));
  quoteBlock.append(quoteHead);
  const quoteText = document.createElement('div');
  quoteText.className = 'mention-tip-quote-text';
  quoteText.textContent = text;
  quoteBlock.append(quoteText);
  card.append(quoteBlock);
  appendCommentBlock(card, opts.comment, opts);
  return card;
}

function buildTipAction(label: string, icon: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mention-tip-media-open';
  button.innerHTML = `${icon}<span></span>`;
  button.lastChild!.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

export function buildPastedTextTooltip(
  text: string,
  opts: { meta?: string; viewLabel?: string; onView?: () => void } = {},
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mention-tip-pasted-text';
  const name = document.createElement('div');
  name.className = 'mention-tip-name';
  name.textContent = pastedTextPillLabel(text);
  card.append(name);
  if (opts.meta !== undefined && opts.meta !== '') {
    const meta = document.createElement('div');
    meta.className = 'mention-tip-pasted-text-meta';
    meta.textContent = opts.meta;
    card.append(meta);
  }
  const actions = document.createElement('div');
  actions.className = 'mention-tip-media-actions';
  if (opts.onView !== undefined) actions.append(buildTipAction(opts.viewLabel ?? 'View text', iconSvg('text', 'sm'), opts.onView));
  if (actions.childElementCount > 0) card.append(actions);
  return card;
}

export function buildMentionSkillTooltip(
  skill: MentionTooltipSkillInfo,
  opts: { openLabel?: string; onOpen?: (path: string) => void } = {},
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mention-tip-skill';
  const head = document.createElement('div');
  head.className = 'mention-tip-head';
  const name = document.createElement('span');
  name.className = 'mention-tip-name';
  name.textContent = skill.name;
  head.append(name);
  if (skill.path && opts.onOpen) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mention-tip-open';
    open.setAttribute('aria-label', opts.openLabel ?? 'Open skill file');
    open.innerHTML = iconSvg('external-link', 'sm');
    const path = skill.path;
    const onOpen = opts.onOpen;
    open.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpen(path);
    });
    head.append(open);
  }
  card.append(head);
  if (skill.description) {
    const desc = document.createElement('div');
    desc.className = 'mention-tip-desc';
    desc.textContent = skill.description;
    card.append(desc);
  }
  return card;
}

function mediaUploadStateFor(info: AttachmentTooltipInfo | null): MediaUploadState | undefined {
  if (info === null) return undefined;
  if (info.error !== undefined) return { kind: 'failed' };
  if (info.uploading === true) return { kind: 'uploading', progress: info.uploadProgress };
  return { kind: 'uploaded' };
}

export function startMentionTooltip(host: MentionTooltipHost): () => void {
  let bubble: HTMLElement | null = null;
  let caret: HTMLElement | null = null;
  let anchor: HTMLElement | null = null;
  let anchorIdentity: string | null = null;
  let shownPath: string | null = null;
  let shownProbeKey: string | null = null;
  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  let disconnectObserver: MutationObserver | undefined;
  const bubbleResizeObserver = new ResizeObserver(() => {
    if (anchor && bubble?.classList.contains('positioned')) position(anchor);
  });
  let mediaPopoverCtl: {
    setPreview: (url: string) => void;
    setPlaceholder: (state: 'icon' | 'loading' | 'uploading' | 'unavailable') => void;
    setUploadState: (state: MediaUploadState) => void;
    mintedUrl: string | null;
  } | null = null;
  let shownMediaInfo: AttachmentTooltipInfo | null | undefined;
  let hoverPill: HTMLElement | null = null;
  let pinnedBySelection = false;
  let pinnedByClick = false;
  const probeCache = new Map<string, number>();
  const probeInflight = new Map<string, Promise<boolean>>();

  function probeCacheFresh(key: string): boolean {
    const at = probeCache.get(key);
    return at !== undefined && Date.now() - at < PROBE_CACHE_TTL;
  }

  function markMissing(target: string, missing: boolean): void {
    for (const pill of document.querySelectorAll<HTMLElement>('.mention-pill')) {
      const actionFor = pill.dataset.mentionActionPath ?? pill.dataset.mentionPath ?? '';
      if (actionFor === target) pill.classList.toggle('mention-missing', missing);
    }
  }

  function markAttachmentMissing(attId: string, missing: boolean): void {
    for (const pill of document.querySelectorAll<HTMLElement>('.ProseMirror .attachment-pill')) {
      if (pill.dataset.attachmentId === attId) pill.classList.toggle('attachment-missing', missing);
    }
  }

  function probe(path: string, kind: 'file' | 'folder', actionPath?: string, strike?: (missing: boolean) => void): void {
    if (!host.probePath || path === '') return;
    const scope = host.probeScope?.() ?? '';
    const target = actionPath ?? path;
    const applyStrike = strike ?? ((missing: boolean) => markMissing(target, missing));
    const key = `${scope}|${target}`;
    if (probeCacheFresh(key)) return;
    shownProbeKey = key;
    let flight = probeInflight.get(key);
    if (flight === undefined) {
      flight = (async (): Promise<boolean> => {
        try {
          const exists = await host.probePath?.(target, kind);
          if ((host.probeScope?.() ?? '') !== scope) return false;
          if (exists === false) {
            applyStrike(true);
          } else {
            probeCache.set(key, Date.now());
            applyStrike(false);
          }
          return true;
        } finally {
          probeInflight.delete(key);
        }
      })();
      probeInflight.set(key, flight);
    }
    void flight.then((applied) => {
      if (applied && shownProbeKey === key) bubble?.querySelector('.mention-tip-spinner')?.remove();
    });
  }

  function degradeSkillPill(pill: HTMLElement): void {
    if (host.skillsLoaded?.() !== false) {
      pill.tabIndex = -1;
      pill.removeAttribute('role');
      if (pill.hasAttribute('href')) {
        pill.dataset.mentionHref = pill.getAttribute('href') ?? '';
        pill.removeAttribute('href');
      }
    }
    pill.classList.add('mention-inert');
  }

  function contentFor(pill: HTMLElement): HTMLElement {
    if (mediaPopoverCtl?.mintedUrl != null) URL.revokeObjectURL(mediaPopoverCtl.mintedUrl);
    mediaPopoverCtl = null;
    if (pill.classList.contains('browser-reference-pill')) return browserReferenceTooltip(pill);
    if (pill.classList.contains('pasted-text-pill')) {
      const text = pill.dataset.pastedText ?? '';
      const inComposer = pill.closest('.ProseMirror') !== null;
      const openPastedText = host.openPastedText;
      return buildPastedTextTooltip(text, {
        meta: host.pastedTextStats?.(pastedTextLineCount(text), pastedTextCharCount(text)),
        viewLabel: host.viewPastedTextLabel?.(),
        ...(openPastedText === undefined ? {} : {
          onView: () => {
            hide(true);
            if (inComposer) openPastedText(text, (next) => updateComposerPastedText(pill, next));
            else openPastedText(text);
          },
        }),
      });
    }
    if (pill.classList.contains('quote-pill')) {
      return buildQuoteTooltip(pill.dataset.quoteText ?? '', {
        source: pill.dataset.quoteSource,
        comment: pill.dataset.quoteComment,
        copyLabel: host.copyQuoteLabel?.(),
        copyCommentLabel: host.copyCommentLabel?.(),
        quoteLabel: host.quoteBlockLabel?.(),
        commentLabel: host.commentBlockLabel?.(),
      });
    }
    if (pill.classList.contains('attachment-pill')) {
      const att = pillAttachment(pill);
      const inComposer = pill.closest('.ProseMirror') !== null;
      const info = inComposer ? (getAttachmentTooltipResolver()?.(att.attId) ?? null) : null;
      if (att.kind === 'image' || att.kind === 'video') {
        const kind = att.kind;
        const openUrl = info?.previewUrl ?? pill.dataset.attachmentUrl ?? '';
        const fileId = info?.fileId ?? (pill.dataset.attachmentFileId || undefined);
        const sessionId = info?.sessionId ?? (pill.dataset.attachmentSessionId || undefined);
        const canOpen = host.openAttachment !== undefined && (openUrl !== '' || fileId !== undefined);
        const uploadState = mediaUploadStateFor(info);
        shownMediaInfo = info;
        const pop = buildAttachmentMediaPopover(
          {
            kind,
            name: info?.name ?? att.name,
            size: info?.size ?? att.size,
            error: info?.error,
            copyValue: info?.path ?? att.name,
          },
          {
            uploadState,
            uploadStateLabel: host.mediaUploadStateLabel,
            copyLabel: host.copyPathLabel?.(),
            fullscreenLabel: host.mediaFullscreenLabel?.(),
            errorLabel: info?.error === undefined ? undefined : (host.attachmentErrorLabel?.(info.error) ?? info.error),
            stateLabel: host.mediaPreviewStateLabel,
            onFullscreen: canOpen
              ? () => {
                  hide(true);
                  host.openAttachment?.({
                    url: openUrl,
                    fileId,
                    name: info?.name ?? att.name,
                    mediaType: pill.dataset.attachmentMediaType || undefined,
                    kind,
                    sessionId,
                  });
                }
              : undefined,
          },
        );
        const ctl: {
          setPreview: (url: string) => void;
          setPlaceholder: (state: 'icon' | 'loading' | 'uploading' | 'unavailable') => void;
          setUploadState: (state: MediaUploadState) => void;
          mintedUrl: string | null;
        } = {
          setPreview: pop.setPreview,
          setPlaceholder: pop.setPlaceholder,
          setUploadState: pop.setUploadState,
          mintedUrl: null,
        };
        mediaPopoverCtl = ctl;
        if (info?.previewUrl !== undefined) {
          ctl.setPreview(info.previewUrl);
        } else if (info?.uploading === true) {
          ctl.setPlaceholder('uploading');
        } else if (fileId !== undefined && host.resolveAttachmentPreviewUrl) {
          ctl.setPlaceholder('loading');
          void host.resolveAttachmentPreviewUrl({ fileId, sessionId, kind }).then((url) => {
            if (mediaPopoverCtl !== ctl) {
              if (url !== null) URL.revokeObjectURL(url);
              return;
            }
            if (url === null) {
              ctl.setPlaceholder('unavailable');
              return;
            }
            ctl.mintedUrl = url;
            ctl.setPreview(url);
          });
        } else if (openUrl !== '') {
          ctl.setPreview(openUrl);
        } else {
          ctl.setPlaceholder('unavailable');
        }
        appendCommentBlock(pop.root, pill.dataset.attachmentComment, {
          commentLabel: host.commentBlockLabel?.(),
          copyCommentLabel: host.copyCommentLabel?.(),
        });
        return pop.root;
      }
      return buildAttachmentTooltip(
        { name: info?.name ?? att.name, path: info?.path, size: info?.size ?? att.size, error: info?.error },
        {
          copyLabel: host.copyPathLabel?.(),
          errorLabel: info?.error === undefined ? undefined : (host.attachmentErrorLabel?.(info.error) ?? info.error),
        },
      );
    }
    const mention = pillMention(pill);
    if (mention.kind === 'session') return buildMentionSkillTooltip({ name: mention.name, description: '' });
    if (mention.kind === 'skill') {
      const skill = host.resolveSkill?.(mention.name, mention.path || undefined);
      if (!skill?.path || !host.openPath) {
        degradeSkillPill(pill);
      } else if (pill.classList.contains('mention-inert') && !pill.closest('.q-body')) {
        pill.tabIndex = 0;
        pill.setAttribute('role', 'button');
        if (pill.dataset.mentionHref !== undefined) {
          pill.setAttribute('href', pill.dataset.mentionHref);
          delete pill.dataset.mentionHref;
        }
        pill.classList.remove('mention-inert');
      }
      return buildMentionSkillTooltip(skill ?? { name: mention.name, description: '' }, {
        openLabel: host.openSkillLabel?.(),
        onOpen:
          skill?.path && host.openPath
            ? (path) => {
                hide(true);
                host.openPath?.({ path });
              }
            : undefined,
      });
    }
    return buildMentionPathTooltip(mention.path !== '' ? mention.path : mention.name, {
      copyLabel: host.copyPathLabel?.(),
    });
  }

  function position(pill: HTMLElement): void {
    if (!bubble) return;
    const r = pill.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const gap = GAP();
    const margin = VIEWPORT_MARGIN();
    let top = r.top - gap - bh;
    let side: 'top' | 'bottom' = 'top';
    if (top < margin) {
      top = r.bottom + gap;
      side = 'bottom';
    }
    top = Math.min(
      Math.max(top, margin),
      Math.max(margin, window.innerHeight - margin - bh),
    );
    const left = Math.min(
      Math.max(r.left + r.width / 2 - bw / 2, margin),
      Math.max(margin, window.innerWidth - margin - bw),
    );
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.dataset.side = side;
    const caretX = Math.min(Math.max(r.left + r.width / 2 - left, 10), bw - 10);
    bubble.style.setProperty('--tip-caret-x', `${Math.round(caretX)}px`);
  }

  function setBubbleContent(content: HTMLElement): void {
    if (!bubble || !caret) return;
    bubble.replaceChildren(content, caret);
  }

  function pointerWithinHoverRegion(): boolean {
    const { x, y } = lastPointerPosition();
    if (
      x < 0 ||
      y < 0 ||
      anchor === null ||
      !anchor.isConnected ||
      bubble === null ||
      !bubble.classList.contains('positioned')
    ) {
      return false;
    }
    return isPointInTooltipHoverRegion(
      x,
      y,
      anchor.getBoundingClientRect(),
      bubble.getBoundingClientRect(),
      HOVER_SLOP(),
      GAP(),
    );
  }

  function reanchorDetachedMediaPill(): boolean {
    const previous = anchor;
    const { x, y } = lastPointerPosition();
    if (
      previous === null ||
      !previous.classList.contains('attachment-pill') ||
      (previous.dataset.attachmentKind !== 'image' && previous.dataset.attachmentKind !== 'video') ||
      x < 0 ||
      y < 0 ||
      typeof document.elementFromPoint !== 'function'
    ) {
      return false;
    }
    const replacement = closestPill(document.elementFromPoint(x, y));
    if (replacement === null || anchorIdentity === null || tooltipPillIdentity(replacement) !== anchorIdentity) return false;
    previous.removeAttribute('aria-describedby');
    anchor = replacement;
    hoverPill = replacement;
    if (bubble !== null) replacement.setAttribute('aria-describedby', bubble.id);
    setBubbleContent(contentFor(replacement));
    bubble?.classList.toggle('mention-tip--media', true);
    position(replacement);
    return true;
  }

  function clearShowTimer(): void {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }

  function clearHideTimer(): void {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function activeSelectedMediaPill(): HTMLElement | null {
    const active = document.activeElement;
    const editor = active instanceof Element ? active.closest<HTMLElement>('.ProseMirror') : null;
    if (editor === null || !editor.classList.contains('ProseMirror-focused')) return null;
    const selected = editor.querySelectorAll<HTMLElement>(
      '.attachment-pill.ProseMirror-selectednode.attachment-image, ' +
        '.attachment-pill.ProseMirror-selectednode.attachment-video',
    );
    return selected.length === 1 ? selected[0]! : null;
  }

  function syncSelectedMediaPopover(): void {
    const selected = activeSelectedMediaPill();
    if (selected !== null) {
      pinnedBySelection = true;
      clearShowTimer();
      clearHideTimer();
      if (anchor !== selected || !bubble?.classList.contains('positioned')) show(selected);
      else position(selected);
      return;
    }
    if (!pinnedBySelection) return;
    pinnedBySelection = false;
    if (bubble !== null && document.activeElement instanceof Node && bubble.contains(document.activeElement)) return;
    if (!pointerWithinHoverRegion()) scheduleHide();
  }

  function show(pill: HTMLElement): void {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'mention-tip';
      bubble.id = 'mention-tip';
      bubble.setAttribute('role', 'tooltip');
      bubble.addEventListener('mouseenter', clearHideTimer);
      bubble.addEventListener('mouseleave', () => scheduleHide());
      bubble.addEventListener('focusin', clearHideTimer);
      bubble.addEventListener('focusout', (event) => {
        const to = event.relatedTarget;
        if (to instanceof Node && (bubble?.contains(to) || anchor?.contains(to))) return;
        hide();
      });
      document.body.append(bubble);
      caret = document.createElement('span');
      caret.className = 'mention-tip-caret';
      caret.setAttribute('aria-hidden', 'true');
    }
    bubbleResizeObserver.observe(bubble);
    anchor?.removeAttribute('aria-describedby');
    anchor = pill;
    anchorIdentity = tooltipPillIdentity(pill);
    anchor.setAttribute('aria-describedby', bubble.id);
    shownProbeKey = null;
    let probeRequest: {
      path: string;
      kind: 'file' | 'folder';
      actionPath?: string;
      strike?: (missing: boolean) => void;
    } | null = null;
    if (pill.classList.contains('attachment-pill')) {
      shownPath = null;
      const att = pillAttachment(pill);
      const inComposer = pill.closest('.ProseMirror') !== null;
      const attachmentResolver = getAttachmentTooltipResolver();
      const info = inComposer ? (attachmentResolver?.(att.attId) ?? null) : null;
      if (info === null) {
        if (attachmentResolver && inComposer) markAttachmentMissing(att.attId, true);
      } else {
        markAttachmentMissing(att.attId, false);
        if (info.path && (att.kind === 'file' || att.kind === 'folder')) {
          probeRequest = { path: info.path, kind: att.kind, strike: (missing) => markAttachmentMissing(att.attId, missing) };
        }
      }
    } else if (!pill.classList.contains('quote-pill')) {
      const mention = pillMention(pill);
      shownPath = (mention.kind === 'file' || mention.kind === 'folder') && mention.path !== '' ? mention.path : null;
      if (shownPath !== null) {
        probeRequest = {
          path: shownPath,
          kind: mention.kind === 'folder' ? 'folder' : 'file',
          actionPath: pill.dataset.mentionActionPath,
        };
      }
    }
    setBubbleContent(contentFor(pill));
    bubble.classList.toggle('mention-tip--media', bubble.querySelector('.mention-tip-media') !== null);
    bubble.classList.toggle('mention-tip--actions', bubble.querySelector('.mention-tip-pasted-text .mention-tip-media-actions') !== null);
    bubble.classList.remove('positioned');
    position(pill);
    bubble.classList.add('positioned');
    bubble.removeAttribute('inert');
    if (probeRequest !== null && host.probePath) {
      const { path, kind, actionPath, strike } = probeRequest;
      const key = `${host.probeScope?.() ?? ''}|${actionPath ?? path}`;
      if (!probeCacheFresh(key)) {
        const spinner = document.createElement('span');
        spinner.className = 'mention-tip-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const pathText = bubble.querySelector('.mention-tip-path-text');
        (pathText ?? bubble).append(spinner);
        probe(path, kind, actionPath, strike);
      }
    }
    disconnectObserver ??= new MutationObserver(() => {
      if (anchor && !anchor.isConnected && !reanchorDetachedMediaPill()) hide();
    });
    disconnectObserver.disconnect();
    disconnectObserver.observe(document.body, { childList: true, subtree: true });
  }

  function hide(force = false): void {
    if (!force) {
      const selected = activeSelectedMediaPill();
      if (selected !== null) {
        pinnedBySelection = true;
        clearShowTimer();
        clearHideTimer();
        if (anchor !== selected || !bubble?.classList.contains('positioned')) show(selected);
        else position(selected);
        return;
      }
    }
    pinnedBySelection = false;
    pinnedByClick = false;
    clearShowTimer();
    clearHideTimer();
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
    anchorIdentity = null;
    shownPath = null;
    shownProbeKey = null;
    shownMediaInfo = undefined;
    if (mediaPopoverCtl?.mintedUrl != null) URL.revokeObjectURL(mediaPopoverCtl.mintedUrl);
    mediaPopoverCtl = null;
    hoverPill = null;
    disconnectObserver?.disconnect();
    if (bubble) bubbleResizeObserver.unobserve(bubble);
    bubble?.classList.remove('positioned');
    bubble?.setAttribute('inert', '');
  }

  function scheduleShow(pill: HTMLElement): void {
    clearShowTimer();
    clearHideTimer();
    const delay = bubble?.classList.contains('positioned') ? 0 : SHOW_DELAY();
    showTimer = window.setTimeout(() => {
      showTimer = undefined;
      if (pill.isConnected) show(pill);
    }, delay);
  }

  function scheduleHide(respectPointer = true): void {
    if (pinnedByClick) return;
    clearShowTimer();
    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      hideTimer = undefined;
      if (respectPointer && pointerWithinHoverRegion()) return;
      hide();
    }, HIDE_GRACE());
  }

  function closestPill(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>('.mention-pill, .attachment-pill, .quote-pill') : null;
  }

  function onPointerMove(event: PointerEvent): void {
    if (isSyntheticPointerMove(event)) return;
    const selected = activeSelectedMediaPill();
    if (selected !== null) {
      pinnedBySelection = true;
      clearHideTimer();
      if (anchor !== selected || !bubble?.classList.contains('positioned')) show(selected);
      return;
    }
    pinnedBySelection = false;
    if (pinnedByClick) return;
    const pill = closestPill(event.target);
    if (!pill) {
      hoverPill = null;
      if (event.target instanceof Node && bubble?.contains(event.target)) {
        clearHideTimer();
        return;
      }
      if (pointerWithinHoverRegion()) {
        clearHideTimer();
      } else if (anchor !== null && bubble?.classList.contains('positioned') && hideTimer === undefined) {
        scheduleHide();
      }
      return;
    }
    if (pill === hoverPill) return;
    hoverPill = pill;
    if (pill === anchor) {
      clearHideTimer();
      return;
    }
    scheduleShow(pill);
  }

  function onMouseOut(event: MouseEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    const to = event.relatedTarget;
    if (to instanceof Element && (pill.contains(to) || bubble?.contains(to))) return;
    hoverPill = null;
    scheduleHide();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      const pill = closestPill(event.target);
      if (pill && (activateSkillPill(pill, event) || activateAttachmentPill(pill, event))) return;
      if (pill && pill.closest('.ProseMirror') === null && pinPastedTextPill(pill)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === 'Escape') {
      if (consumeSelectedMediaEscape(event, activeSelectedMediaPill(), dismissComposerNodeSelection)) {
        hide(true);
        return;
      }
      if (bubble?.classList.contains('positioned')) {
        if (anchor && event.target instanceof Node && bubble.contains(event.target)) anchor.focus();
        hide();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (event.key === 'Tab') {
      if (bubble?.classList.contains('positioned') && event.target instanceof Node && bubble.contains(event.target)) {
        const buttons = [...bubble.querySelectorAll<HTMLElement>('button')];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if ((!event.shiftKey && event.target === last) || (event.shiftKey && event.target === first)) {
          event.preventDefault();
          anchor?.focus();
          hide();
        }
        return;
      }
      if (event.shiftKey) return;
      const pill = closestPill(event.target);
      if (pill === anchor && bubble?.classList.contains('positioned')) {
        const firstBtn = bubble.querySelector<HTMLElement>('button');
        if (firstBtn) {
          event.preventDefault();
          firstBtn.focus();
        }
      }
      return;
    }
    if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
    if (bubble?.contains(document.activeElement)) return;
    hide();
  }

  function onResize(): void {
    hide();
  }

  function onPointerDown(event: PointerEvent): void {
    if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
    if (anchor !== null && event.target instanceof Node && anchor.contains(event.target) && anchor.classList.contains('pasted-text-pill')) return;
    hide();
  }

  function onWindowBlur(): void {
    hoverPill = null;
    hide();
  }

  function onDocumentPointerLeave(): void {
    hoverPill = null;
    hide();
  }

  function activateSkillPill(pill: HTMLElement, event: Event): boolean {
    if (pill.closest('.ProseMirror')) return false;
    if (pill.closest('.q-body')) return false;
    const mention = pillMention(pill);
    if (mention.kind !== 'skill') return false;
    const skill = host.resolveSkill?.(mention.name, mention.path || undefined);
    if (!skill?.path || !host.openPath) {
      degradeSkillPill(pill);
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    hide(true);
    host.openPath({ path: skill.path });
    return true;
  }

  function activateAttachmentPill(pill: HTMLElement, event: Event): boolean {
    if (!pill.classList.contains('attachment-pill')) return false;
    if (pill.closest('.ProseMirror')) return false;
    if (pill.closest('.q-body')) return false;
    const url = pill.dataset.attachmentUrl ?? '';
    if (url === '' || !host.openAttachment) return false;
    event.preventDefault();
    event.stopPropagation();
    hide(true);
    host.openAttachment({
      url,
      fileId: pill.dataset.attachmentFileId || undefined,
      name: pillAttachment(pill).name,
      mediaType: pill.dataset.attachmentMediaType || undefined,
      kind: pill.dataset.attachmentKind || undefined,
      sessionId: pill.dataset.attachmentSessionId || undefined,
    });
    return true;
  }

  function onFocusIn(event: FocusEvent): void {
    if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return;
    const pill = closestPill(event.target);
    if (!pill) return;
    if (pill === anchor) {
      clearHideTimer();
      return;
    }
    scheduleShow(pill);
  }

  function onFocusOut(event: FocusEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    const to = event.relatedTarget;
    if (to instanceof Node && bubble?.contains(to)) return;
    scheduleHide(false);
  }

  function pinPastedTextPill(pill: HTMLElement): boolean {
    if (!pill.classList.contains('pasted-text-pill')) return false;
    clearShowTimer();
    clearHideTimer();
    if (anchor !== pill || !bubble?.classList.contains('positioned')) show(pill);
    pinnedByClick = true;
    return true;
  }

  function onClickCapture(event: MouseEvent): void {
    const pill = closestPill(event.target);
    if (!pill) return;
    if (pinPastedTextPill(pill)) return;
    if (activateSkillPill(pill, event)) return;
    activateAttachmentPill(pill, event);
  }

  ensurePointerTracking();
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('mouseout', onMouseOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onWindowBlur);
  document.documentElement.addEventListener('pointerleave', onDocumentPointerLeave);

  const stopWatchingEntries = watchAttachmentEntries(() => {
    if (mediaPopoverCtl === null || anchor === null || !bubble?.classList.contains('positioned')) return;
    if (!anchor.classList.contains('attachment-pill') || !anchor.closest('.ProseMirror')) return;
    const att = pillAttachment(anchor);
    const info = getAttachmentTooltipResolver()?.(att.attId) ?? null;
    const shown = shownMediaInfo ?? null;
    const structural =
      (info?.error ?? null) !== (shown?.error ?? null) ||
      (info?.previewUrl ?? null) !== (shown?.previewUrl ?? null) ||
      (info === null) !== (shown === null);
    if (structural) {
      setBubbleContent(contentFor(anchor));
      position(anchor);
      return;
    }
    const state = mediaUploadStateFor(info);
    if (state !== undefined) {
      shownMediaInfo = info;
      mediaPopoverCtl.setUploadState(state);
    }
  });
  const stopWatchingSelections = watchComposerSelections(syncSelectedMediaPopover);

  return () => {
    stopWatchingEntries();
    stopWatchingSelections();
    bubbleResizeObserver.disconnect();
    hide(true);
    bubble?.remove();
    bubble = null;
    caret = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('mouseout', onMouseOut);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('click', onClickCapture, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onWindowBlur);
    document.documentElement.removeEventListener('pointerleave', onDocumentPointerLeave);
  };
}
