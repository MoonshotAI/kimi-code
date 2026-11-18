
export interface TextFieldLike {
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  focus(options?: FocusOptions): void;
  inlineTextRunStart?(): number | null;
}
