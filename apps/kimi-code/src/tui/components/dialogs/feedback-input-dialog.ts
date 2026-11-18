import {
  Container,
  Editor,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TUI,
} from '@moonshot-ai/pi-tui';
import { currentTheme } from '#/tui/theme';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';

export type FeedbackInputDialogResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

const TITLE = 'Send feedback to Kimi Code';
const SUBTITLE_DEFAULT = "Tell us what's working or what's not.";
const SUBTITLE_EMPTY = 'Feedback cannot be empty.';
const FOOTER = 'Enter submit · Shift-Enter/Ctrl-J newline · Esc cancel';
const MIN_FIELD_LINES = 3;

class FeedbackField extends Editor {
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount > 0 ? super.renderTopBorder(width, hiddenLineCount) : '';
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    return hiddenLineCount > 0 ? super.renderBottomBorder(width, hiddenLineCount) : '';
  }
}

export class FeedbackInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input: FeedbackField;
  private readonly onDone: (result: FeedbackInputDialogResult) => void;
  private done = false;
  private emptyHinted = false;

  constructor(tui: TUI, onDone: (result: FeedbackInputDialogResult) => void) {
    super();
    this.onDone = onDone;
    this.input = new FeedbackField(tui, createEditorTheme(), { paddingX: 1 });
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
    this.input.onChange = () => {
      this.emptyHinted = false;
    };
  }

  handleInput(data: string): void {
    if (this.done || isKeyRelease(data)) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const rule = currentTheme.fg('primary', '─'.repeat(safeWidth));
    const title = truncateToWidth(currentTheme.boldFg('primary', ` ${TITLE}`), safeWidth);
    const hint = truncateToWidth(currentTheme.fg('textMuted', ` ${FOOTER}`), safeWidth);
    const subtitleText = this.emptyHinted ? SUBTITLE_EMPTY : SUBTITLE_DEFAULT;
    const subtitle = truncateToWidth(currentTheme.fg('textDim', ` ${subtitleText}`), safeWidth);
    const fieldWidth = Math.max(1, safeWidth - 2);
    const field = this.renderField(fieldWidth).map((line) => truncateToWidth(` ${line}`, safeWidth));

    return [rule, title, hint, '', subtitle, ...field, '', rule].map((line) =>
      truncateToWidth(line, safeWidth),
    );
  }

  private renderField(width: number): string[] {
    if (width < 4) {
      const lines = this.input.render(Math.max(1, width)).slice(1, -1);
      while (lines.length < MIN_FIELD_LINES) lines.push('');
      return lines;
    }

    const editorWidth = width - 2;
    const rendered = this.input.render(editorWidth);
    const hasBorders = rendered.length >= 2;
    const top = hasBorders ? (rendered[0] ?? '') : '';
    const bottom = hasBorders ? (rendered.at(-1) ?? '') : '';
    const body = hasBorders ? rendered.slice(1, -1) : [...rendered];
    while (body.length < MIN_FIELD_LINES) body.push('');

    const paint = (text: string): string => currentTheme.fg('primary', text);
    const row = (line: string): string => {
      const gap = Math.max(0, editorWidth - visibleWidth(line));
      return paint('│') + line + ' '.repeat(gap) + paint('│');
    };
    const cap = (left: string, middle: string, right: string): string =>
      middle.length > 0
        ? paint(left) + middle + paint(right)
        : paint(left + '─'.repeat(editorWidth) + right);
    return [cap('╭', top, '╮'), ...body.map(row), cap('╰', bottom, '╯')];
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.onDone({ kind: 'ok', value: trimmed });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
