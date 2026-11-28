import {
  decorateRenderLine,
  RENDER_LINES,
  Text,
  textRenderLine,
  truncateRenderLine,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';

export class IndentedText extends Text {
  private decoratedSource: TuiRenderLine[] | undefined;
  private decoratedLines: TuiRenderLine[] | undefined;
  private decoratedWidth = -1;

  constructor(
    text: string,
    private readonly indent = MESSAGE_INDENT,
  ) {
    super(text, 0, 0);
  }

  override [RENDER_LINES](width: number): TuiRenderLine[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [textRenderLine('')];
    const actualIndentWidth = Math.min(this.indent.length, Math.max(0, safeWidth - 1));
    const actualIndent = this.indent.slice(0, actualIndentWidth);
    const source = super[RENDER_LINES](Math.max(1, safeWidth - actualIndentWidth));
    if (
      source === this.decoratedSource &&
      this.decoratedLines !== undefined &&
      this.decoratedWidth === safeWidth
    ) {
      return this.decoratedLines;
    }
    const lines = source.map((line) =>
      truncateRenderLine(decorateRenderLine(line, actualIndent), safeWidth, '…'),
    );
    this.decoratedSource = source;
    this.decoratedLines = lines;
    this.decoratedWidth = safeWidth;
    return lines;
  }
}
