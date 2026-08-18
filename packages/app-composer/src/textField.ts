// packages/app-composer/src/textField.ts
// Structural interface for "the composer's text field" — the subset of the
// textarea API the composer composables actually use. Both the legacy
// <textarea> and the ProseMirror editor adapter (composerEditor.ts) satisfy
// it, so the composables (draft/history/slash/mention) stay agnostic about
// which editing surface is mounted. Selection is expressed in char offsets
// into the serialized plain text.

export interface TextFieldLike {
  /** Selection bounds in char offsets (null when nothing to measure). */
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  focus(options?: FocusOptions): void;
  /**
   * Serialized offset where the caret's inline text run begins — used as the
   * lower bound of the @token scan so it never crosses into a mention pill's
   * serialized form. Optional: the plain textarea has no inline atoms, so it
   * leaves this undefined and the scan runs to the start of the text.
   */
  inlineTextRunStart?(): number | null;
}
