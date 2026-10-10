import {
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { StickyUserMessageJudgment } from '#/tui/utils/sticky-user-message';
import { UserMessageComponent } from './user-message';

export class StickyUserMessageComponent implements Component {
  private judgment: StickyUserMessageJudgment | null = null;

  constructor(private readonly scrollTo: (y: number) => void) {}

  setJudgment(judgment: StickyUserMessageJudgment | null): boolean {
    if (
      this.judgment?.component === judgment?.component &&
      this.judgment?.summary === judgment?.summary &&
      this.judgment?.targetY === judgment?.targetY
    ) {
      return false;
    }
    this.judgment = judgment;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (this.judgment === null || safeWidth <= 0) return [];

    const text = this.judgment.component instanceof UserMessageComponent
      ? currentTheme.boldFg('roleUser', USER_MESSAGE_BULLET) +
        this.judgment.component.colorText(this.judgment.summary)
      : currentTheme.boldFg('roleUser', USER_MESSAGE_BULLET + this.judgment.summary);
    return [truncateToWidth(text, safeWidth, TRUNCATION_ELLIPSIS)];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'click' && event.button === 'left' && this.judgment !== null) {
      this.scrollTo(this.judgment.targetY);
      return { handled: true };
    }
    return undefined;
  }
}
