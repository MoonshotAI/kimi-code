// packages/app-composer/src/composerEditor.ts
// ProseMirror editing surface for the composer. Owns the EditorView and
// exposes the TextFieldLike char-offset contract the composer composables
// already speak, so swapping a <textarea> for this is invisible to them.
//
// Phase-0 scope: the doc model is plain text with paragraphs (see
// composerTextDoc.ts) — no marks, no custom nodes — and the component boundary
// stays "plain text in, plain text out" via onChange / setText.
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, selectTextblockEnd, selectTextblockStart, splitBlock } from 'prosemirror-commands';
import { composerSchema, buildAttachmentInsertion, buildMentionInsertion, buildQuoteInsertion, collectSkillMentions, degradeForeignAttachmentLinks, docToText, extendToTextblock, inlineRunStartOffset, parseClipboardText, posToTextOffset, serializeClipboardSlice, textOffsetToPos, textToDoc } from './composerTextDoc';
import { takeComposerClipboardFlavor } from './clipboardWrite';
import type { AttachmentAttrs, MentionAttrs, QuoteAttrs, SkillMentionRef } from './composerTextDoc';
import { attachmentRegistryKey, buildAttachmentClipboardPaste, buildComposerClipboardCopy, COMPOSER_CLIPBOARD_MIME, createAttachmentRegistryPlugin, orderedDocAttachments, resolveComposerClipboardMime, stashComposerFlavor } from './attachmentRegistry';
import type { AttachmentEntry } from './attachmentRegistry';
import { buildMentionPill } from './mentionPill';
import { buildComposerDecorations, type ComposerDecoState, type WorkModePillSpec } from './workModePill';
import { buildAttachmentPill } from './attachmentPill';
import { buildQuotePill } from './quotePill';
import { setAttachmentTooltipResolver } from './mentionTooltip';
import { stashEditorState, takeEditorState } from './editorStateCache';
import type { TextFieldLike } from './textField';

export interface ComposerEditorOptions {
  /** Text the editor starts with (e.g. a restored per-session draft). */
  initialText: string;
  /** Fired whenever the user edits the doc (typing, paste, undo, …).
   *  Programmatic setText() does NOT fire this (it rebuilds the state rather
   *  than dispatching a transaction) — callers use onChange as the textarea's
   *  `input` event replacement. */
  onChange: (text: string) => void;
  /** The composer's keydown arbitrator. Return true = handled (PM stops);
   *  false = fall through to the PM keymaps (history, baseKeymap) and the
   *  browser default. Runs before every PM keymap. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
  /** Editor lost focus — the composer closes its autocomplete menus (the
   *  menu rows use mousedown.prevent, so picking one never fires this). */
  onBlur?: (event: FocusEvent) => void;
  /** Click on the work-mode pill's × — the composer disarms the mode. The
   *  pill is a widget decoration, so dismissal travels as this callback, not
   *  as a document edit. */
  onWorkModeDismiss?: () => void;
  /** IME latch hooks — the composer keeps its per-field composition state and
   *  the document-level latch sees the same events via capture. */
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** Attachment pill support: the registry plugin (attachmentRegistry.ts)
   *  holds one entry per attachment identity — path/size/upload state live
   *  there, the doc only carries { attId, name, kind }. initialEntries seed
   *  the registry (draft sidecar restore; entries nothing references are
   *  dropped on init); onRegistryChange fires after any transaction that
   *  moved the registry (insert/delete reconcile, upsert/patch meta) with
   *  the entries in first-upsert order. */
  attachments?: {
    initialEntries?: AttachmentEntry[];
    onRegistryChange?: (entries: AttachmentEntry[]) => void;
  };
}

export interface ComposerEditorApi extends TextFieldLike {
  /** The contenteditable root (view.dom) — for focus/activeElement checks. */
  readonly dom: HTMLElement;
  getText(): string;
  /** Replace the whole document (draft load, history recall, submit clear).
   *  Matches textarea `.value =` semantics: does not fire onChange, is not
   *  undoable, and RESETS the undo stack; the caret lands at the end. The
   *  attachment registry re-inits from `opts.entries` (default empty) —
   *  never from the editor-creation entries, which belong to the mount
   *  session (see the implementation note); pass the target session's
   *  sidecar entries when restoring a session draft. */
  setText(text: string, opts?: { entries?: AttachmentEntry[] }): void;
  /** Show the armed work-mode pill at the document head (null hides it). The
   *  pill is a widget decoration — NOT document content — so it never enters
   *  the serialized text, the char offsets, or the undo stack, and it can only
   *  ever sit at the head (see workModePill.ts). */
  setWorkMode(spec: WorkModePillSpec | null): void;
  /** The placeholder line drawn while the doc is empty. Rendered as a widget
   *  decoration (a contenteditable has no native placeholder) so it can share
   *  the first line with the work-mode pill. */
  setPlaceholder(text: string): void;
  /** Insert a line break at the caret, replacing any selection (splitBlock).
   *  Goes through a normal transaction so it IS undoable via PM history. */
  insertNewlineAtCaret(): void;
  /** Replace the char-offset range (the @token) with a mention pill; the
   *  caret lands right after the pill and the editor takes focus (the
   *  textarea-era select did both). Fires onChange like any user edit. */
  insertMention(attrs: MentionAttrs, range: { start: number; end: number }): void;
  /** Insert plain text at a serialized-text char offset as ONE undoable
   *  transaction; the caret lands after the inserted content. Unlike setText
   *  this keeps the document — and with it the undo stack — intact. Fires
   *  onChange like any user edit. `reviveMentions` (default true) revives
   *  mention links into pills, like a paste; pass false for literal text
   *  that must never turn into a pill (a dropped folder path whose dirname
   *  merely LOOKS like a link). */
  insertTextAt(offset: number, text: string, opts?: { reviveMentions?: boolean }): void;
  /** Skill pills in the doc, in document order (submit decides between
   *  activation and plain references). */
  getSkillMentions(): SkillMentionRef[];
  /** Insert an attachment pill at `pos` (a serialized-text char offset, same
   *  contract as selectionStart/insertTextAt) or — with no pos — at the
   *  current selection; the caret lands right after the pill and the editor
   *  takes focus. Fires onChange like any user edit. The caller owns the
   *  registry side (upsertAttachmentEntry with the entry's metadata) and any
   *  upload the entry tracks. */
  insertAttachment(attrs: AttachmentAttrs, pos?: number): void;
  /** Append a quote pill at the document END (selection quote actions —
   *  划词): the composer's caret may be stale when the transcript action
   *  fires, and the blockquote-prefix wire form only composes as its own
   *  block. `comment` (the 评论 flow) rides in the same paragraph after the
   *  pill, in the same undoable transaction. The caret lands at the very end
   *  and the editor takes focus. Fires onChange like any user edit. */
  insertQuote(attrs: QuoteAttrs, comment?: string): void;
  /** Create or overwrite a registry entry (upload start, metadata backfill).
   *  Dispatches a meta-only transaction — the doc and the undo stack are
   *  untouched, and onChange does not fire (onRegistryChange does). */
  upsertAttachmentEntry(entry: AttachmentEntry): void;
  /** Merge a partial into an existing entry (fileId backfill, error, size).
   *  Unknown attIds are no-ops. Same meta-only dispatch contract as
   *  upsertAttachmentEntry. */
  updateAttachmentEntry(attId: string, patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>): void;
  /** The registry's entries in first-upsert order (read-only snapshot). */
  getAttachmentEntries(): AttachmentEntry[];
  /** The doc's attachment attIds in first-mention order, deduplicated — the
   *  ordering source for the submit payload and the link-index rewrite. */
  getOrderedAttachmentIds(): string[];
  /** Translate viewport coordinates (a drop's clientX/Y) into a serialized
   *  -text char offset — the same contract as selectionStart/insertTextAt.
   *  Null when the point doesn't map onto the document (e.g. a window-level
   *  drop outside the editor). */
  textOffsetAtCoords(coords: { left: number; top: number }): number | null;
  setEditable(editable: boolean): void;
  /** Stash the current state (doc + selection + undo stack) under a session
   *  id — call before switching sessions or unmounting. */
  stashState(sessionId: string): void;
  /** Adopt the stashed state for a session (its undo stack comes back with
   *  it). False when nothing is stashed — the caller falls back to setText. */
  restoreState(sessionId: string): boolean;
  destroy(): void;
}

function clipboardHasFiles(e: ClipboardEvent): boolean {
  const cd = e.clipboardData;
  if (!cd) return false;
  if (cd.files.length > 0) return true;
  return Array.from(cd.items).some((item) => item.kind === 'file');
}

// Caret anchor for paragraph-trailing pills. PM appends a separator img +
// trailing <br> when a textblock ends with an inline atom, and Chromium then
// draws the caret on the br's phantom line BELOW the pill. This decoration
// puts a zero-width text span right after such a pill — a real home for the
// caret on the pill's own line (the CSS hides the phantom br). Widgets are
// skipped by PM's DOM parser and absent from the state, so serialization is
// unaffected.
const trailingPillCaretAnchor = new Plugin({
  props: {
    decorations(state) {
      const decos: Decoration[] = [];
      state.doc.forEach((para, paraStart) => {
        const last = para.lastChild;
        if (last && (last.type === composerSchema.nodes.mention || last.type === composerSchema.nodes.attachment || last.type === composerSchema.nodes.quote)) {
          // The end of the paragraph's content (before its closing tag).
          const pos = paraStart + para.nodeSize - 1;
          decos.push(
            Decoration.widget(
              pos,
              () => {
                const span = document.createElement('span');
                span.className = 'mention-caret-anchor';
                span.textContent = '​';
                return span;
              },
              { side: 1, key: `mention-caret-anchor-${pos}` },
            ),
          );
        }
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

// Registry-driven pill error state: an entry carrying an upload error marks
// every pill referencing it with .attachment-error (the registry is
// doc-reconciled, so an errored entry always has a pill). A node decoration
// is the channel — its attrs merge onto the NodeView's dom, so the static
// AttachmentNodeView needs no update() handling, and a cleared error (the
// re-drop retry restarts the upload) unmarks the pill on the same pass.
// Exported for the node tests: the decorations are a pure function of the
// editor state (registry entries × doc pills) — no EditorView needed.
export const attachmentErrorDecorations = new Plugin({
  props: {
    decorations(state) {
      const entries = attachmentRegistryKey.getState(state);
      if (!entries) return null;
      const decos: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type !== composerSchema.nodes.attachment) return true;
        const entry = entries.get((node.attrs as AttachmentAttrs).attId);
        // An entry-less pill is DEAD (its upload metadata is gone for good —
        // e.g. an undo-resurrected pill whose entry the reconcile dropped):
        // mark it missing immediately, or the send gate would close with no
        // visible reason (the tooltip resolver only adds the class on hover).
        if (entry === undefined) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'attachment-missing' }));
        } else if (entry.error !== undefined) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'attachment-error' }));
        }
        return false;
      });
      return decos.length === 0 ? null : DecorationSet.create(state.doc, decos);
    },
  },
});

// Mounted editors by their DOM root. The desktop's native Edit-menu Undo/Redo
// shadows the keydown chord (like Select All) and is forwarded to the renderer
// as a menu action — this is how the handler finds the focused editor.
const viewByDom = new WeakMap<HTMLElement, EditorView>();

// Live composer editors by session — the delivery target for async upload
// outcomes (the composer's patchPillEntry). An upload's completion callback
// belongs to the composer INSTANCE that started it; a question/approval
// unmount destroys that instance, and a remount consumes the stashed state
// — so the outcome can no longer reach the session's editor through the
// callback's own instance or the stash (and the entry would stay `uploading`
// forever, the send gate jammed, the fileId lost). This registry (module-
// local, like the stash) lets the delivery find the editor that CURRENTLY
// holds the session. The latest registration wins; releasing clears only
// the registrant's own token (a newer registration survives).
const liveEditorBySession = new Map<string, { api: ComposerEditorApi; token: unknown }>();

/** Register the live editor holding a session (after mount/restore and on
 *  every session switch). Returns the release — clears the registration
 *  only while this token still owns it. */
export function registerLiveComposerEditor(sessionId: string, api: ComposerEditorApi): () => void {
  const token = {};
  liveEditorBySession.set(sessionId, { api, token });
  return () => {
    if (liveEditorBySession.get(sessionId)?.token === token) {
      liveEditorBySession.delete(sessionId);
    }
  };
}

/** The live editor registered for a session, if any. */
export function liveComposerEditorFor(sessionId: string): ComposerEditorApi | undefined {
  return liveEditorBySession.get(sessionId)?.api;
}

/** Deliver an upload-outcome patch to a pill entry wherever the session's
 *  editor currently lives:
 *  1. the LIVE editor registered for the session (a remount after an
 *     unmount owns it now — the stash is already consumed);
 *  2. the session's stashed editor state (switched away, or the upload
 *     completed while unmounted — the next restore adopts it), mirrored to
 *     the sidecar;
 *  3. the draft sidecar itself (nothing live, nothing stashed — the next
 *     sidecar load heals).
 *  A patch for an attId nobody references anymore is a no-op by
 *  construction (the registry's patch ignores unknown attIds, and the
 *  sidecar fallback finds nothing). DOM-free — node tests drive every
 *  branch. */
export function deliverPillEntryPatch(
  sessionId: string,
  attId: string,
  patch: Parameters<ComposerEditorApi['updateAttachmentEntry']>[1],
  deps: {
    loadEntries: () => AttachmentEntry[];
    saveEntries: (entries: readonly AttachmentEntry[]) => void;
  },
): void {
  const live = liveComposerEditorFor(sessionId);
  if (live) {
    live.updateAttachmentEntry(attId, patch);
    return;
  }
  const stashed = takeEditorState(sessionId);
  if (stashed) {
    const patched = stashed.apply(stashed.tr.setMeta(attachmentRegistryKey, { type: 'patch', attId, patch }));
    stashEditorState(sessionId, patched);
    deps.saveEntries([...(attachmentRegistryKey.getState(patched)?.values() ?? [])]);
    return;
  }
  const entries = deps.loadEntries();
  const index = entries.findIndex((entry) => entry.attId === attId);
  if (index === -1) return;
  entries[index] = { ...entries[index]!, ...patch };
  deps.saveEntries(entries);
}

/** Static renderer for a mention atom: icon + name pill. Purely presentational
 *  (the node is an atom — no editing inside), so no update/select handling. */
class MentionNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = buildMentionPill(node.attrs as MentionAttrs);
  }
}

/** Static renderer for an attachment atom — same presentational contract as
 *  the mention NodeView, built through the shared attachment pill builder. */
class AttachmentNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = buildAttachmentPill(node.attrs as AttachmentAttrs);
  }
}

/** Static renderer for a quote atom — same presentational contract, built
 *  through the shared quote pill builder. */
class QuoteNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = buildQuotePill(node.attrs as QuoteAttrs);
  }
}

// The quote pill's schema toDOM renders only the truncated pill label — the
// editor's own rendering depends on that. The HTML clipboard flavor must
// carry the FULL quote instead, or a rich-text paste target (Google Docs,
// mail) silently drops the excerpt beyond the 24-grapheme label — plus the
// bundled comment (it rides the pill's attrs, invisible in the label), and
// the provenance as a VISIBLE `from: …` header line (the data attribute
// alone gets stripped by most rich-text targets). Line boundaries ride
// `white-space: pre-wrap` (HTML's default white-space would collapse them).
// text/plain carries the same parts via serializeClipboardSlice's degrade.
// Exported for the node tests (spec shape, without a DOM).
export const composerClipboardSerializer = new DOMSerializer(
  {
    ...DOMSerializer.nodesFromSchema(composerSchema),
    quote: (node: PMNode) => {
      const attrs = node.attrs as QuoteAttrs;
      const dataAttrs: Record<string, string> = { class: 'quote-pill', 'data-quote-text': attrs.text, style: 'white-space: pre-wrap' };
      if (typeof attrs.comment === 'string' && attrs.comment.length > 0) dataAttrs['data-quote-comment'] = attrs.comment;
      if (typeof attrs.source === 'string' && attrs.source.length > 0) dataAttrs['data-quote-source'] = attrs.source;
      const header = typeof attrs.source === 'string' && attrs.source.length > 0 ? `from: ${attrs.source}\n` : '';
      const comment = typeof attrs.comment === 'string' && attrs.comment.length > 0 ? `\n${attrs.comment}` : '';
      return ['span', dataAttrs, `${header}${attrs.text}${comment}`];
    },
  },
  DOMSerializer.marksFromSchema(composerSchema),
);

/** Run an Undo/Redo menu command on the composer editor mounted at `dom`
 *  (typically document.activeElement). False when no composer editor is
 *  there — the caller falls back to the browser's native editing undo. */
export function runComposerMenuEdit(dom: HTMLElement, command: 'undo' | 'redo'): boolean {
  const view = viewByDom.get(dom);
  if (!view) return false;
  (command === 'undo' ? undo : redo)(view.state, view.dispatch);
  return true;
}

/** The EditorView mounted on a composer DOM root, if any. */
export function getComposerEditorView(dom: HTMLElement): EditorView | undefined {
  return viewByDom.get(dom);
}

/** Write the composer's clipboard flavors for a copy OR cut event, owning the
 *  ENTIRE clipboard when the selection covers attachment pills: the custom
 *  MIME (only the vault ref of the built flavor — slice JSON + referenced
 *  registry entries stay in-process, see stashComposerFlavor), text/plain
 *  (bare names, see serializeClipboardSlice), and text/html (mirroring PM's
 *  built-in copy: the view's clipboardSerializer on the selection slice).
 *  Owning the whole event is mandatory — returning false after writing the
 *  flavor would let PM's built-in copy/cut handler run clearData() and
 *  re-write only text/html + text/plain, silently dropping the flavor.
 *  Returns false (event untouched) when the selection is empty, has no
 *  attachment, or clipboardData is unavailable — the caller falls back to
 *  PM's built-in copy/cut then. */
function writeComposerClipboard(view: EditorView, event: ClipboardEvent): boolean {
  const { selection } = view.state;
  if (selection.empty || !event.clipboardData) return false;
  const slice = selection.content();
  const copy = buildComposerClipboardCopy(
    slice,
    (attId) => attachmentRegistryKey.getState(view.state)?.get(attId),
  );
  if (!copy) return false;
  const serializer = view.someProp('clipboardSerializer') ?? DOMSerializer.fromSchema(view.state.schema);
  const wrap = document.createElement('div');
  wrap.append(serializer.serializeFragment(slice.content));
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData('text/plain', copy.plain);
  event.clipboardData.setData('text/html', wrap.innerHTML);
  event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, stashComposerFlavor(copy.flavor));
  return true;
}

/** The composer editor's plugin set. Exported for the node tests: the
 *  registry-rebuild semantics of setText are driven through this exact
 *  factory. The registry plugin is recreated per call so its init seeds
 *  from the entries the CALLER passes for THIS state — an EditorState
 *  rebuild can never inherit another (e.g. the mount session's) entry set.
 *  `chrome` is the instance-specific composer-chrome plugin (work-mode pill
 *  / placeholder decoration, workModePill.ts): it closes over the owning
 *  editor's deco state, so it can't be constructed here — the factory slot
 *  keeps it in its proper position on every rebuild. */
export function composerPlugins(initialEntries?: AttachmentEntry[], chrome?: Plugin): Plugin[] {
  return [
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      // macOS line navigation. prosemirror-commands' baseKeymap has NO
      // Cmd-Arrow bindings — it relies on the browser's native
      // moveTo*OfLine, and Chromium's native version gets STUCK on
      // non-editable inline atoms (the pills): caret before a pill never
      // reaches the line end. One paragraph is one line in this doc
      // model, so textblock start/end IS the line boundary. 'Cmd' (not
      // 'Mod') so Ctrl-Arrow word-jump on Windows/Linux is untouched.
      'Cmd-ArrowLeft': selectTextblockStart,
      'Cmd-ArrowRight': selectTextblockEnd,
      'Cmd-Shift-ArrowLeft': extendToTextblock(true),
      'Cmd-Shift-ArrowRight': extendToTextblock(false),
    }),
    // baseKeymap gives Enter/Shift+Enter a paragraph split, Backspace at a
    // paragraph start a join (== deleting the '\n'), etc. The composer's
    // own handleKeyDown runs first (direct props precede plugin keymaps)
    // and decides which keys ever reach these.
    keymap(baseKeymap),
    trailingPillCaretAnchor,
    ...(chrome ? [chrome] : []),
    attachmentErrorDecorations,
    createAttachmentRegistryPlugin({ initialEntries }),
  ];
}

/**
 * Mount a ProseMirror editor inside `host`. The host element carries the
 * composer's `.ph` styling (sizing, colors, placeholder); the PM root
 * (view.dom) is appended into it.
 */
export function createComposerEditor(host: HTMLElement, options: ComposerEditorOptions): ComposerEditorApi {
  let editable = true;

  // The composer chrome (work-mode pill / placeholder) is NOT document
  // content — see workModePill.ts. The deco state lives in this closure (not
  // a plugin field) so setText()'s EditorState rebuild can't reset it; the
  // setters below poke the view with a doc-unchanged transaction, which is
  // enough to re-run the decorations prop.
  const decoState: ComposerDecoState = { pill: null, placeholder: '' };
  const composerChrome = new Plugin({
    props: {
      decorations(state) {
        return buildComposerDecorations(state.doc, decoState, () => options.onWorkModeDismiss?.());
      },
    },
  });

  /** Registry diffing for onRegistryChange: the plugin state is an immutable
   *  Map that keeps its reference when nothing moved, so identity IS the
   *  change signal. */
  const registryEntries = (state: EditorState): AttachmentEntry[] => [
    ...(attachmentRegistryKey.getState(state)?.values() ?? []),
  ];
  const notifyRegistryChange = (before: EditorState, after: EditorState): void => {
    if (attachmentRegistryKey.getState(before) !== attachmentRegistryKey.getState(after)) {
      options.attachments?.onRegistryChange?.(registryEntries(after));
    }
  };

  const view = new EditorView(host, {
    state: EditorState.create({
      schema: composerSchema,
      // Draft restore: mention links revive into pills (see textToDoc).
      doc: textToDoc(options.initialText, { reviveMentions: true }),
      plugins: composerPlugins(options.attachments?.initialEntries, composerChrome),
    }),
    editable: () => editable,
    attributes: {
      // Combobox semantics for the slash/mention menus (the textarea used to
      // carry these); the reactive aria-expanded/-controls/-activedescendant
      // are set by the composer via the `dom` handle.
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      'aria-disabled': 'false',
      spellcheck: 'false',
      autocomplete: 'off',
    },
    dispatchTransaction(tr) {
      const before = view.state;
      const newState = before.apply(tr);
      view.updateState(newState);
      if (tr.docChanged) options.onChange(docToText(newState.doc));
      notifyRegistryChange(before, newState);
    },
    nodeViews: {
      mention: (node) => new MentionNodeView(node),
      attachment: (node) => new AttachmentNodeView(node),
      quote: (node) => new QuoteNodeView(node),
    },
    handleKeyDown: (_view, event) => options.handleKeyDown(event),
    handleDOMEvents: {
      blur: (_view, event) => {
        options.onBlur?.(event);
        return false;
      },
      copy: (view, event) => writeComposerClipboard(view, event),
      // Cut = the same clipboard write PLUS deleting the selection. PM fires
      // cut as its own DOM event (it never routes through `copy`), so
      // without this handler a Cmd+X of a pill selection leaves only PM's
      // built-in text flavors on the clipboard — and the paste then comes
      // back as bare text.
      cut: (view, event) => {
        if (!writeComposerClipboard(view, event)) return false;
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
        return true;
      },
    },
    // Single-newline clipboard contract (see composerTextDoc.ts): pasting
    // keeps consecutive blank lines, copying does not invent extra ones. The
    // serializer is customized so the quote pill's HTML flavor carries the
    // FULL quote text (the schema toDOM renders only the truncated label).
    clipboardSerializer: composerClipboardSerializer,
    clipboardTextParser: (text) => parseClipboardText(text),
    clipboardTextSerializer: (slice) => serializeClipboardSlice(slice),
    handlePaste: (view, event) => {
      // Composer-internal flavor (a copy from a composer or a message bubble
      // that carried attachment pills): restore the pills + registry entries
      // structurally instead of degrading to the bare names of text/plain.
      // The MIME carries only the vault ref — resolveComposerClipboardMime
      // maps it back to the flavor (a v1 full flavor passes through). A
      // vault miss (cross-process, evicted, restarted) or an
      // unparseable/absent flavor falls through to the plain-text path.
      const composerMime = event.clipboardData?.getData(COMPOSER_CLIPBOARD_MIME);
      const composerPayload = composerMime ? resolveComposerClipboardMime(composerMime) : undefined;
      if (composerPayload) {
        const tr = buildAttachmentClipboardPaste(view.state, composerPayload);
        if (tr) {
          event.preventDefault();
          view.dispatch(tr);
          return true;
        }
      }
      // File paste is owned by the document-level upload handler (which still
      // sees the event afterwards via bubbling). Stop PM from inserting
      // anything itself — the schema has no image/file node, so a default
      // paste could only drop in stray alt text / filenames.
      if (clipboardHasFiles(event)) {
        event.preventDefault();
        return true;
      }
      // Rich text (a clipboard with a text/html flavor) must go down the
      // plain-text path like a textarea: PM would otherwise parse the HTML,
      // and with no hard_break/node rules for <div>/<br> the line breaks
      // would be lost. Insert text/plain through the single-newline parser;
      // mention links revive, so a copied pill pastes back as a pill.
      // Attachment links only revive when the registry HOLDS their attId
      // (composer-internal cut/paste of a live pill) — a copied message's
      // submit-time index or any other foreign id degrades to the bare name
      // instead of reviving as a dead pill. The in-process stash (message
      // copy button) is checked first: its text/plain match restores the
      // structured pills instead.
      const plain = event.clipboardData?.getData('text/plain');
      if (plain) {
        event.preventDefault();
        const stashed = takeComposerClipboardFlavor(plain);
        if (stashed) {
          const tr = buildAttachmentClipboardPaste(view.state, stashed);
          if (tr) {
            view.dispatch(tr);
            return true;
          }
        }
        const knownAttIds = new Set(attachmentRegistryKey.getState(view.state)?.keys() ?? []);
        const filtered = degradeForeignAttachmentLinks(plain, knownAttIds);
        view.dispatch(view.state.tr.replaceSelection(parseClipboardText(filtered, { reviveMentions: true })).scrollIntoView());
        return true;
      }
      return false;
    },
    handleDrop: (view, event, _slice, moved) => {
      // File/folder drops are owned by the composer card's drop handler (the
      // event keeps bubbling up to it). Without this, a drag that also
      // carries a text flavor would get its text inserted by PM's default
      // drop handling.
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault();
        return true;
      }
      // Drags of the editor's own selection keep PM's native move behavior.
      if (moved) return false;
      // External rich-text drags (web page / Office) carry text/html alongside
      // text/plain; PM's default drop would parse the HTML and lose line
      // breaks (no hard_break/div rules in the schema). Force the plain-text
      // path, inserted at the drop point — same as a textarea.
      const text = event.dataTransfer?.getData('text/plain');
      if (text) {
        event.preventDefault();
        const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const tr = view.state.tr;
        if (dropPos) tr.setSelection(TextSelection.create(tr.doc, dropPos.pos));
        // Same unknown-attachment degrade as plain-text paste: a foreign
        // attachment link (a copied message's index, a hand-typed link) must
        // not revive as a dead pill and close the send gate.
        const knownAttIds = new Set(attachmentRegistryKey.getState(view.state)?.keys() ?? []);
        const filtered = degradeForeignAttachmentLinks(text, knownAttIds);
        view.dispatch(tr.replaceSelection(parseClipboardText(filtered, { reviveMentions: true })).scrollIntoView());
        return true;
      }
      return false;
    },
  });
  viewByDom.set(view.dom, view);

  // The attachment tooltip singleton resolves pill metadata through this
  // editor's registry (path/size/dead-pill detection). Several registry-backed
  // editors can coexist (the empty-session composer and the docked one): the
  // LATEST registration wins, and destroy releases only THIS editor's
  // registration — an older editor going away can't yank a survivor's
  // resolver.
  const releaseAttachmentTooltipResolver = setAttachmentTooltipResolver((attId) => {
    const entry = attachmentRegistryKey.getState(view.state)?.get(attId);
    if (!entry) return null;
    return { name: entry.name, path: entry.path, size: entry.size, error: entry.error };
  });

  const onCompositionStart = (): void => options.onCompositionStart?.();
  const onCompositionEnd = (): void => options.onCompositionEnd?.();
  view.dom.addEventListener('compositionstart', onCompositionStart);
  view.dom.addEventListener('compositionend', onCompositionEnd);

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
      // EditorView.focus() already focuses with preventScroll AND writes the
      // state selection back to the DOM — plain dom.focus() could restore a
      // stale caret after a programmatic setSelectionRange while unfocused.
      view.focus();
    },

    getText(): string {
      return docToText(view.state.doc);
    },

    setText(text: string, opts?: { entries?: AttachmentEntry[] }): void {
      // Whole-text programmatic replacement matches textarea `.value =`
      // semantics: it is not undoable, and it RESETS the undo stack — Chrome
      // clears a textarea's native undo history on a programmatic value set,
      // so a post-send Cmd+Z must not resurrect the just-sent text. A fresh
      // EditorState gives the history plugin a clean slate; going through
      // updateState (no transaction) also means no onChange.
      // reviveMentions: draft/history text brings its pills back.
      // The registry re-inits from `opts.entries` (default EMPTY) reconciled
      // against the new doc — NEVER from the editor-creation entries. Those
      // belong to the MOUNT session: on a session switch the rebuild runs
      // under the NEW session id, and a shared attId (edit refills use
      // stable 1..N ids, so cross-session collisions are common) would let
      // the old session's fileId into the new session's registry — and the
      // notify below would persist it to the new session's sidecar before
      // the caller re-seeded. Passing the target session's sidecar entries
      // makes the rebuild atomic instead. Callers restoring pill-carrying
      // text without entries re-seed afterwards via upsertAttachmentEntry.
      const before = view.state;
      const doc = textToDoc(text, { reviveMentions: true });
      view.updateState(
        EditorState.create({
          schema: composerSchema,
          doc,
          plugins: composerPlugins(opts?.entries, composerChrome),
          selection: TextSelection.atEnd(doc),
        }),
      );
      notifyRegistryChange(before, view.state);
    },

    insertNewlineAtCaret(): void {
      splitBlock(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
    },

    setWorkMode(spec: WorkModePillSpec | null): void {
      decoState.pill = spec;
      // A doc-unchanged transaction re-runs the decorations prop without
      // firing onChange (dispatchTransaction gates it on tr.docChanged) and
      // without touching the undo stack (no steps).
      view.dispatch(view.state.tr);
    },

    setPlaceholder(text: string): void {
      decoState.placeholder = text;
      view.dispatch(view.state.tr);
    },

    insertMention(attrs: MentionAttrs, range: { start: number; end: number }): void {
      view.dispatch(buildMentionInsertion(view.state, attrs, range));
      view.focus();
    },

    insertTextAt(offset: number, text: string, opts?: { reviveMentions?: boolean }): void {
      // The offset speaks the serialized-text contract (same as
      // selectionStart) — translate, select that point, and insert through
      // the clipboard parser (mention links revive unless the caller opts
      // out). replaceSelection leaves the caret at the end of the inserted
      // content.
      const pos = textOffsetToPos(view.state.doc, offset);
      const tr = view.state.tr;
      tr.setSelection(TextSelection.create(tr.doc, pos));
      view.dispatch(tr.replaceSelection(parseClipboardText(text, { reviveMentions: opts?.reviveMentions ?? true })).scrollIntoView());
    },

    getSkillMentions(): SkillMentionRef[] {
      return collectSkillMentions(view.state.doc);
    },

    insertAttachment(attrs: AttachmentAttrs, pos?: number): void {
      const range = pos === undefined ? undefined : { start: pos, end: pos };
      view.dispatch(buildAttachmentInsertion(view.state, attrs, range));
      view.focus();
    },

    insertQuote(attrs: QuoteAttrs, comment?: string): void {
      view.dispatch(buildQuoteInsertion(view.state, attrs, comment));
      view.focus();
    },

    upsertAttachmentEntry(entry: AttachmentEntry): void {
      view.dispatch(view.state.tr.setMeta(attachmentRegistryKey, { type: 'upsert', entry }));
    },

    updateAttachmentEntry(attId: string, patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>): void {
      view.dispatch(view.state.tr.setMeta(attachmentRegistryKey, { type: 'patch', attId, patch }));
    },

    getAttachmentEntries(): AttachmentEntry[] {
      return registryEntries(view.state);
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
      // setProps re-syncs the contenteditable attribute on the DOM.
      view.setProps({ editable: () => editable });
      // The combobox role stays on the node, so expose the disabled state
      // explicitly (the textarea's `disabled` did this for free).
      view.dom.setAttribute('aria-disabled', String(!next));
    },

    stashState(sessionId: string): void {
      stashEditorState(sessionId, view.state);
    },

    restoreState(sessionId: string): boolean {
      const state = takeEditorState(sessionId);
      if (!state) return false;
      // The stash may come from ANOTHER editor instance (empty-session ↔
      // docked composer swap) — its plugin objects close over that instance's
      // chrome state (work-mode pill / placeholder deco) and callbacks.
      // Reconfigure onto THIS instance's plugins so the pill keeps working;
      // the undo stack survives because history() shares a fixed plugin key.
      // The attachment registry plugin state rides the same mechanism (its
      // PluginKey is fixed too), so session switches need no sidecar
      // round-trip — notify the mirror after the swap.
      const before = view.state;
      view.updateState(state.reconfigure({ plugins: view.state.plugins }));
      notifyRegistryChange(before, view.state);
      return true;
    },

    destroy(): void {
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
      releaseAttachmentTooltipResolver();
      view.destroy();
    },
  };

  // Dev-only debug handle (lets CDP verification drive the editor without
  // touching product surface).
  if (import.meta.env.DEV) {
    const w = window as unknown as { __composerEditors?: ComposerEditorApi[] };
    (w.__composerEditors ??= []).push(api);
  }

  return api;
}
