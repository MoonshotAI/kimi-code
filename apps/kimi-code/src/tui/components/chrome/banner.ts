import type { Component } from '@moonshot-ai/pi-tui';
import { visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { BannerState } from '#/tui/types';

const PREFIX_STAR = '✦';
const PADDING = ' ';

export class BannerComponent implements Component {
  constructor(private readonly state: BannerState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const main = (s: string): string => currentTheme.boldFg('textStrong', s);
    const dim = (s: string): string => currentTheme.fg('textDim', s);

    // Render nothing but the trailing blank if the terminal cannot hold a
    // single visible column.
    if (width < 1) {
      return [''];
    }

    const tagText = this.state.tag ?? '';
    // Do not add a colon/tag suffix here; the caller-provided tag includes its
    // own punctuation/separator.
    const tagLabel = tagText.length > 0 ? `${PREFIX_STAR} ${tagText}` : '';
    const tagStyled = tagLabel.length > 0 ? currentTheme.boldFg('primary', tagLabel) : '';
    const tagDisplay = tagStyled.length > 0 ? tagStyled + PADDING : '';
    const tagWidth = visibleWidth(tagDisplay);
    const showTag = tagWidth > 0 && tagWidth < width;
    // Body lines (continuations of the main text) indent to match the first
    // line's main-text column, which starts right after the tag display.
    const bodyIndent = showTag ? ' '.repeat(tagWidth) : '';
    // Descriptive subtext lines (the second line in the design) start at the
    // column after the leading star + space, aligning with the tag text itself.
    const descIndent = showTag ? ' '.repeat(visibleWidth(PREFIX_STAR + PADDING)) : '';
    const bodyContentWidth = width - (showTag ? tagWidth : 0);
    const descContentWidth = width - (showTag ? visibleWidth(PREFIX_STAR + PADDING) : 0);

    if (bodyContentWidth <= 0) {
      return [''];
    }

    const mainSegments = this.state.mainText.split('\n');
    const subSegments = this.state.subText ? this.state.subText.split('\n') : [];

    const result: string[] = [];
    for (let i = 0; i < mainSegments.length; i++) {
      const wrapped = wrapTextWithAnsi(mainSegments[i]!, bodyContentWidth);
      for (let j = 0; j < wrapped.length; j++) {
        const boldLine = main(wrapped[j]!);
        if (i === 0 && j === 0 && showTag) {
          result.push(tagDisplay + boldLine);
        } else {
          result.push(bodyIndent + boldLine);
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

    // Add a blank line below the banner so the following transcript content
    // (e.g. the input prompt / status messages) is visually separated.
    result.push('');

    return result;
  }
}
