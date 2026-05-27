/**
 * PlanBoxComponent — renders an ExitPlanMode plan inside a full box
 * border, width-aware. The plan text is parsed as Markdown so headings,
 * lists, bold, inline code etc. render the same way assistant messages do.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const LEFT_MARGIN = 2; // two-space indent matching other tool call children
const SIDE_PADDING = 1; // space between the │ and the content on each side
const TITLE_PREFIX = ' plan: ';
const TITLE_SUFFIX = ' ';

export interface PlanBoxOptions {
  maxContentLines?: number;
  expanded?: boolean;
  status?: {
    readonly label: string;
    readonly colorHex: string;
  };
}

export class PlanBoxComponent implements Component {
  private readonly markdown: Markdown;
  private readonly maxContentLines: number | undefined;
  private readonly expanded: boolean;
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
    this.maxContentLines = opts?.maxContentLines;
    this.expanded = opts?.expanded ?? false;
    this.status = opts?.status;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // Box layout: "  ┌──...──┐"
    //             "  │ <content> │"
    //             "  └──...──┘"
    // width = LEFT_MARGIN + 1 + horzLen + 1 ⇒ horzLen = width - 4
    // content width = horzLen - 2 * SIDE_PADDING = width - 6
    const horzLen = Math.max(2, width - LEFT_MARGIN - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const title = this.buildTitle(horzLen);
    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top =
      indent + paint('┌') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('┐');
    const bottom = indent + paint('└' + '─'.repeat(horzLen) + '┘');

    const rawLines = this.markdown.render(contentWidth);
    const { shown, hiddenCount } = this.capContentLines(rawLines);

    const lines: string[] = [top];
    for (const raw of shown) {
      const pad = Math.max(0, contentWidth - visibleWidth(raw));
      lines.push(indent + paint('│') + ' ' + raw + ' '.repeat(pad) + ' ' + paint('│'));
    }
    if (hiddenCount > 0) {
      const footer = chalk.dim(
        `... (${String(hiddenCount)} more line${hiddenCount === 1 ? '' : 's'}, ctrl+e to expand)`,
      );
      const pad = Math.max(0, contentWidth - visibleWidth(footer));
      lines.push(indent + paint('│') + ' ' + footer + ' '.repeat(pad) + ' ' + paint('│'));
    }
    lines.push(bottom);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private capContentLines(rawLines: string[]): { shown: string[]; hiddenCount: number } {
    const cap = this.maxContentLines;
    if (this.expanded || cap === undefined || rawLines.length <= cap) {
      return { shown: rawLines, hiddenCount: 0 };
    }
    const shownCount = Math.max(0, cap - 1);
    return { shown: rawLines.slice(0, shownCount), hiddenCount: rawLines.length - shownCount };
  }

  private buildTitle(horzLen: number): string {
    const fallback = ' plan ';
    const statusSuffix = this.buildStatusSuffix();
    const fallbackWithStatus = ` plan${statusSuffix} `;
    const budget = horzLen - 1;
    const fallbackTitle = visibleWidth(fallbackWithStatus) <= budget ? fallbackWithStatus : fallback;
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
