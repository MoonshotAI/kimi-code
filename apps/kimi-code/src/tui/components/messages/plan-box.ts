import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decorateRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  textRenderLine,
  truncateRenderLine,
  truncateToWidth,
  visibleWidth,
  withRenderLineSelectionExclusions,
  withRenderLineText,
  type Component,
  type MarkdownTheme,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { Markdown } from '#/tui/components/markdown/markdown';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const TITLE_PREFIX = ' plan: ';
const TITLE_SUFFIX = ' ';

export interface PlanBoxOptions {
  status?: {
    readonly label: string;
    readonly colorHex: string;
  };
}

export class PlanBoxComponent implements Component {
  private readonly markdown: Markdown;
  private readonly status: PlanBoxOptions['status'];
  private cachedWidth: number | undefined;
  private cachedLines: TuiRenderLine[] | undefined;

  constructor(
    plan: string,
    markdownTheme: MarkdownTheme,
    private readonly borderHex: string,
    private readonly planPath?: string,
    opts?: PlanBoxOptions,
  ) {
    this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme, undefined, createMarkdownOptions());
    this.status = opts?.status;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [textRenderLine('')];
    if (safeWidth < LEFT_MARGIN + 4) {
      return renderComponentLines(this.markdown, Math.max(1, safeWidth)).map((line) =>
        truncateRenderLine(line, safeWidth, '…'),
      );
    }

    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const horzLen = Math.max(2, safeWidth - LEFT_MARGIN - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);
    const frameLine = (text: string): TuiRenderLine =>
      withRenderLineSelectionExclusions(textRenderLine(text), [{ start: 0, end: visibleWidth(text) }]);

    const title = this.buildTitle(horzLen);
    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top =
      indent + paint('┌') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('┐');
    const bottom = indent + paint('└' + '─'.repeat(horzLen) + '┘');

    const rawLines = renderComponentLines(this.markdown, contentWidth);

    const lines: TuiRenderLine[] = [frameLine(top)];
    for (const raw of rawLines) {
      const prefixed = decorateRenderLine(raw, indent + paint('│') + ' ');
      const pad = Math.max(0, contentWidth - visibleWidth(raw.text));
      const contentEnd = visibleWidth(prefixed.text);
      const text = truncateToWidth(prefixed.text + ' '.repeat(pad) + ' ' + paint('│'), safeWidth, '…');
      lines.push(
        withRenderLineSelectionExclusions(withRenderLineText(prefixed, text), [
          { start: Math.min(contentEnd, visibleWidth(text)), end: visibleWidth(text) },
        ]),
      );
    }
    lines.push(frameLine(bottom));

    const fitted = lines.map((line) => truncateRenderLine(line, safeWidth, '…'));
    this.cachedWidth = width;
    this.cachedLines = fitted;
    return fitted;
  }

  private buildTitle(horzLen: number): string {
    const fallback = ' plan ';
    const statusSuffix = this.buildStatusSuffix();
    const fallbackWithStatus = ` plan${statusSuffix} `;
    const budget = Math.max(0, horzLen - 1);
    const fallbackTitle = truncateToWidth(
      visibleWidth(fallbackWithStatus) <= budget ? fallbackWithStatus : fallback,
      budget,
      '…',
    );
    const planPath = this.planPath;
    if (planPath === undefined || planPath.length === 0) return fallbackTitle;
    const basename = path.basename(planPath);
    if (basename.length === 0) return fallbackTitle;
    const linked = path.isAbsolute(planPath)
      ? toTerminalHyperlink(basename, pathToFileURL(planPath).href)
      : basename;
    const title = TITLE_PREFIX + linked + statusSuffix + TITLE_SUFFIX;
    if (visibleWidth(title) > budget) return fallbackTitle;
    return title;
  }

  private buildStatusSuffix(): string {
    const status = this.status;
    if (status === undefined || status.label.length === 0) return '';
    return ` · ${chalk.hex(status.colorHex)(status.label)}`;
  }
}
