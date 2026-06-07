/**
 * Builds the coloured lines for the `/context` slash command — a category
 * breakdown of what fills the model context window, mirroring the layout
 * conventions of the `/usage` panel so the two read consistently.
 */

import type { ContextBreakdown } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
  severityHex,
} from '#/utils/usage/usage-format';
import type { ColorPalette } from '#/tui/theme/colors';

export interface ContextReportOptions {
  readonly colors: ColorPalette;
  readonly breakdown: ContextBreakdown;
}

export function buildContextReportLines(options: ContextReportOptions): string[] {
  const { colors, breakdown } = options;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);

  const max = breakdown.maxContextTokens;
  const total = breakdown.totalTokens;
  const lines: string[] = [accent('Context window')];

  if (breakdown.model.length > 0) {
    lines.push(`  ${muted(breakdown.model)}`);
  }

  if (max > 0) {
    const ratio = safeUsageRatio(total / max);
    const bar = chalk.hex(severityHex(ratioSeverity(ratio), colors))(renderProgressBar(ratio, 20));
    const pct = `${(ratio * 100).toFixed(1)}%`;
    lines.push(
      `  ${bar}  ${value(pct.padStart(6, ' '))}  ` +
        muted(`(${formatTokenCount(total)} / ${formatTokenCount(max)})`),
    );
  } else {
    lines.push(`  ${muted(`${formatTokenCount(total)} tokens (context window unknown)`)}`);
  }

  // Per-category rows. Hide empty categories, but always show free space so
  // the remaining headroom is visible at a glance.
  const rows = breakdown.categories.filter((cat) => cat.tokens > 0 || cat.key === 'freeSpace');
  if (rows.length > 0) {
    lines.push('');
    const labelWidth = Math.max(...rows.map((row) => row.label.length));
    for (const cat of rows) {
      const label = muted(cat.label.padEnd(labelWidth, ' '));
      const tokens = value(formatTokenCount(cat.tokens).padStart(7, ' '));
      const pct =
        max > 0 ? `  ${muted(`${((cat.tokens / max) * 100).toFixed(1)}%`.padStart(6, ' '))}` : '';
      lines.push(`  ${label}  ${tokens}${pct}`);
    }
  }

  return lines;
}
