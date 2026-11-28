import {
  decorateRenderLine,
  prefixRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Text,
  textRenderLine,
  truncateRenderLine,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import type { TranscriptRowParts } from '#/tui/components/messages/transcript-row-layout';
import { renderHeaderContent } from '#/tui/components/messages/truncated-header-line';
import {
  ANSI_ESCAPE_PATTERN,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { Elapsed } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { elapsedSuffix, shownSeconds, TitleSweep } from './running-title';

const LIVE_LABEL = 'Thinking';
const FINALIZED_FOLD_HINT_ROWS = 1;

export type ThinkingRenderMode = 'live' | 'finalized';

export type FinishedThinkingForm =
  | { readonly kind: 'standalone' }
  | { readonly kind: 'opened'; readonly title: string };

export class ThinkingComponent implements Component {
  readonly startedAtMs = Date.now();

  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private finishedForm: FinishedThinkingForm = { kind: 'standalone' };
  private expanded = false;
  private previewHidesLines = false;
  private readonly ui: TUI | undefined;
  private readonly sweep = new TitleSweep();
  private frameRequest: number | undefined;
  private shownAnimation: string | undefined;
  private elapsed: Elapsed | undefined;
  private projectionVersion = 0;
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: TuiRenderLine[] } | undefined;
  private rowDetailCache: { width: number; lines: TuiRenderLine[] } | undefined;
  private transcriptRowCache: { width: number; parts: TranscriptRowParts } | undefined;
  private transcriptRowDetailCache: { width: number; lines: TuiRenderLine[] } | undefined;

  constructor(
    text: string,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.elapsed = mode === 'live' ? undefined : { known: false };
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (mode === 'live') {
      this.startFrames();
    }
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    this.rowDetailCache = undefined;
    this.transcriptRowCache = undefined;
    this.transcriptRowDetailCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.text));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markRenderDirty();
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  finalize(elapsed: Elapsed): void {
    this.elapsed = elapsed;
    this.projectionVersion += 1;
    this.mode = 'finalized';
    this.markRenderDirty();
    this.stopFrames();
  }

  get thinkingElapsed(): Elapsed | undefined {
    return this.elapsed;
  }

  get transcriptProjectionVersion(): number {
    return this.projectionVersion;
  }

  dispose(): void {
    this.stopFrames();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  setFinishedForm(form: FinishedThinkingForm): void {
    if (sameFinishedForm(this.finishedForm, form)) return;
    this.finishedForm = form;
    this.markRenderDirty();
  }

  hasHiddenContent(): boolean {
    return this.previewHidesLines;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  omitsExpandHint(): boolean {
    return true;
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    if (isRenderCacheEnabled() && this.transcriptRowCache?.width === width) {
      return this.transcriptRowCache.parts;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const bodyLines = this.text.length > 0
      ? renderComponentLines(this.textComponent, contentWidth)
      : [textRenderLine('')];
    const blank = () => textRenderLine('');
    const indent = () => textRenderLine(MESSAGE_INDENT);
    let contentLines: TuiRenderLine[];
    let gutterLines: TuiRenderLine[];

    if (this.mode === 'live') {
      const streamed = withoutTrailingBlankLines(bodyLines);
      this.previewHidesLines = streamed.length > THINKING_PREVIEW_LINES;
      const visibleLines =
        !this.expanded && this.previewHidesLines
          ? streamed.slice(streamed.length - THINKING_PREVIEW_LINES)
          : streamed;
      const paint = this.sweep.painter();
      const title = paint(LIVE_LABEL, visibleWidth(STATUS_BULLET)) +
        elapsedSuffix(this.startedAtMs, Date.now());
      contentLines = [
        blank(),
        truncateRenderLine(
          textRenderLine(title),
          Math.max(0, width - MESSAGE_INDENT.length),
          '…',
        ),
        ...visibleLines,
      ];
      gutterLines = [
        blank(),
        textRenderLine(paint(STATUS_BULLET, 0)),
        ...visibleLines.map(indent),
      ];
    } else if (this.finishedForm.kind === 'opened') {
      this.previewHidesLines = false;
      const visibleLines = withoutTrailingBlankLines(bodyLines);
      contentLines = [
        blank(),
        textRenderLine(openedTitle(
          this.finishedForm.title,
          Math.max(0, width - MESSAGE_INDENT.length),
          '',
        )),
        ...visibleLines,
      ];
      gutterLines = [blank(), indent(), ...visibleLines.map(indent)];
    } else {
      this.previewHidesLines = bodyLines.length > THINKING_PREVIEW_LINES + FINALIZED_FOLD_HINT_ROWS;
      const visibleLines = this.expanded || !this.previewHidesLines
        ? bodyLines
        : bodyLines.slice(0, THINKING_PREVIEW_LINES);
      contentLines = [blank(), ...visibleLines];
      gutterLines = [
        blank(),
        ...visibleLines.map((_, index) => textRenderLine(
          index === 0 && this.showMarker
            ? currentTheme.fg('textDim', STATUS_BULLET)
            : MESSAGE_INDENT,
        )),
      ];
      if (!this.expanded && this.previewHidesLines) {
        const remaining = bodyLines.length - THINKING_PREVIEW_LINES;
        const hint = `… (${String(remaining)} more lines, ctrl+o to expand)`;
        const hintWidth = Math.max(0, width - MESSAGE_INDENT.length);
        contentLines.push(textRenderLine(currentTheme.dim(truncateToWidth(hint, hintWidth, '…'))));
        gutterLines.push(indent());
      }
    }

    const parts = { gutterWidth: MESSAGE_INDENT.length, gutterLines, contentLines };
    if (isRenderCacheEnabled()) {
      this.transcriptRowCache = { width, parts };
    }
    return parts;
  }

  selectionExclusions() {
    return [{ start: 0, end: MESSAGE_INDENT.length }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === width
    ) {
      return this.renderCache.lines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0
      ? renderComponentLines(this.textComponent, contentWidth)
      : [textRenderLine('')];

    let rendered: TuiRenderLine[];
    if (this.mode === 'live') {
      const streamed = withoutTrailingBlankLines(contentLines);
      this.previewHidesLines = streamed.length > THINKING_PREVIEW_LINES;
      const visibleLines =
        !this.expanded && this.previewHidesLines
          ? streamed.slice(streamed.length - THINKING_PREVIEW_LINES)
          : streamed;
      const paint = this.sweep.painter();
      const title =
        paint(STATUS_BULLET, 0) +
        paint(LIVE_LABEL, visibleWidth(STATUS_BULLET)) +
        elapsedSuffix(this.startedAtMs, Date.now());
      rendered = [
        textRenderLine(''),
        truncateRenderLine(textRenderLine(title), width, '…'),
        ...visibleLines.map((line) => prefixRenderLine(line, MESSAGE_INDENT)),
      ];
    } else if (this.finishedForm.kind === 'opened') {
      this.previewHidesLines = false;
      rendered = [
        textRenderLine(''),
        textRenderLine(openedTitle(this.finishedForm.title, width)),
        ...withoutTrailingBlankLines(contentLines).map((line) => prefixRenderLine(line, MESSAGE_INDENT)),
      ];
    } else {
      this.previewHidesLines = contentLines.length > THINKING_PREVIEW_LINES + FINALIZED_FOLD_HINT_ROWS;
      const lines: TuiRenderLine[] = [textRenderLine('')];
      for (let i = 0; i < contentLines.length; i++) {
        const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
        lines.push(prefixRenderLine(contentLines[i]!, p));
      }

      if (this.expanded || !this.previewHidesLines) {
        rendered = lines;
      } else {
        const truncated = lines.slice(0, 1 + THINKING_PREVIEW_LINES);
        const remaining = contentLines.length - THINKING_PREVIEW_LINES;
        const hint = `… (${String(remaining)} more lines, ctrl+o to expand)`;
        const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
        const hintWidth = Math.max(0, width - indentWidth);
        truncated.push(prefixRenderLine(
          textRenderLine(currentTheme.dim(truncateToWidth(hint, hintWidth, '…'))),
          ' '.repeat(indentWidth),
        ));
        rendered = truncated;
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: rendered };
    }
    return rendered;
  }

  renderRowDetail(width: number): TuiRenderLine[] {
    if (isRenderCacheEnabled() && this.rowDetailCache?.width === width) {
      return this.rowDetailCache.lines;
    }
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0
      ? renderComponentLines(this.textComponent, contentWidth)
      : [textRenderLine('')];
    const lines = contentLines.map((line) => decorateRenderLine(line, MESSAGE_INDENT));
    this.rowDetailCache = { width, lines };
    return lines;
  }

  renderTranscriptRowDetail(width: number): TuiRenderLine[] {
    if (isRenderCacheEnabled() && this.transcriptRowDetailCache?.width === width) {
      return this.transcriptRowDetailCache.lines;
    }
    const lines = this.text.length > 0
      ? renderComponentLines(this.textComponent, Math.max(1, width))
      : [textRenderLine('')];
    if (isRenderCacheEnabled()) {
      this.transcriptRowDetailCache = { width, lines };
    }
    return lines;
  }

  private startFrames(): void {
    if (this.ui === undefined || this.frameRequest !== undefined) return;
    this.sweep.start(performance.now(), true);
    this.frameRequest = this.ui.requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (time: number): void => {
    this.sweep.advance(time, visibleWidth(STATUS_BULLET + LIVE_LABEL), true);
    const shown = `${this.sweep.frameKey}|${String(shownSeconds(this.startedAtMs, Date.now()))}`;
    if (shown !== this.shownAnimation) {
      this.shownAnimation = shown;
      this.markRenderDirty();
      this.ui?.requestRender();
    }
    this.frameRequest = this.ui?.requestAnimationFrame(this.onFrame);
  };

  private stopFrames(): void {
    if (this.frameRequest === undefined) return;
    this.ui?.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = undefined;
  }
}

function sameFinishedForm(left: FinishedThinkingForm, right: FinishedThinkingForm): boolean {
  if (left.kind === 'standalone' || right.kind === 'standalone') return left.kind === right.kind;
  return left.title === right.title;
}

function openedTitle(title: string, width: number, head = '  '): string {
  const dim = (text: string): string => currentTheme.fg('textDim', text);
  return renderHeaderContent({
    head,
    flex: { text: title, style: dim, keep: 'head' },
    tail: '',
  }, width);
}

function withoutTrailingBlankLines(lines: readonly TuiRenderLine[]): readonly TuiRenderLine[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1]?.text ?? '').replaceAll(ANSI_ESCAPE_PATTERN, '').trim() === '') end--;
  return lines.slice(0, end);
}
