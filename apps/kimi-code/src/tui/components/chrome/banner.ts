import type { Component } from '@moonshot-ai/pi-tui';
import { visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { BannerState } from '#/tui/types';

const PREFIX_STAR = '✦';
const PADDING = ' ';
/**
 * Minimum column count the main text gets next to an inline tag. A long tag
 * (e.g. a full sentence from the remote banner config) can fit on the line
 * yet leave only a sliver for the main text, which then wraps into a narrow,
 * hard-broken column. When that would happen the tag moves onto its own line
 * and the main text uses (nearly) the full width instead.
 */
const MIN_INLINE_MAIN_TEXT_WIDTH = 16;

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
    // Hanging indent aligning with the tag text (right after "✦ ").
    const hangingWidth = visibleWidth(PREFIX_STAR + PADDING);
    // If the inline tag would squeeze the main text into too narrow a column,
    // render the tag on its own line and give the main text the full width.
    const tagOnOwnLine = showTag && width - tagWidth < MIN_INLINE_MAIN_TEXT_WIDTH;
    const inlineTag = showTag && !tagOnOwnLine;
    // Body lines (continuations of the main text) indent to match the first
    // line's main-text column, which starts right after the tag display. When
    // the tag is on its own line, the main text aligns with the tag text.
    const bodyIndent = inlineTag ? ' '.repeat(tagWidth) : tagOnOwnLine ? ' '.repeat(hangingWidth) : '';
    // Descriptive subtext lines (the second line in the design) start at the
    // column after the leading star + space, aligning with the tag text itself.
    const descIndent = showTag ? ' '.repeat(hangingWidth) : '';
    const bodyContentWidth =
      width - (inlineTag ? tagWidth : tagOnOwnLine ? hangingWidth : 0);
    const descContentWidth = width - (showTag ? hangingWidth : 0);

    if (bodyContentWidth <= 0) {
      return [''];
    }

    const mainSegments = this.state.mainText.split('\n');
    const subSegments = this.state.subText ? this.state.subText.split('\n') : [];

    const result: string[] = [];
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
