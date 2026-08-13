// packages/app-client/src/lib/textField.ts
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
}
