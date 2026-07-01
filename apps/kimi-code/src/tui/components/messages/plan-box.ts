/**
 * PlanBoxComponent — renders an ExitPlanMode plan inside a full box
 * border, width-aware. The plan text is parsed as Markdown so headings,
 * lists, bold, inline code etc. render the same way assistant messages do.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Markdown, truncateToWidth, visibleWidth, type Component, type MarkdownTheme } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const LEFT_MARGIN = 2; // two-space indent matching other tool call children
const SIDE_PADDING = 1; // space between the │ and the content on each side
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
  private cachedLines: string[] | undefined;

  constructor(
    plan: string,
    markdownTheme: MarkdownTheme,
    private readonly borderHex: string,
    private readonly planPath?: string,
    opts?: PlanBoxOptions,
  ) {
    // Build the Markdown instance once — pi-tui's Markdown caches its own
    // parse + wrap output keyed on (text, width), so reusing the same
    // instance means repeated render() calls from the parent Container
    // hit the cache instead of re-parsing on every frame.
    this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme);
    this.status = opts?.status;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    if (safeWidth < LEFT_MARGIN + 4) {
      return this.markdown.render(Math.max(1, safeWidth)).map((line) => truncateToWidth(line, safeWidth, '…'));
    }

    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // Box layout: "  ┌──...──┐"
    //             "  │ <content> │"
    //             "  └──...──┘"
    // width = LEFT_MARGIN + 1 + horzLen + 1 ⇒ horzLen = width - 4
    // content width = horzLen - 2 * SIDE_PADDING = width - 6
    const horzLen = Math.max(2, safeWidth - LEFT_MARGIN - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const title = this.buildTitle(horzLen);
    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top =
      indent + paint('┌') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('┐');
    const bottom = indent + paint('└' + '─'.repeat(horzLen) + '┘');

    const rawLines = this.markdown.render(contentWidth);

    const lines: string[] = [top];
    for (const raw of rawLines) {
      const pad = Math.max(0, contentWidth - visibleWidth(raw));
      lines.push(indent + paint('│') + ' ' + raw + ' '.repeat(pad) + ' ' + paint('│'));
    }
    lines.push(bottom);

    const fitted = lines.map((line) => truncateToWidth(line, safeWidth, '…'));
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
