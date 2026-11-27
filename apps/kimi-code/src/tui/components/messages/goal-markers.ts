import {
  decorateRenderLine,
  RENDER_LINES,
  renderLineTexts,
  textRenderLine,
  truncateRenderLine,
  visibleWidth,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';
import type { GoalChange } from '@moonshot-ai/kimi-code-sdk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

import type { TranscriptRowParts } from './transcript-row-layout';

const HEAD_INDENT = '  ';
const DETAIL_INDENT = '    ';

type GoalMarkerActor = 'user' | 'model' | 'runtime' | 'system';

interface GoalMarkerOptions {
  readonly marker?: string;
  readonly textToken?: ColorToken;
  readonly expandable?: boolean;
  readonly indent?: string;
  readonly leadingBlank?: boolean;
}

export class GoalMarkerComponent implements Component {
  private expanded = false;
  private readonly marker: string;
  private readonly textToken: ColorToken;
  private readonly expandable: boolean;
  private readonly indent: string;
  private readonly leadingBlank: boolean;

  constructor(
    private readonly headline: string,
    private readonly detail: string | undefined,
    private readonly accentToken: ColorToken,
    options: GoalMarkerOptions = {},
  ) {
    this.marker = options.marker ?? '◦';
    this.textToken = options.textToken ?? 'textDim';
    this.expandable = options.expandable ?? true;
    this.indent = options.indent ?? HEAD_INDENT;
    this.leadingBlank = options.leadingBlank ?? false;
  }

  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(0, width);
    const dot = currentTheme.fg(this.accentToken, this.marker);
    const head = currentTheme.fg(this.textToken, this.headline);
    const prefix = `${this.indent}${dot} `;
    const gutterWidth = Math.min(visibleWidth(prefix), safeWidth);
    const contentLines: TuiRenderLine[] = [];
    const gutterLines: TuiRenderLine[] = [];
    const gutterWidths: number[] = [];
    if (this.leadingBlank) {
      contentLines.push(textRenderLine(''));
      gutterLines.push(textRenderLine(''));
      gutterWidths.push(0);
    }
    const appendLine = (content: TuiRenderLine, decoration: string): void => {
      const lineGutterWidth = Math.min(visibleWidth(decoration), safeWidth);
      const contentWidth = Math.max(0, safeWidth - lineGutterWidth);
      contentLines.push(
        contentWidth > 0 ? truncateRenderLine(content, contentWidth) : textRenderLine(''),
      );
      gutterLines.push(
        truncateRenderLine(textRenderLine(decoration), lineGutterWidth),
      );
      gutterWidths.push(lineGutterWidth);
    };

    const hasDetail = this.detail !== undefined && this.detail.length > 0;
    if (!hasDetail || !this.expandable) {
      appendLine(textRenderLine(head), prefix);
    } else if (!this.expanded) {
      const text = `${head} ${currentTheme.fg('textMuted', '(ctrl+o)')}`;
      appendLine(textRenderLine(text), prefix);
    } else {
      appendLine(textRenderLine(head), prefix);
      const detailLines = wrap(this.detail!, Math.max(1, width - DETAIL_INDENT.length));
      for (let i = 0; i < detailLines.length; i += 1) {
        const text = currentTheme.fg('textDim', detailLines[i]!);
        appendLine(
          {
            text,
            softWrap: [
              {
                logicalLineId: 0,
                start: 0,
                end: visibleWidth(text),
                ...(i === 0
                  ? {}
                  : { continuation: { omittedWhitespace: ' ', generatedIndent: 0 } }),
              },
            ],
          },
          DETAIL_INDENT,
        );
      }
    }
    return { gutterWidth, gutterWidths, gutterLines, contentLines };
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  hasHiddenContent(): boolean {
    return this.expandable && this.detail !== undefined && this.detail.length > 0;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  omitsExpandHint(): boolean {
    return true;
  }

  selectionExclusions() {
    return [{ start: 0, end: visibleWidth(this.indent) + visibleWidth(this.marker) + 1 }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const dot = currentTheme.fg(this.accentToken, this.marker);
    const head = currentTheme.fg(this.textToken, this.headline);
    const prefix = `${this.indent}${dot} `;
    const hasDetail = this.detail !== undefined && this.detail.length > 0;
    if (!hasDetail) {
      return this.clampToWidth([decorateRenderLine(textRenderLine(head), prefix)], width);
    }

    if (!this.expandable) {
      return this.clampToWidth([decorateRenderLine(textRenderLine(head), prefix)], width);
    }
    if (!this.expanded) {
      const text = `${head} ${currentTheme.fg('textMuted', '(ctrl+o)')}`;
      return this.clampToWidth([decorateRenderLine(textRenderLine(text), prefix)], width);
    }
    const out = [decorateRenderLine(textRenderLine(head), prefix)];
    const wrapWidth = Math.max(1, width - DETAIL_INDENT.length);
    const detailLines = wrap(this.detail!, wrapWidth);
    for (let i = 0; i < detailLines.length; i += 1) {
      const text = currentTheme.fg('textDim', detailLines[i]!);
      out.push(
        decorateRenderLine(
          {
            text,
            softWrap: [
              {
                logicalLineId: 0,
                start: 0,
                end: visibleWidth(text),
                ...(i === 0
                  ? {}
                  : { continuation: { omittedWhitespace: ' ', generatedIndent: 0 } }),
              },
            ],
          },
          DETAIL_INDENT,
        ),
      );
    }
    return this.clampToWidth(out, width);
  }

  private clampToWidth(lines: TuiRenderLine[], width: number): TuiRenderLine[] {
    const withBlank = this.withLeadingBlank(lines);
    if (width <= 0) return withBlank.map(() => textRenderLine(''));
    return withBlank.map((line) => truncateRenderLine(line, width));
  }

  private withLeadingBlank(lines: TuiRenderLine[]): TuiRenderLine[] {
    return this.leadingBlank ? [textRenderLine(''), ...lines] : lines;
  }
}

export function buildGoalMarker(
  change: GoalChange,
  expanded: boolean,
  actor?: GoalMarkerActor,
): GoalMarkerComponent | null {
  const spec = markerSpec(change, actor);
  if (spec === null) return null;
  const marker = new GoalMarkerComponent(
    spec.headline,
    spec.detail ?? change.reason,
    spec.accentToken,
    spec.options,
  );
  marker.setExpanded(expanded);
  return marker;
}

function markerSpec(
  change: GoalChange,
  actor?: GoalMarkerActor,
): {
  headline: string;
  accentToken: ColorToken;
  detail?: string | undefined;
  options?: GoalMarkerOptions | undefined;
} | null {
  if (change.kind === 'lifecycle') {
    switch (change.status) {
      case 'paused':
        return prominentMarker(pausedHeadline(change.reason, actor), 'warning');
      case 'active':
        return prominentMarker(resumedHeadline(actor), 'primary');
      case 'blocked':
        return { headline: 'Goal blocked', accentToken: 'warning' };
      default:
        return null;
    }
  }
  return null;
}

function prominentMarker(headline: string, accentToken: ColorToken) {
  return {
    headline,
    accentToken,
    detail: undefined,
    options: {
      marker: STATUS_BULLET.trimEnd(),
      textToken: accentToken,
      expandable: false,
      indent: '',
      leadingBlank: true,
    },
  };
}

function pausedHeadline(reason: string | undefined, actor: GoalMarkerActor | undefined): string {
  if (reason === 'Paused after interruption') return "Goal paused due to user's interruption";
  if (actor === 'user') return 'Goal paused by the user.';
  if (reason?.startsWith('Paused ') === true) return `Goal ${lowercaseFirst(reason)}`;
  if (reason !== undefined && reason.length > 0) return `Goal paused: ${reason}`;
  if (actor === 'model') return 'Goal paused by the agent.';
  return 'Goal paused';
}

function resumedHeadline(actor: GoalMarkerActor | undefined): string {
  if (actor === 'user') return 'Goal resumed by the user.';
  if (actor === 'model') return 'Goal resumed by the agent.';
  return 'Goal resumed';
}

function lowercaseFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

function wrap(text: string, width: number): string[] {
  const words = text.replaceAll(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
