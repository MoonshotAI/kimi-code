import type { Component } from '@moonshot-ai/pi-tui';
import { visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { BannerState } from '#/tui/types';

const PREFIX_STAR = '✦';
const PADDING = ' ';
const MIN_INLINE_MAIN_TEXT_WIDTH = 16;

export class BannerComponent implements Component {
  constructor(private readonly state: BannerState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const main = (s: string): string => currentTheme.boldFg('textStrong', s);
    const dim = (s: string): string => currentTheme.fg('textDim', s);

    if (width < 1) {
      return [''];
    }

    const tagText = this.state.tag ?? '';
    const tagLabel = tagText.length > 0 ? `${PREFIX_STAR} ${tagText}` : '';
    const tagStyled = tagLabel.length > 0 ? currentTheme.boldFg('primary', tagLabel) : '';
    const tagDisplay = tagStyled.length > 0 ? tagStyled + PADDING : '';
    const tagWidth = visibleWidth(tagDisplay);
    const showTag = tagWidth > 0 && tagWidth < width;
    const hangingWidth = visibleWidth(PREFIX_STAR + PADDING);
    const tagOnOwnLine = showTag && width - tagWidth < MIN_INLINE_MAIN_TEXT_WIDTH;
    const inlineTag = showTag && !tagOnOwnLine;
    const bodyIndent = inlineTag ? ' '.repeat(tagWidth) : tagOnOwnLine ? ' '.repeat(hangingWidth) : '';

    const mainSegments = this.state.mainText === null ? [] : this.state.mainText.split('\n');
    const subSegments = this.state.subText ? this.state.subText.split('\n') : [];
    const titleOnly = mainSegments.length === 0;
    const tagRendered = titleOnly ? tagStyled.length > 0 : showTag;
    const bodyContentWidth =
      width - (inlineTag ? tagWidth : tagOnOwnLine ? hangingWidth : 0);
    const descContentWidth = width - (tagRendered ? hangingWidth : 0);
    const descIndent = tagRendered && descContentWidth > 0 ? ' '.repeat(hangingWidth) : '';

    if (bodyContentWidth <= 0) {
      return [''];
    }

    const result: string[] = [];
    if (titleOnly) {
      if (tagStyled.length > 0) {
        result.push(...wrapTextWithAnsi(tagStyled, width));
      }
    } else {
      if (tagOnOwnLine) {
        result.push(tagStyled);
      }
      for (let i = 0; i < mainSegments.length; i++) {
        const wrapped = wrapTextWithAnsi(mainSegments[i]!, bodyContentWidth);
        for (let j = 0; j < wrapped.length; j++) {
          const boldLine = main(wrapped[j]!);
          if (i === 0 && j === 0 && inlineTag) {
            result.push(tagDisplay + boldLine);
          } else {
            result.push(bodyIndent + boldLine);
          }
        }
      }
    }

    for (const sub of subSegments) {
      const available = descContentWidth <= 0 ? bodyContentWidth : descContentWidth;
      const wrapped = wrapTextWithAnsi(sub, available);
      for (const line of wrapped) {
        result.push(descIndent + dim(line));
      }
    }

    result.push('');

    return result;
  }
}
