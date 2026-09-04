import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

import {
  SURVEY_MIN_OPTIONS_WIDTH,
  SURVEY_OPTION_GAP,
  SURVEY_OPTION_LABELS,
  SURVEY_QUESTION,
} from '../../constant/survey';

import { currentTheme } from '../../theme';
import type { SurveyResponse } from '../../utils/survey-policy';

export type SurveyPanelPhase = 'open' | 'pending' | 'thanks';

export interface SurveyPanelView {
  phase: SurveyPanelPhase;
  response?: Exclude<SurveyResponse, 'dismissed'>;
  hoverIndex?: number;
}

const DOT = '●';
const DOT_PREFIX_WIDTH = 2;
const OPTION_INDENT = '  ';

const RESPONSE_LABELS: Record<Exclude<SurveyResponse, 'dismissed'>, string> = {
  bad: 'Bad',
  fine: 'Fine',
  good: 'Good',
};
const THANKS = 'Thanks for your feedback!';

export class SurveyPanelComponent implements Component {
  constructor(private readonly view: SurveyPanelView) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return [''];
    switch (this.view.phase) {
      case 'open':
        return this.renderOpen(width);
      case 'pending': {
        const label =
          this.view.response === undefined ? '' : RESPONSE_LABELS[this.view.response];
        return this.renderStatusLine(width, currentTheme.fg('textDim', `Feedback: ${label} · [escape: undo]`));
      }
      case 'thanks':
        return this.renderStatusLine(width, currentTheme.fg('success', THANKS));
    }
  }

  private renderOpen(width: number): string[] {
    const title = wrapTextWithAnsi(SURVEY_QUESTION, Math.max(1, width - DOT_PREFIX_WIDTH)).map(
      (line, index) =>
        (index === 0 ? this.dotPrefix() : ' '.repeat(DOT_PREFIX_WIDTH)) +
        currentTheme.boldFg('textStrong', line),
    );
    const optionsLine = OPTION_INDENT + this.styledOptions();
    if (visibleWidth(optionsLine) <= width) {
      return [...title, optionsLine];
    }
    if (width >= SURVEY_MIN_OPTIONS_WIDTH) {
      return [
        ...title,
        ...this.styledOptionsPerLine().map((option) => OPTION_INDENT + option),
      ];
    }
    return title;
  }

  private renderStatusLine(width: number, styledText: string): string[] {
    return [truncateToWidth(this.dotPrefix() + styledText, width)];
  }

  private dotPrefix(): string {
    return currentTheme.fg('accent', DOT) + ' ';
  }

  private styledOptions(): string {
    return SURVEY_OPTION_LABELS.map((label, index) => this.styleOption(label, index)).join(
      ' '.repeat(SURVEY_OPTION_GAP),
    );
  }

  private styledOptionsPerLine(): string[] {
    return SURVEY_OPTION_LABELS.map((label, index) => this.styleOption(label, index));
  }

  private styleOption(label: string, index: number): string {
    if (this.view.hoverIndex === index) {
      return currentTheme.bg('border', currentTheme.boldFg('textStrong', label));
    }
    return currentTheme.fg('text', label);
  }
}
