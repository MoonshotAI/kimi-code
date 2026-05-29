/**
 * UsagePanelComponent — wraps pre-coloured `/usage` lines in a blue box
 * border with a left indent, mirroring the PlanBoxComponent layout so
 * the pattern stays consistent across command-triggered panels.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { SessionUsage, TokenUsage } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format';
import type { ColorPalette } from '#/tui/theme/colors';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const MIN_INTERIOR_WIDTH = 20;

type Colorize = (text: string) => string;

export interface ManagedUsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly resetHint?: string;
}

export interface ManagedUsageReport {
  readonly summary: ManagedUsageRow | null;
  readonly limits: readonly ManagedUsageRow[];
}

export interface UsageReportOptions {
  readonly colors: ColorPalette;
  readonly sessionUsage?: SessionUsage;
  readonly sessionUsageError?: string;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

export interface ManagedUsageReportLineOptions {
  readonly colors: ColorPalette;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageInputTotal(usage: TokenUsage): number {
  return (
    usageNumber(usage.inputOther) +
    usageNumber(usage.inputCacheRead) +
    usageNumber(usage.inputCacheCreation)
  );
}

function buildSessionUsageSection(
  usage: SessionUsage | undefined,
  error: string | undefined,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
): string[] {
  if (error !== undefined) return [errorStyle(`  ${error}`)];
  const byModel = (usage as { readonly byModel?: Record<string, TokenUsage> } | undefined)
    ?.byModel;
  const entries = Object.entries(byModel ?? {});
  if (entries.length === 0) return [muted('  No token usage recorded yet.')];

  const lines: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  // Compute max model name width for alignment (include "total" for multi-model)
  const maxModelWidth = Math.max(
    ...entries.map(([model]) => model.length),
    entries.length > 1 ? 'total'.length : 0,
  );
  for (const [model, row] of entries) {
    const input = usageInputTotal(row);
    const output = usageNumber(row.output);
    totalInput += input;
    totalOutput += output;
    const paddedModel = model.padEnd(maxModelWidth);
    lines.push(
      `  ${muted(paddedModel)}  input ${value(formatTokenCount(input))}  output ${value(
        formatTokenCount(output),
      )}  total ${value(formatTokenCount(input + output))}`,
    );
    // Cache breakdown subline
    const cacheIndent = ' '.repeat(maxModelWidth + 4); // "  model  " → 2 + maxModelWidth + 2
    const cacheRatio = input > 0 ? usageNumber(row.inputCacheRead) / input : 0;
    const bar = renderProgressBar(cacheRatio, 20);
    const pct = `${(cacheRatio * 100).toFixed(1).replace(/\.0$/, '')}%`;
    lines.push(
      `${cacheIndent}${muted('cache')} ${bar} ${value(pct)} ${muted('hit')} ` +
        `(${value(formatTokenCount(usageNumber(row.inputCacheRead)))} ${muted('read')} ` +
        `· ${value(formatTokenCount(usageNumber(row.inputOther)))} ${muted('other')})`,
    );
  }
  if (entries.length > 1) {
    const paddedTotal = 'total'.padEnd(maxModelWidth);
    lines.push(
      `  ${muted(paddedTotal)}  input ${value(formatTokenCount(totalInput))}  output ${value(
        formatTokenCount(totalOutput),
      )}  total ${value(formatTokenCount(totalInput + totalOutput))}`,
    );
  }
  return lines;
}

function buildManagedUsageSection(
  usage: ManagedUsageReport | undefined,
  error: string | undefined,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
  severityHex: (sev: 'ok' | 'warn' | 'danger') => string,
): string[] {
  if (error !== undefined) return [accent('Plan usage'), errorStyle(`  ${error}`)];
  if (usage === undefined) return [];
  const { summary, limits } = usage;
  if (summary === null && limits.length === 0) {
    return [accent('Plan usage'), muted('  No usage data available.')];
  }

  const rows: ManagedUsageRow[] = [];
  if (summary !== null) rows.push(summary);
  rows.push(...limits);
  const usedRatio = (r: ManagedUsageRow): number =>
    r.limit > 0 ? Math.max(0, Math.min(r.used / r.limit, 1)) : 0;
  const labelWidth = Math.max(10, ...rows.map((r) => r.label.length));
  const pctWidth = Math.max(...rows.map((r) => `${Math.round(usedRatio(r) * 100)}% used`.length));
  const out: string[] = [accent('Plan usage')];
  for (const row of rows) {
    const ratioUsed = usedRatio(row);
    const bar = renderProgressBar(ratioUsed, 20);
    const pct = `${Math.round(ratioUsed * 100)}% used`;
    const barColoured = chalk.hex(severityHex(ratioSeverity(ratioUsed)))(bar);
    const label = row.label.padEnd(labelWidth, ' ');
    const resetStr = row.resetHint ? `  ${muted(row.resetHint)}` : '';
    out.push(`  ${muted(label)}  ${barColoured}  ${value(pct.padEnd(pctWidth, ' '))}${resetStr}`);
  }
  return out;
}

export function buildManagedUsageReportLines(options: ManagedUsageReportLineOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  return buildManagedUsageSection(
    options.managedUsage,
    options.managedUsageError,
    accent,
    value,
    muted,
    errorStyle,
    severityHex,
  );
}

export function buildUsageReportLines(options: UsageReportOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  const lines: string[] = [
    accent('Session usage'),
    ...buildSessionUsageSection(
      options.sessionUsage,
      options.sessionUsageError,
      value,
      muted,
      errorStyle,
    ),
  ];

  if (options.maxContextTokens > 0) {
    const ratio = safeUsageRatio(options.contextUsage);
    const bar = renderProgressBar(ratio, 20);
    const pct = `${(ratio * 100).toFixed(1)}%`;
    const barColoured = chalk.hex(severityHex(ratioSeverity(ratio)))(bar);
    lines.push('');
    lines.push(accent('Context window'));
    lines.push(
      `  ${barColoured}  ${value(pct.padStart(6, ' '))}  ` +
        muted(
          `(${formatTokenCount(options.contextTokens)} / ${formatTokenCount(
            options.maxContextTokens,
          )})`,
        ),
    );
  }

  const managedSection = buildManagedUsageReportLines({
    colors,
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  return lines;
}

export class UsagePanelComponent implements Component {
  constructor(
    private readonly lines: readonly string[],
    private readonly borderHex: string,
    private readonly title: string = ' Usage ',
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const availableInterior = Math.max(
      MIN_INTERIOR_WIDTH,
      width - LEFT_MARGIN - 2 - 2 * SIDE_PADDING,
    );
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(
      MIN_INTERIOR_WIDTH,
      Math.min(availableInterior, longestLine, Math.max(longestLine, this.title.length)),
    );
    const horzLen = contentWidth + 2 * SIDE_PADDING;

    const trailingDashLen = Math.max(0, horzLen - this.title.length);
    const top =
      indent + paint('╭') + paint(this.title) + paint('─'.repeat(trailingDashLen)) + paint('╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);
    return out;
  }
}
