/**
 * UsagePanelComponent — wraps pre-coloured `/usage` lines in a blue box
 * border with a left indent, mirroring the PlanBoxComponent layout so
 * the pattern stays consistent across command-triggered panels.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import type { SessionUsage, TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const BOX_OVERHEAD = LEFT_MARGIN + 2 + 2 * SIDE_PADDING;

type Colorize = (text: string) => string;

export interface ManagedUsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly resetHint?: string;
}

export interface BoosterWalletInfo {
  readonly balanceCents: number;
  readonly totalCents: number;
  readonly monthlyChargeLimitEnabled: boolean;
  readonly monthlyChargeLimitCents: number;
  readonly monthlyUsedCents: number;
  readonly currency: string;
}

export interface ManagedUsageReport {
  readonly summary: ManagedUsageRow | null;
  readonly limits: readonly ManagedUsageRow[];
  readonly extraUsage?: BoosterWalletInfo | null;
}

export interface UsageReportOptions {
  readonly sessionUsage?: SessionUsage;
  readonly sessionUsageError?: string;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

export interface ManagedUsageReportLineOptions {
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
  for (const [model, row] of entries) {
    const input = usageInputTotal(row);
    const output = usageNumber(row.output);
    totalInput += input;
    totalOutput += output;
    lines.push(
      `  ${muted(model)}  input ${value(formatTokenCount(input))}  output ${value(
        formatTokenCount(output),
      )}  total ${value(formatTokenCount(input + output))}`,
    );
  }
  if (entries.length > 1) {
    lines.push(
      `  ${muted('total')}  input ${value(formatTokenCount(totalInput))}  output ${value(
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
    const barColoured = currentTheme.fg(severityColor(ratioSeverity(ratioUsed)), bar);
    const label = row.label.padEnd(labelWidth, ' ');
    const resetStr = row.resetHint ? `  ${muted(row.resetHint)}` : '';
    out.push(`  ${muted(label)}  ${barColoured}  ${value(pct.padEnd(pctWidth, ' '))}${resetStr}`);
  }
  return out;
}

function severityColor(sev: 'ok' | 'warn' | 'danger'): 'success' | 'warning' | 'error' {
  return sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';
}

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥';
    case 'USD':
      return '$';
    default:
      return '';
  }
}

interface CurrencyParts {
  readonly symbol: string;
  readonly number: string;
}

function formatCurrencyParts(cents: number, currency: string): CurrencyParts {
  const symbol = currencySymbol(currency);
  const main = cents / 100;
  const formatted = main.toFixed(2);
  return symbol.length > 0
    ? { symbol, number: formatted }
    : { symbol: '', number: `${formatted} ${currency}` };
}

export function buildExtraUsageSection(
  extraUsage: BoosterWalletInfo | undefined | null,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
): string[] {
  if (extraUsage === undefined || extraUsage === null) return [];

  const hasMonthlyLimit =
    extraUsage.monthlyChargeLimitEnabled && extraUsage.monthlyChargeLimitCents > 0;

  const balance = formatCurrencyParts(extraUsage.balanceCents, extraUsage.currency);
  const used = formatCurrencyParts(extraUsage.monthlyUsedCents, extraUsage.currency);
  const rows: Array<{ label: string; symbol: string; number: string }> = [];
  let barLine: string | null = null;

  if (hasMonthlyLimit) {
    const ratio = Math.max(
      0,
      Math.min(extraUsage.monthlyUsedCents / extraUsage.monthlyChargeLimitCents, 1),
    );
    const bar = renderProgressBar(ratio, 20);
    barLine = `  ${currentTheme.fg(severityColor(ratioSeverity(ratio)), bar)}`;
    const limit = formatCurrencyParts(extraUsage.monthlyChargeLimitCents, extraUsage.currency);
    rows.push({ label: 'Used this month', ...used });
    rows.push({ label: 'Monthly limit', ...limit });
    rows.push({ label: 'Balance', ...balance });
  } else {
    rows.push({ label: 'Used this month', ...used });
    rows.push({ label: 'Monthly limit', symbol: '', number: 'Unlimited' });
    rows.push({ label: 'Balance', ...balance });
  }

  // `Used this month` is the longest label; size the column to the widest label
  // so the currency symbol starts in the same column on every row.
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  // Right-align the numeric part of currency rows against each other so the
  // decimal points line up (e.g. `¥ 50.00` / `¥200.00`). Text-only rows such as
  // `Unlimited` carry no currency symbol, so they must not widen the numeric
  // column — otherwise money values get padded with stray spaces.
  const numberWidth = Math.max(
    0,
    ...rows.filter((r) => r.symbol.length > 0).map((r) => visibleWidth(r.number)),
  );
  const row = (label: string, symbol: string, number: string): string => {
    const cell = symbol.length > 0 ? symbol + number.padStart(numberWidth, ' ') : number;
    return `  ${muted(label.padEnd(labelWidth, ' '))}  ${value(cell)}`;
  };

  const lines: string[] = [accent('Extra Usage')];
  if (barLine !== null) lines.push(barLine);
  for (const r of rows) lines.push(row(r.label, r.symbol, r.number));

  return lines;
}

export function buildManagedUsageReportLines(options: ManagedUsageReportLineOptions): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);

  return buildManagedUsageSection(
    options.managedUsage,
    options.managedUsageError,
    accent,
    value,
    muted,
    errorStyle,
  );
}

export function buildUsageReportLines(options: UsageReportOptions): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);

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
    const barColoured = currentTheme.fg(severityColor(ratioSeverity(ratio)), bar);
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
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  const extraSection = buildExtraUsageSection(
    options.managedUsage?.extraUsage,
    accent,
    value,
    muted,
  );
  if (extraSection.length > 0) {
    lines.push('');
    lines.push(...extraSection);
  }

  return lines;
}

export class UsagePanelComponent implements Component {
  /** Cached coloured lines; rebuilt from `buildLines` on every invalidate. */
  private lines: readonly string[];

  constructor(
    private readonly buildLines: () => readonly string[],
    private readonly borderToken: ColorToken,
    private readonly title: string = ' Usage ',
  ) {
    this.lines = buildLines();
  }

  invalidate(): void {
    // Report bodies embed palette colours, so a theme switch must re-run the
    // builder to repaint the cached lines (the data itself is captured).
    this.lines = this.buildLines();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const paint = (s: string): string => currentTheme.fg(this.borderToken, s);
    const availableInterior = safeWidth - BOX_OVERHEAD;
    if (availableInterior < 1) {
      return [
        truncateToWidth(this.title.trim(), safeWidth, '…'),
        ...this.lines.map((line) => truncateToWidth(line, safeWidth, '…')),
      ];
    }

    const indent = ' '.repeat(LEFT_MARGIN);
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(
      1,
      Math.min(availableInterior, Math.max(longestLine, visibleWidth(this.title))),
    );
    const horzLen = contentWidth + 2 * SIDE_PADDING;
    const title = truncateToWidth(this.title, horzLen, '…');

    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top =
      indent + paint('╭') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);
    return out.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
