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
import type { Node as PMNode } from 'prosemirror-model';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { composerSchema, buildMentionInsertion, collectSkillMentions, docToText, inlineRunStartOffset, parseClipboardText, posToTextOffset, serializeClipboardSlice, textOffsetToPos, textToDoc } from './composerTextDoc';
import type { MentionAttrs, SkillMentionRef } from './composerTextDoc';
import { buildMentionPill } from './mentionPill';
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
  /** IME latch hooks — the composer keeps its per-field composition state and
   *  the document-level latch sees the same events via capture. */
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
}

export interface ComposerEditorApi extends TextFieldLike {
  /** The contenteditable root (view.dom) — for focus/activeElement checks. */
  readonly dom: HTMLElement;
  getText(): string;
  /** Replace the whole document (draft load, history recall, submit clear).
   *  Matches textarea `.value =` semantics: does not fire onChange, is not
   *  undoable, and RESETS the undo stack; the caret lands at the end. */
  setText(text: string): void;
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
        if (last && last.type === composerSchema.nodes.mention) {
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

// Mounted editors by their DOM root. The desktop's native Edit-menu Undo/Redo
// shadows the keydown chord (like Select All) and is forwarded to the renderer
// as a menu action — this is how the handler finds the focused editor.
const viewByDom = new WeakMap<HTMLElement, EditorView>();

/** Static renderer for a mention atom: icon + name pill. Purely presentational
 *  (the node is an atom — no editing inside), so no update/select handling. */
class MentionNodeView {
  readonly dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = buildMentionPill(node.attrs as MentionAttrs);
  }
}

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

/**
 * Mount a ProseMirror editor inside `host`. The host element carries the
 * composer's `.ph` styling (sizing, colors, placeholder); the PM root
 * (view.dom) is appended into it.
 */
export function createComposerEditor(host: HTMLElement, options: ComposerEditorOptions): ComposerEditorApi {
  let editable = true;

  const view = new EditorView(host, {
    state: EditorState.create({
      schema: composerSchema,
      // Draft restore: mention links revive into pills (see textToDoc).
      doc: textToDoc(options.initialText, { reviveMentions: true }),
      plugins: [
        history(),
        keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
        // baseKeymap gives Enter/Shift+Enter a paragraph split, Backspace at a
        // paragraph start a join (== deleting the '\n'), etc. The composer's
        // own handleKeyDown runs first (direct props precede plugin keymaps)
        // and decides which keys ever reach these.
        keymap(baseKeymap),
        trailingPillCaretAnchor,
      ],
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
      const newState = view.state.apply(tr);
      view.updateState(newState);
      if (tr.docChanged) options.onChange(docToText(newState.doc));
    },
    nodeViews: {
      mention: (node) => new MentionNodeView(node),
    },
    handleKeyDown: (_view, event) => options.handleKeyDown(event),
    handleDOMEvents: {
      blur: (_view, event) => {
        options.onBlur?.(event);
        return false;
      },
    },
    // Single-newline clipboard contract (see composerTextDoc.ts): pasting
    // keeps consecutive blank lines, copying does not invent extra ones.
    clipboardTextParser: (text) => parseClipboardText(text),
    clipboardTextSerializer: (slice) => serializeClipboardSlice(slice),
    handlePaste: (view, event) => {
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
      const plain = event.clipboardData?.getData('text/plain');
      if (plain) {
        event.preventDefault();
        view.dispatch(view.state.tr.replaceSelection(parseClipboardText(plain, { reviveMentions: true })).scrollIntoView());
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
        view.dispatch(tr.replaceSelection(parseClipboardText(text, { reviveMentions: true })).scrollIntoView());
        return true;
      }
      return false;
    },
  });
  viewByDom.set(view.dom, view);

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

    setText(text: string): void {
      // Whole-text programmatic replacement matches textarea `.value =`
      // semantics: it is not undoable, and it RESETS the undo stack — Chrome
      // clears a textarea's native undo history on a programmatic value set,
      // so a post-send Cmd+Z must not resurrect the just-sent text. A fresh
      // EditorState (same plugin set) gives the history plugin a clean slate;
      // going through updateState (no transaction) also means no onChange.
      // reviveMentions: draft/history text brings its pills back.
      const doc = textToDoc(text, { reviveMentions: true });
      view.updateState(
        EditorState.create({
          schema: composerSchema,
          doc,
          plugins: view.state.plugins,
          selection: TextSelection.atEnd(doc),
        }),
      );
    },

    insertNewlineAtCaret(): void {
      splitBlock(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
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
      view.updateState(state);
      return true;
    },

    destroy(): void {
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
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
