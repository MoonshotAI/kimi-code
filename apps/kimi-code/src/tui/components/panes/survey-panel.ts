import type { RatingResponse } from '@moonshot-ai/kimi-code-product/session-rating';
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';

import {
  renderInlineSegments,
  SpanHitMap,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';

import {
  SURVEY_MIN_OPTIONS_WIDTH,
  SURVEY_OPTION_GAP,
  SURVEY_OPTION_LABELS,
  SURVEY_QUESTION,
} from '../../constant/survey';

import { currentTheme } from '../../theme';

export type SurveyPanelPhase = 'open' | 'pending' | 'thanks';

export interface SurveyPanelView {
  phase: SurveyPanelPhase;
  response?: RatingResponse;
  hoverIndex?: number;
}

export interface SurveyPanelCallbacks {
  readonly onSelectOption?: (index: number) => void;
  readonly onUndo?: () => void;
}

type SurveyHitTarget = number | 'undo';

const DOT = '●';
const DOT_PREFIX_WIDTH = 2;
const OPTION_INDENT = '  ';

const RESPONSE_LABELS: Record<RatingResponse, string> = {
  bad: 'Bad',
  fine: 'Fine',
  good: 'Good',
};
const THANKS = 'Thanks for your feedback!';

export class SurveyPanelComponent implements Component {
  private readonly hits = new SpanHitMap<SurveyHitTarget>();

  constructor(
    private readonly view: SurveyPanelView,
    private readonly callbacks?: SurveyPanelCallbacks,
  ) {}

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.hits.handle(event, {
      settling: false,
      onActivate: (target) => {
        if (target === 'undo') {
          this.callbacks?.onUndo?.();
          return;
        }
        this.callbacks?.onSelectOption?.(target);
      },
    });
  }

  render(width: number): string[] {
    this.hits.reset();
    if (width < 1) return [''];
    switch (this.view.phase) {
      case 'open':
        return this.renderOpen(width);
      case 'pending':
        return this.renderPending(width);
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
    const gap = ' '.repeat(SURVEY_OPTION_GAP);
    const wideSegments: InlineSegment<SurveyHitTarget>[] = [{ text: OPTION_INDENT }];
    for (let index = 0; index < SURVEY_OPTION_LABELS.length; index++) {
      if (index > 0) wideSegments.push({ text: gap });
      wideSegments.push({
        text: this.styleOption(SURVEY_OPTION_LABELS[index]!, index),
        value: index,
      });
    }
    const wideWidth = wideSegments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
    if (wideWidth <= width) {
      const rendered = renderInlineSegments(wideSegments, width);
      this.hits.addRow(title.length, rendered.targets);
      return [...title, rendered.line];
    }
    if (width >= SURVEY_MIN_OPTIONS_WIDTH) {
      const optionLines: string[] = [];
      for (let index = 0; index < SURVEY_OPTION_LABELS.length; index++) {
        const rendered = renderInlineSegments<SurveyHitTarget>(
          [
            { text: OPTION_INDENT },
            { text: this.styleOption(SURVEY_OPTION_LABELS[index]!, index), value: index },
          ],
          width,
        );
        this.hits.addRow(title.length + index, rendered.targets);
        optionLines.push(rendered.line);
      }
      return [...title, ...optionLines];
    }
    return title;
  }

  private renderPending(width: number): string[] {
    const label =
      this.view.response === undefined ? '' : RESPONSE_LABELS[this.view.response];
    const rendered = renderInlineSegments<SurveyHitTarget>(
      [
        { text: this.dotPrefix() },
        { text: currentTheme.fg('textDim', `Feedback: ${label} · `) },
        { text: currentTheme.fg('textDim', '[escape: undo]'), value: 'undo' },
      ],
      width,
    );
    this.hits.addRow(0, rendered.targets);
    return [rendered.line];
  }

  private renderStatusLine(width: number, styledText: string): string[] {
    return [truncateToWidth(this.dotPrefix() + styledText, width)];
  }

  private dotPrefix(): string {
    return currentTheme.fg('accent', DOT) + ' ';
  }

  private styleOption(label: string, index: number): string {
    if (this.view.hoverIndex === index) {
      return currentTheme.bg('border', currentTheme.boldFg('textStrong', label));
    }
    return currentTheme.fg('text', label);
  }
}
