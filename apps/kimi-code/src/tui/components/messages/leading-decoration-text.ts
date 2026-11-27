import {
  RENDER_LINES,
  Text,
  type TuiRenderLine,
  withRenderLineSelectionExclusions,
} from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';

export class LeadingDecorationText extends Text {
  private decoratedSource: TuiRenderLine[] | undefined;
  private decoratedLines: TuiRenderLine[] | undefined;

  constructor(
    text: string,
    paddingX = 0,
    paddingY = 0,
    private readonly decorationWidth = MESSAGE_INDENT.length,
  ) {
    super(text, paddingX, paddingY);
  }

  override [RENDER_LINES](width: number): TuiRenderLine[] {
    const source = super[RENDER_LINES](width);
    if (source === this.decoratedSource && this.decoratedLines !== undefined) {
      return this.decoratedLines;
    }
    const lines = source.length === 0
      ? source
      : [
          withRenderLineSelectionExclusions(source[0]!, [{ start: 0, end: this.decorationWidth }]),
          ...source.slice(1),
        ];
    this.decoratedSource = source;
    this.decoratedLines = lines;
    return lines;
  }
}
