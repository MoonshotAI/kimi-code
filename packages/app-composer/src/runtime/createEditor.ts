import { v4 as randomUUID } from 'uuid';
import { EditorState, TextSelection, type SelectionBookmark } from 'prosemirror-state';
import { EditorView, type ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { splitBlock } from 'prosemirror-commands';
import { analyzeLeadingSlashCommand, type SlashCommand } from '@moonshot-ai/app-core/lib';
import { buildAttachmentWithTextInsertion, buildMentionInsertion, buildQuoteInsertion, buildTextRangeReplacement, collectSkillMentions, composerSchema, degradeForeignAttachmentLinks, docText, docToText, inlineRunStartOffset, mayStartWithSlashCommand, normalizedDocText, parseClipboardText, posToTextOffset, serializeClipboardSlice, textOffsetToPos, textToDoc, type AttachmentAttrs, type MentionAttrs, type PastedTextAttrs, type QuoteAttrs, type SkillMentionRef } from '../model';
import { isLongPastedText, pastedTextNode } from '../model';
import { buildPastedTextPill, type PastedTextMeta } from '../features/pasted-text/pill';
import { orderedDocAttachments } from '../features/attachment/registry';
import {
  activateAttachmentStep,
  attachmentInventory,
  attachmentInventoryKey,
  deactivateAttachmentTransaction,
  insertAttachmentsTransaction,
  reorderAttachmentStep,
  removeAttachmentReferencesTransaction,
} from '../features/attachment/inventory';
import { buildAttachmentClipboardPaste, COMPOSER_CLIPBOARD_MIME, resolveComposerClipboardMime } from '../features/attachment/clipboard';
import { kindSourceFor, type AttachmentEntry } from '../features/attachment/entry';
import { truncateMentionName, buildMentionPill } from '../features/mention/pill';
import { buildAttachmentPill } from '../features/attachment/pill';
import { buildQuotePill } from '../features/quote/pill';
import { setAttachmentTooltipResolver } from '../features/attachment/tooltipResolver';
import { buildWorkModePill, workModePillLayout, type WorkModePillSpec } from './workModePill';
import { buildComposerPlaceholderOverlay, commandArgumentPlaceholderAnchor, composerPlaceholderAnchor, composerPlaceholderLayout, isEmptyComposerDoc, setComposerPlaceholderOverlayText } from './composerPlaceholder';
import { stashEditorState, takeEditorState } from './editorStateCache';
import type { ComposerEditorApi, ComposerEditorOptions } from './contracts';
import { notifyAttachmentEntryWatchers, notifyComposerSelectionWatchers, registerComposerEditorView } from './editorRegistry';
import { clipboardHasFiles, composerClipboardSerializer, composerPlugins, writeComposerClipboard } from './plugins';
import { takeComposerClipboardFlavor } from '../transcript/clipboardBridge';
import { composerSnapshotDocument, createComposerSnapshot, parseComposerSnapshot } from '../model/snapshot';
import { browserReferenceInventory, browserReferenceKey, insertBrowserReferenceTransaction, updateBrowserReferenceTransaction } from '../features/browser-reference/inventory';
import { renderBrowserReferencePill } from '../features/browser-reference/pill';
import type { BrowserReferenceAttrs } from '../model/wireCodec';
import { setBrowserReferenceTooltip, type BrowserReferenceTooltipInfo } from '../features/browser-reference/tooltip';

class BrowserReferenceNodeView {
  readonly dom = document.createElement('span');

  constructor(
    private node: PMNode,
    private readonly lookup: (id: string) => Omit<BrowserReferenceTooltipInfo, 'label'>,
    open: (id: string, anchor: HTMLElement) => void,
    private readonly onDestroy: (view: BrowserReferenceNodeView) => void,
  ) {
    this.refresh();
    this.dom.addEventListener('click', () => open(this.node.attrs.refId as string, this.dom));
    this.dom.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      open(this.node.attrs.refId as string, this.dom);
    });
  }

  refresh(): void {
    const attrs = this.node.attrs as BrowserReferenceAttrs;
    renderBrowserReferencePill(this.dom, attrs, this.lookup(attrs.refId).reference);
    setBrowserReferenceTooltip(this.dom, () => ({ label: attrs.label, ...this.lookup(attrs.refId) }));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.refresh();
    return true;
  }

  destroy(): void {
    this.onDestroy(this);
  }
}

class MentionNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = buildMentionPill(node.attrs as MentionAttrs);
  }
}

class AttachmentNodeView {
  readonly dom: HTMLElement;

  constructor(
    private node: PMNode,
    private readonly displayName: (attrs: AttachmentAttrs) => string,
    private readonly onDestroy: (view: AttachmentNodeView) => void,
  ) {
    this.dom = buildAttachmentPill(node.attrs as AttachmentAttrs);
    this.refresh();
  }

  refresh(): void {
    const attrs = this.node.attrs as AttachmentAttrs;
    if (attrs.comment) this.dom.setAttribute('aria-label', `${this.displayName(attrs)}\n${attrs.comment}`);
    const label = this.dom.querySelector('.attachment-pill-name');
    if (label !== null) label.textContent = truncateMentionName(this.displayName(this.node.attrs as AttachmentAttrs));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type || node.attrs.attId !== this.node.attrs.attId || node.attrs.kind !== this.node.attrs.kind || node.attrs.comment !== this.node.attrs.comment) return false;
    this.node = node;
    this.dom.dataset.attachmentName = node.attrs.name as string;
    this.refresh();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection';
  }

  destroy(): void {
    this.onDestroy(this);
  }
}

class PastedTextNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode, meta?: PastedTextMeta) {
    this.dom = buildPastedTextPill(node.attrs as PastedTextAttrs, meta);
  }
}

class QuoteNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = buildQuotePill(node.attrs as QuoteAttrs);
  }
}

export function createComposerEditor(host: HTMLElement, options: ComposerEditorOptions): ComposerEditorApi {
  let editable = true;
  const recognizeSlashCommands = options.recognizeSlashCommands !== false;
  let slashCommands: ReadonlyArray<SlashCommand> | undefined = options.slashCommands;
  const currentSlashCommands = (): ReadonlyArray<SlashCommand> | undefined => slashCommands;
  const bookmarks = new Map<string, SelectionBookmark>();
  let fallbackEntries = new Map(
    (options.attachments?.initialEntries ?? []).map((entry) => [entry.attId, entry] as const),
  );
  const resourceEntries = (): AttachmentEntry[] =>
    options.attachments?.getEntries?.() ?? [...fallbackEntries.values()];
  const resourceEntry = (attId: string): AttachmentEntry | undefined =>
    options.attachments?.getEntries?.().find((entry) => entry.attId === attId) ?? fallbackEntries.get(attId);
  const upsertResourceEntry = (entry: AttachmentEntry): void => {
    if (options.attachments?.upsertEntry !== undefined) options.attachments.upsertEntry(entry);
    else {
      const next = new Map(fallbackEntries);
      next.set(entry.attId, entry);
      fallbackEntries = next;
    }
  };
  const patchResourceEntry = (
    attId: string,
    patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>,
  ): void => {
    if (options.attachments?.patchEntry !== undefined) options.attachments.patchEntry(attId, patch);
    else {
      const current = fallbackEntries.get(attId);
      if (current === undefined) return;
      const next = new Map(fallbackEntries);
      next.set(attId, { ...current, ...patch });
      fallbackEntries = next;
    }
  };
  const attachmentViews = new Set<AttachmentNodeView>();
  const browserReferenceViews = new Set<BrowserReferenceNodeView>();
  const referenceData = (state: EditorState) => {
    const inventory = browserReferenceInventory(state);
    return { references: [...inventory.references.values()], captures: [...inventory.captures.values()] };
  };
  const snapshotForState = (state: EditorState) => createComposerSnapshot(state.doc, resourceEntries(), attachmentInventory(state).orderedIds, referenceData(state));
  const displayAttachmentName = (attrs: AttachmentAttrs): string => {
    const entry = resourceEntry(attrs.attId);
    return entry !== undefined && (attrs.kind === 'image' || attrs.kind === 'video')
      ? options.attachments?.referenceName?.(entry) ?? attrs.name
      : attrs.name;
  };
  const notifyInventoryChange = (before: EditorState, after: EditorState): void => {
    if (attachmentInventoryKey.getState(before) !== attachmentInventoryKey.getState(after)) {
      options.attachments?.onInventoryChange?.(attachmentInventory(after));
    }
  };
  const notifyViewStateChange = (before: EditorState, after: EditorState): void => {
    notifyInventoryChange(before, after);
    const referencesChanged = browserReferenceKey.getState(before) !== browserReferenceKey.getState(after);
    if (referencesChanged || !before.doc.eq(after.doc)) {
      for (const nodeView of browserReferenceViews) nodeView.refresh();
      options.onBrowserReferencesChange?.();
    }
    if (!before.doc.eq(after.doc) || referencesChanged || attachmentInventoryKey.getState(before) !== attachmentInventoryKey.getState(after)) {
      options.onSnapshotChange?.(snapshotForState(after));
    }
    if (!before.selection.eq(after.selection)) notifyComposerSelectionWatchers();
  };

  const initialSnapshot = options.initialSnapshot === undefined ? null : parseComposerSnapshot(options.initialSnapshot);
  if (options.initialSnapshot !== undefined && initialSnapshot === null) throw new Error('Invalid composer snapshot');
  for (const entry of initialSnapshot?.attachments ?? []) upsertResourceEntry(entry);
  const initialDoc = initialSnapshot === null ? textToDoc(options.initialText, {
    reviveMentions: true,
    attachmentKindFor: kindSourceFor(resourceEntries()),
  }) : composerSnapshotDocument(initialSnapshot);
  let workModePillElement: HTMLElement | null = null;
  let placeholderText = '';
  let placeholderElement: HTMLElement | null = null;
  let composerChromeFrame = 0;
  let observedWorkModePill: Element | null = null;
  let composerResizeObserver: ResizeObserver | null = null;
  const workModeLaneQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(hover: none)') : null;
  let destroyed = false;

  const observeWorkModePill = (pill: Element | null): void => {
    if (pill === observedWorkModePill) return;
    if (observedWorkModePill) composerResizeObserver?.unobserve(observedWorkModePill);
    observedWorkModePill = pill;
    if (pill) composerResizeObserver?.observe(pill);
  };

  const clearWorkModeReserves = (): void => {
    view.dom.style.removeProperty('--wm-pill-inline-reserve');
    view.dom.style.removeProperty('--wm-pill-block-reserve');
  };

  const updateComposerChrome = (): void => {
    composerChromeFrame = 0;
    if (destroyed) return;

    const element = placeholderElement;
    const commandMatch = leadingSlashCommand(view.state);
    const commandHasArgument = commandMatch
      ? docText(view.state.doc).slice(commandMatch.argumentRange.start, commandMatch.argumentRange.end).trim() !== ''
      : false;
    const commandHint = commandMatch?.item.argHint && !commandHasArgument ? placeholderText : '';
    const commandPlaceholderVisible = element !== null && commandHint !== '';
    const emptyPlaceholderVisible = element !== null && placeholderText !== '' && isEmptyComposerDoc(view.state.doc);
    const placeholderVisible = commandPlaceholderVisible || emptyPlaceholderVisible;
    const pill = workModePillElement;
    if (!pill && !placeholderVisible) {
      clearWorkModeReserves();
      if (element) element.hidden = true;
      return;
    }

    const paragraph = view.dom.querySelector('p');
    if (!paragraph) {
      clearWorkModeReserves();
      if (element) element.hidden = true;
      return;
    }

    const frame = host.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    const scroll = { left: host.scrollLeft, top: host.scrollTop };
    const clientWidth = host.clientWidth;
    let pillLayout: ReturnType<typeof workModePillLayout> | undefined;
    let pillMargins: { lane: 'inline' | 'block'; marginRight: number; marginBottom: number } | undefined;
    if (pill) {
      const pillStyle = getComputedStyle(pill);
      const marginLeft = Number.parseFloat(pillStyle.marginLeft) || 0;
      const marginRight = Number.parseFloat(pillStyle.marginRight) || 0;
      const marginTop = Number.parseFloat(pillStyle.marginTop) || 0;
      const marginBottom = Number.parseFloat(pillStyle.marginBottom) || 0;
      const lane = pillStyle.getPropertyValue('--wm-pill-lane').trim() === 'block' ? 'block' : 'inline';
      const pillBox = pill.getBoundingClientRect();
      pillLayout = workModePillLayout(
        paragraphRect,
        frame,
        scroll,
        {
          width: pillBox.width,
          height: pillBox.height,
          marginLeft,
          marginRight,
          marginTop,
          marginBottom,
          lane,
        },
      );
      pillMargins = { lane, marginRight, marginBottom };
    }

    if (pill && pillLayout) {
      pill.style.transform = `translate3d(${pillLayout.left}px, ${pillLayout.top}px, 0)`;
      pill.style.removeProperty('visibility');
      view.dom.style.setProperty('--wm-pill-inline-reserve', `${pillLayout.inlineReserve}px`);
      view.dom.style.setProperty('--wm-pill-block-reserve', `${pillLayout.blockReserve}px`);
    } else {
      clearWorkModeReserves();
    }

    const placeholderAnchor = commandPlaceholderVisible && commandMatch
      ? commandArgumentPlaceholderAnchor(
          view.coordsAtPos(textOffsetToPos(view.state.doc, commandMatch.argumentRange.end)),
          Number.parseFloat(getComputedStyle(paragraph).lineHeight),
        )
      : composerPlaceholderAnchor(paragraphRect, pillLayout?.box, pillMargins);
    const placeholderLayout = placeholderVisible
      ? composerPlaceholderLayout(placeholderAnchor, frame, scroll, clientWidth)
      : undefined;

    if (element) {
      element.hidden = !placeholderVisible;
      if (!placeholderVisible) {
        delete element.dataset.commandArgument;
        delete element.dataset.needsSeparator;
      } else if (placeholderLayout) {
        setComposerPlaceholderOverlayText(element, commandPlaceholderVisible ? commandHint : placeholderText);
        if (commandPlaceholderVisible) element.dataset.commandArgument = 'true';
        else delete element.dataset.commandArgument;
        if (commandPlaceholderVisible && commandMatch?.needsArgumentSeparator) {
          element.dataset.needsSeparator = 'true';
        } else {
          delete element.dataset.needsSeparator;
        }
        element.style.transform = `translate3d(${placeholderLayout.left}px, ${placeholderLayout.top}px, 0)`;
        element.style.maxWidth = `${placeholderLayout.maxWidth}px`;
      }
    }
  };

  const scheduleComposerChromeUpdate = (): void => {
    if (destroyed || composerChromeFrame !== 0) return;
    composerChromeFrame = window.requestAnimationFrame(updateComposerChrome);
  };

  const flushComposerChromeUpdate = (): void => {
    if (composerChromeFrame !== 0) window.cancelAnimationFrame(composerChromeFrame);
    composerChromeFrame = 0;
    updateComposerChrome();
  };

  const leadingSlashCommand = (state: EditorState) => {
    if (!recognizeSlashCommands || !mayStartWithSlashCommand(docText(state.doc))) return null;
    return analyzeLeadingSlashCommand(normalizedDocText(state.doc), slashCommands);
  };

  const hasCommandArgumentPlaceholder = (state: EditorState): boolean => {
    const match = leadingSlashCommand(state);
    if (!match?.item.argHint) return false;
    return docText(state.doc).slice(match.argumentRange.start, match.argumentRange.end).trim() === '';
  };

  const view: EditorView = new EditorView(host, {
    state: EditorState.create({
      schema: composerSchema,
      doc: initialDoc,
      plugins: composerPlugins(resourceEntries(), resourceEntry, initialSnapshot?.attachmentOrder, initialSnapshot ?? undefined, recognizeSlashCommands, currentSlashCommands),
      selection: TextSelection.atEnd(initialDoc),
    }),
    editable: () => editable,
    attributes: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      'aria-disabled': 'false',
      spellcheck: 'false',
      autocomplete: 'off',
    },
    dispatchTransaction(tr) {
      const before = view.state;
      const applied = before.applyTransaction(tr);
      const newState = applied.state;
      for (const transaction of applied.transactions) {
        for (const [id, bookmark] of bookmarks) bookmarks.set(id, bookmark.map(transaction.mapping));
      }
      const chromeVisibilityChanged =
        isEmptyComposerDoc(before.doc) !== isEmptyComposerDoc(newState.doc);
      const commandPlaceholderVisibilityChanged =
        hasCommandArgumentPlaceholder(before) !== hasCommandArgumentPlaceholder(newState);
      view.updateState(newState);
      if (tr.docChanged) options.onChange(docText(newState.doc));
      notifyViewStateChange(before, newState);
      if (commandPlaceholderVisibilityChanged) flushComposerChromeUpdate();
      else if (tr.docChanged || chromeVisibilityChanged) scheduleComposerChromeUpdate();
    },
    nodeViews: {
      browser_reference: (node, editorView) => {
        const nodeView = new BrowserReferenceNodeView(
          node,
          (id) => {
            const inventory = browserReferenceInventory(editorView.state);
            const reference = inventory.references.get(id);
            const capture = reference === undefined ? undefined : inventory.captures.get(reference.captureId);
            return { reference, capture, thumbnail: capture?.screenshot === undefined ? undefined : resourceEntry(capture.screenshot.attachmentId)?.thumbnailUrl };
          },
          (id, anchor) => options.onBrowserReferenceOpen?.(id, anchor),
          (entry) => browserReferenceViews.delete(entry),
        );
        browserReferenceViews.add(nodeView);
        return nodeView;
      },
      mention: (node) => new MentionNodeView(node),
      attachment: (node) => {
        const nodeView = new AttachmentNodeView(node, displayAttachmentName, (instance) => attachmentViews.delete(instance));
        attachmentViews.add(nodeView);
        return nodeView;
      },
      quote: (node) => new QuoteNodeView(node),
      pasted_text: (node) => new PastedTextNodeView(node, options.pastedTextMeta),
    },
    handleKeyDown: (_view, event) => options.handleKeyDown(event),
    handleDOMEvents: {
      keydown: (_view, event) => {
        if (event.key !== 'Escape') return false;
        if (options.handleKeyDown(event)) event.preventDefault();
        return true;
      },
      focus: () => {
        queueMicrotask(notifyComposerSelectionWatchers);
        return false;
      },
      blur: (_view, event) => {
        options.onBlur?.(event);
        queueMicrotask(notifyComposerSelectionWatchers);
        return false;
      },
      copy: (view, event) => writeComposerClipboard(view, event, resourceEntry),
      cut: (view, event) => {
        if (!writeComposerClipboard(view, event, resourceEntry)) return false;
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
        return true;
      },
    },
    clipboardSerializer: composerClipboardSerializer,
    clipboardTextParser: (text) => parseClipboardText(text),
    clipboardTextSerializer: (slice) => serializeClipboardSlice(slice),
    handlePaste: (view, event) => {
      const composerMime = event.clipboardData?.getData(COMPOSER_CLIPBOARD_MIME);
      const composerPayload = composerMime ? resolveComposerClipboardMime(composerMime) : undefined;
      if (composerPayload) {
        const tr = buildAttachmentClipboardPaste(view.state, composerPayload, {
          entries: resourceEntries(),
          upsert: upsertResourceEntry,
          referenceName: options.attachments?.referenceName,
        });
        if (tr) {
          event.preventDefault();
          view.dispatch(tr);
          return true;
        }
      }
      if (clipboardHasFiles(event)) {
        event.preventDefault();
        return true;
      }
      const plain = event.clipboardData?.getData('text/plain');
      if (plain) {
        event.preventDefault();
        const stashed = takeComposerClipboardFlavor(plain);
        if (stashed) {
          const tr = buildAttachmentClipboardPaste(view.state, stashed, {
            entries: resourceEntries(),
            upsert: upsertResourceEntry,
            referenceName: options.attachments?.referenceName,
          });
          if (tr) {
            view.dispatch(tr);
            return true;
          }
        }
        const normalized = plain.replace(/\r\n?/g, '\n');
        if (isLongPastedText(normalized)) {
          view.dispatch(view.state.tr.replaceSelectionWith(pastedTextNode({ text: normalized }), false).scrollIntoView());
          return true;
        }
        const knownAttIds = new Set(attachmentInventory(view.state).activeIds);
        const filtered = degradeForeignAttachmentLinks(plain, knownAttIds);
        view.dispatch(view.state.tr.replaceSelection(parseClipboardText(filtered, { reviveMentions: true })).scrollIntoView());
        return true;
      }
      return false;
    },
    handleDrop: (view, event, _slice, moved) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault();
        return true;
      }
      if (moved) return false;
      const text = event.dataTransfer?.getData('text/plain');
      if (text) {
        event.preventDefault();
        const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const tr = view.state.tr;
        if (dropPos) tr.setSelection(TextSelection.create(tr.doc, dropPos.pos));
        const knownAttIds = new Set(attachmentInventory(view.state).activeIds);
        const filtered = degradeForeignAttachmentLinks(text, knownAttIds);
        view.dispatch(tr.replaceSelection(parseClipboardText(filtered, { reviveMentions: true })).scrollIntoView());
        return true;
      }
      return false;
    },
  });
  placeholderElement = buildComposerPlaceholderOverlay(placeholderText);
  host.append(placeholderElement);
  if (typeof ResizeObserver === 'function') {
    composerResizeObserver = new ResizeObserver(scheduleComposerChromeUpdate);
    composerResizeObserver.observe(host);
    composerResizeObserver.observe(view.dom);
  }
  workModeLaneQuery?.addEventListener('change', scheduleComposerChromeUpdate);
  scheduleComposerChromeUpdate();
  registerComposerEditorView(view.dom, view);

  const releaseAttachmentTooltipResolver = setAttachmentTooltipResolver((attId) => {
    const entry = resourceEntry(attId);
    if (!entry) return null;
    return { name: entry.name, path: entry.path, size: entry.size, error: entry.error, uploading: entry.uploading, uploadProgress: entry.uploadProgress, fileId: entry.fileId, sessionId: entry.sessionId, previewUrl: entry.previewUrl };
  });

  const onCompositionStart = (): void => options.onCompositionStart?.();
  const onCompositionEnd = (): void => options.onCompositionEnd?.();
  view.dom.addEventListener('compositionstart', onCompositionStart);
  view.dom.addEventListener('compositionend', onCompositionEnd);

  const refreshAttachmentLabels = (): void => {
    for (const nodeView of attachmentViews) nodeView.refresh();
  };

  const api: ComposerEditorApi = {
    dom: view.dom,

    get selectionStart(): number | null {
      return posToTextOffset(view.state.doc, view.state.selection.from);
    },
    get selectionEnd(): number | null {
      return posToTextOffset(view.state.doc, view.state.selection.to);
    },

    inlineTextRunStart(): number | null {
      return inlineRunStartOffset(view.state.doc, view.state.selection.$from);
    },

    setSelectionRange(start: number, end: number): void {
      const { doc } = view.state;
      const sel = TextSelection.create(doc, textOffsetToPos(doc, start), textOffsetToPos(doc, end));
      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
    },

    focus(_focusOptions?: FocusOptions): void {
      view.focus();
    },

    getText(): string {
      return docText(view.state.doc);
    },

    getSnapshot() {
      return snapshotForState(view.state);
    },

    saveSelectionBookmark() {
      const id = randomUUID();
      bookmarks.set(id, TextSelection.create(view.state.doc, view.state.selection.to).getBookmark());
      return id;
    },

    restoreSelectionBookmark(id) {
      const bookmark = bookmarks.get(id);
      if (bookmark === undefined) return false;
      bookmarks.delete(id);
      view.dispatch(view.state.tr.setSelection(bookmark.resolve(view.state.doc)));
      return true;
    },

    discardSelectionBookmark(id) {
      bookmarks.delete(id);
    },

    getBrowserReferenceData() {
      return referenceData(view.state);
    },

    insertBrowserReference(capture, reference, range) {
      view.dispatch(closeHistory(insertBrowserReferenceTransaction(view.state, capture, reference, range)));
    },

    updateBrowserReference(id, comment, includeScreenshot) {
      const tr = updateBrowserReferenceTransaction(view.state, id, comment, includeScreenshot);
      if (tr !== null) view.dispatch(closeHistory(tr));
    },

    setSnapshot(snapshot) {
      const parsed = parseComposerSnapshot(snapshot);
      if (parsed === null) throw new Error('Invalid composer snapshot');
      bookmarks.clear();
      const doc = composerSnapshotDocument(parsed);
      if (options.attachments?.getEntries === undefined) {
        fallbackEntries = new Map(parsed.attachments.map((entry) => [entry.attId, entry]));
      } else {
        for (const entry of parsed.attachments) upsertResourceEntry(entry);
      }
      const before = view.state;
      const nextState = EditorState.create({
        schema: composerSchema,
        doc,
        plugins: composerPlugins(parsed.attachments, resourceEntry, parsed.attachmentOrder, parsed, recognizeSlashCommands, currentSlashCommands),
        selection: TextSelection.atEnd(doc),
      });
      view.updateState(nextState);
      options.onChange(docToText(doc));
      notifyViewStateChange(before, nextState);
      refreshAttachmentLabels();
      scheduleComposerChromeUpdate();
    },

    setText(text: string, opts?: { entries?: AttachmentEntry[] }): void {
      bookmarks.clear();
      const before = view.state;
      const entries = opts?.entries ?? resourceEntries();
      if (options.attachments?.getEntries === undefined) {
        fallbackEntries = new Map(entries.map((entry) => [entry.attId, entry] as const));
      }
      const doc = textToDoc(text, { reviveMentions: true, attachmentKindFor: kindSourceFor(entries) });
      const nextState = EditorState.create({
        schema: composerSchema,
        doc,
        plugins: composerPlugins(entries, resourceEntry, undefined, undefined, recognizeSlashCommands, currentSlashCommands),
        selection: TextSelection.atEnd(doc),
      });
      view.updateState(nextState);
      notifyViewStateChange(before, nextState);
      refreshAttachmentLabels();
      scheduleComposerChromeUpdate();
    },

    insertNewlineAtCaret(): void {
      splitBlock(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
    },

    setWorkMode(spec: WorkModePillSpec | null): void {
      observeWorkModePill(null);
      workModePillElement?.remove();
      workModePillElement = spec
        ? buildWorkModePill(spec, () => options.onWorkModeDismiss?.())
        : null;
      if (workModePillElement) {
        workModePillElement.style.visibility = 'hidden';
        host.append(workModePillElement);
        observeWorkModePill(workModePillElement);
      } else {
        clearWorkModeReserves();
      }
      scheduleComposerChromeUpdate();
    },

    setSlashCommands(commands: ReadonlyArray<SlashCommand>): void {
      if (commands === slashCommands) return;
      slashCommands = commands;
      if (!recognizeSlashCommands) return;
      view.updateState(view.state);
      scheduleComposerChromeUpdate();
    },

    setPlaceholder(text: string): void {
      placeholderText = text;
      if (placeholderElement) setComposerPlaceholderOverlayText(placeholderElement, text);
      scheduleComposerChromeUpdate();
    },

    insertMention(attrs: MentionAttrs, range: { start: number; end: number }): void {
      view.dispatch(buildMentionInsertion(view.state, attrs, range));
      view.focus();
    },

    insertTextAt(offset: number, text: string, opts?: { reviveMentions?: boolean }): void {
      const pos = textOffsetToPos(view.state.doc, offset);
      const tr = view.state.tr;
      tr.setSelection(TextSelection.create(tr.doc, pos));
      view.dispatch(tr.replaceSelection(parseClipboardText(text, { reviveMentions: opts?.reviveMentions ?? true })).scrollIntoView());
    },

    replaceTextRange(range: { start: number; end: number }, text: string): void {
      view.dispatch(buildTextRangeReplacement(view.state, text, range));
      view.dispatch(closeHistory(view.state.tr));
      view.focus();
    },

    getSkillMentions(): SkillMentionRef[] {
      return collectSkillMentions(view.state.doc);
    },

    insertAttachment(attrs: AttachmentAttrs, target?: number | { start: number; end: number }): void {
      api.insertAttachments([{
        attrs,
        ...(typeof target === 'number' ? { pos: target } : target === undefined ? {} : { range: target }),
        reference: true,
      }]);
    },

    insertAttachments(items): void {
      const tr = insertAttachmentsTransaction(view.state, items);
      if (tr === null) return;
      view.dispatch(tr);
      view.focus();
    },

    activateAttachment(attId: string, index?: number): void {
      const state = view.state;
      if (attachmentInventory(state).activeIds.has(attId)) return;
      view.dispatch(state.tr.step(activateAttachmentStep(state, attId, index)));
    },

    reorderAttachment(attId: string, to: number): void {
      const state = view.state;
      const step = reorderAttachmentStep(state, attId, to);
      if (step === null) return;
      view.dispatch(state.tr.step(step));
    },

    deactivateAttachment(attId: string): void {
      const state = view.state;
      const tr = deactivateAttachmentTransaction(state, attId);
      if (tr === null) return;
      view.dispatch(tr);
      view.focus();
    },

    removeAttachmentReferences(attId: string): void {
      const state = view.state;
      const tr = removeAttachmentReferencesTransaction(state, attId);
      if (tr === null) return;
      view.dispatch(tr);
      view.focus();
    },

    insertAttachmentWithText(attrs: AttachmentAttrs, text: string, pos?: number, entry?: AttachmentEntry): void {
      if (entry !== undefined) upsertResourceEntry(entry);
      const tr = buildAttachmentWithTextInsertion(view.state, attrs, text, pos);
      if (!attachmentInventory(view.state).activeIds.has(attrs.attId)) {
        tr.step(activateAttachmentStep(view.state, attrs.attId));
      }
      view.dispatch(tr);
      view.focus();
    },

    insertQuote(attrs: QuoteAttrs, comment?: string): void {
      view.dispatch(buildQuoteInsertion(view.state, attrs, comment));
      view.focus();
    },

    upsertAttachmentEntry(entry: AttachmentEntry): void {
      upsertResourceEntry(entry);
      view.dispatch(
        view.state.tr
          .setMeta(attachmentInventoryKey, { type: 'resource-revision' })
          .setMeta('addToHistory', false),
      );
      notifyAttachmentEntryWatchers();
      refreshAttachmentLabels();
    },

    updateAttachmentEntry(attId: string, patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>): void {
      patchResourceEntry(attId, patch);
      view.dispatch(
        view.state.tr
          .setMeta(attachmentInventoryKey, { type: 'resource-revision' })
          .setMeta('addToHistory', false),
      );
      notifyAttachmentEntryWatchers();
      refreshAttachmentLabels();
    },

    refreshAttachmentLabels,

    getAttachmentEntries(): AttachmentEntry[] {
      const inventory = attachmentInventory(view.state);
      return resourceEntries().map((entry) => ({
        ...entry,
        refCount: inventory.refCounts.get(entry.attId) ?? 0,
      }));
    },

    getAttachmentInventory(): ReturnType<typeof attachmentInventory> {
      return attachmentInventory(view.state);
    },

    getOrderedAttachmentIds(): string[] {
      return orderedDocAttachments(view.state.doc);
    },

    textOffsetAtCoords(coords: { left: number; top: number }): number | null {
      const pos = view.posAtCoords(coords);
      return pos ? posToTextOffset(view.state.doc, pos.pos) : null;
    },

    setEditable(next: boolean): void {
      editable = next;
      view.setProps({ editable: () => editable });
      view.dom.setAttribute('aria-disabled', String(!next));
    },

    stashState(sessionId: string): void {
      stashEditorState(sessionId, view.state);
    },

    restoreState(sessionId: string): boolean {
      const state = takeEditorState(sessionId);
      if (!state) return false;
      bookmarks.clear();
      const before = view.state;
      const nextState = state.reconfigure({ plugins: view.state.plugins });
      view.updateState(nextState);
      notifyViewStateChange(before, nextState);
      refreshAttachmentLabels();
      scheduleComposerChromeUpdate();
      return true;
    },

    destroy(): void {
      destroyed = true;
      bookmarks.clear();
      if (composerChromeFrame !== 0) window.cancelAnimationFrame(composerChromeFrame);
      composerChromeFrame = 0;
      observeWorkModePill(null);
      composerResizeObserver?.disconnect();
      composerResizeObserver = null;
      workModeLaneQuery?.removeEventListener('change', scheduleComposerChromeUpdate);
      workModePillElement?.remove();
      workModePillElement = null;
      placeholderElement?.remove();
      placeholderElement = null;
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
      releaseAttachmentTooltipResolver();
      releaseResourceSubscription?.();
      view.destroy();
    },
  };

  const releaseResourceSubscription = options.attachments?.subscribe?.(() => {
    if (destroyed) return;
    view.dispatch(
      view.state.tr
        .setMeta(attachmentInventoryKey, { type: 'resource-revision' })
        .setMeta('addToHistory', false),
    );
    notifyAttachmentEntryWatchers();
  });

  if (import.meta.env.DEV) {
    const w = window as unknown as { __composerEditors?: ComposerEditorApi[] };
    (w.__composerEditors ??= []).push(api);
  }

  return api;
}
