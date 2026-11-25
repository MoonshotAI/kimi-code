import {
  Editor,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import { normalizeCapsLockedCtrl } from '#/tui/components/editor/custom-editor';
import { currentTheme } from '#/tui/theme';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';
import {
  focusOnUnfocusedClick,
  forwardEmbeddedMouse,
  type EmbeddedRect,
} from '#/tui/utils/mouse-regions';

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

export class FeedbackInputDialogComponent implements Component, Focusable {
  focused = false;

  private readonly input: FeedbackField;
  private readonly onDone: (result: FeedbackInputDialogResult) => void;
  private done = false;
  private emptyHinted = false;
  private fieldRect: EmbeddedRect | undefined;

  constructor(tui: TUI, onDone: (result: FeedbackInputDialogResult) => void) {
    this.onDone = onDone;
    this.input = new FeedbackField(tui, createEditorTheme(), { paddingX: 1, wheelScroll: true });
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
    this.input.onChange = () => {
      this.emptyHinted = false;
    };
  }

  handleInput(data: string): void {
    const key = normalizeCapsLockedCtrl(data);
    if (this.done || isKeyRelease(key)) return;
    if (
      matchesKey(key, Key.escape) ||
      matchesKey(key, Key.ctrl('c')) ||
      matchesKey(key, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    this.input.handleInput(key);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done) return undefined;
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    const forwarded = forwardEmbeddedMouse(this.input, this.fieldRect, event);
    if (forwarded !== undefined) return forwarded;
    if (event.type === 'wheel') return { handled: true };
    return undefined;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    this.input.focused = this.focused && !this.done;
    this.fieldRect = undefined;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const rule = currentTheme.fg('primary', '─'.repeat(safeWidth));
    const title = truncateToWidth(currentTheme.boldFg('primary', ` ${TITLE}`), safeWidth);
    const hint = truncateToWidth(currentTheme.fg('textMuted', ` ${FOOTER}`), safeWidth);
    const subtitleText = this.emptyHinted ? SUBTITLE_EMPTY : SUBTITLE_DEFAULT;
    const subtitle = truncateToWidth(currentTheme.fg('textDim', ` ${subtitleText}`), safeWidth);
    const header = [rule, title, hint, '', subtitle];
    const fieldWidth = Math.max(1, safeWidth - 2);
    const field = this.renderField(fieldWidth, header.length, safeWidth).map((line) =>
      truncateToWidth(` ${line}`, safeWidth),
    );

    return [...header, ...field, '', rule].map((line) => truncateToWidth(line, safeWidth));
  }

  private renderField(width: number, startRow: number, safeWidth: number): string[] {
    if (width < 4) {
      const editorWidth = Math.max(1, width);
      const lines = this.input.render(editorWidth).slice(1, -1);
      while (lines.length < MIN_FIELD_LINES) lines.push('');
      const visibleEditorWidth = Math.min(editorWidth, Math.max(0, safeWidth - 1));
      this.fieldRect =
        visibleEditorWidth > 0
          ? {
              x: 1,
              y: startRow,
              width: visibleEditorWidth,
              height: lines.length,
              contentOffsetX: 0,
              contentOffsetY: 1,
            }
          : undefined;
      return lines;
    }

    const editorWidth = width - 2;
    const rendered = this.input.render(editorWidth);
    const hasBorders = rendered.length >= 2;
    const top = hasBorders ? (rendered[0] ?? '') : '';
    const bottom = hasBorders ? (rendered.at(-1) ?? '') : '';
    const body = hasBorders ? rendered.slice(1, -1) : [...rendered];
    while (body.length < MIN_FIELD_LINES) body.push('');
    this.fieldRect = {
      x: 2,
      y: startRow,
      width: editorWidth,
      height: body.length + 2,
      contentOffsetX: 0,
      contentOffsetY: 0,
    };

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
