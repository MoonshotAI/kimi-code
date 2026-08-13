// packages/app-client/src/lib/composerEditor.ts
// ProseMirror editing surface for the composer. Owns the EditorView and
// exposes the TextFieldLike char-offset contract the composer composables
// already speak, so swapping a <textarea> for this is invisible to them.
//
// Phase-0 scope: the doc model is plain text with paragraphs (see
// composerTextDoc.ts) — no marks, no custom nodes — and the component boundary
// stays "plain text in, plain text out" via onChange / setText.
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { composerSchema, docToText, parseClipboardText, posToTextOffset, serializeClipboardSlice, textOffsetToPos, textToDoc } from './composerTextDoc';
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

// Mounted editors by their DOM root. The desktop's native Edit-menu Undo/Redo
// shadows the keydown chord (like Select All) and is forwarded to the renderer
// as a menu action — this is how the handler finds the focused editor.
const viewByDom = new WeakMap<HTMLElement, EditorView>();

/** Run an Undo/Redo menu command on the composer editor mounted at `dom`
 *  (typically document.activeElement). False when no composer editor is
 *  there — the caller falls back to the browser's native editing undo. */
export function runComposerMenuEdit(dom: HTMLElement, command: 'undo' | 'redo'): boolean {
  const view = viewByDom.get(dom);
  if (!view) return false;
  (command === 'undo' ? undo : redo)(view.state, view.dispatch);
  return true;
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
      doc: textToDoc(options.initialText),
      plugins: [
        history(),
        keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
        // baseKeymap gives Enter/Shift+Enter a paragraph split, Backspace at a
        // paragraph start a join (== deleting the '\n'), etc. The composer's
        // own handleKeyDown runs first (direct props precede plugin keymaps)
        // and decides which keys ever reach these.
        keymap(baseKeymap),
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
    handleKeyDown: (_view, event) => options.handleKeyDown(event),
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
      // would be lost. Insert text/plain through the single-newline parser.
      const plain = event.clipboardData?.getData('text/plain');
      if (plain) {
        event.preventDefault();
        view.dispatch(view.state.tr.replaceSelection(parseClipboardText(plain)).scrollIntoView());
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
        view.dispatch(tr.replaceSelection(parseClipboardText(text)).scrollIntoView());
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
      const doc = textToDoc(text);
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

  return api;
}
