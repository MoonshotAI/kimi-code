import {
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  judgeStickyUserMessage,
  type StickyJudgmentEntry,
  type StickyUserMessageJudgment,
} from '#/tui/utils/sticky-user-message';

export interface StickyUserMessageSource {
  measure(width: number): StickyJudgmentEntry[];
  scrollState(): { scrollTop: number; following: boolean };
  scrollTo(y: number): void;
}

export class StickyUserMessageComponent implements Component {
  private judgment: StickyUserMessageJudgment | null = null;

  constructor(private readonly source: StickyUserMessageSource) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const { scrollTop, following } = this.source.scrollState();
    this.judgment = judgeStickyUserMessage({
      entries: this.source.measure(Math.max(1, safeWidth)),
      scrollTop,
      following,
    });
    if (this.judgment === null || safeWidth <= 0) return [];

    const bullet = currentTheme.boldFg('roleUser', USER_MESSAGE_BULLET);
    const contentWidth = Math.max(1, safeWidth - visibleWidth(bullet));

    const colored = currentTheme.boldFg('roleUser', this.judgment.summary);
    const wrapped = new Text(colored, 0, 0).render(contentWidth);
    let line = (wrapped[0] ?? '').trimEnd();
    if (wrapped.length > 1) {
      line = truncateToWidth(line + TRUNCATION_ELLIPSIS, contentWidth, TRUNCATION_ELLIPSIS);
    }
    return [truncateToWidth(bullet + line, safeWidth, TRUNCATION_ELLIPSIS)];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'click' && event.button === 'left' && this.judgment !== null) {
      this.source.scrollTo(this.judgment.targetY);
      return { handled: true };
    }
    return undefined;
  }
}
