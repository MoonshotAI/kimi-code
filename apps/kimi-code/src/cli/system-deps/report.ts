/**
 * System-dependency rendering — turns evaluated {@link DependencyStatus} into
 * (1) plain startup-warning strings and (2) a `/status` report section. Kept
 * separate from `check.ts` so the formatting is pure and snapshot-friendly.
 */

import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

import type { DependencyStatus } from './check';

/**
 * One concise warning line per missing dependency that matters right now
 * (shell unavailable, or fd missing outside a git repo). Returned plain so the
 * caller can route each through `showStatus(..., warning)`.
 */
export function startupDependencyWarnings(statuses: readonly DependencyStatus[]): string[] {
  return statuses
    .filter((status) => status.shouldWarnAtStartup)
    .map((status) => `${status.dependency.displayName}: ${status.detail}`);
}

/** A "System dependencies" section for the `/status` report. */
export function buildDependencyReportLines(options: {
  readonly colors: ColorPalette;
  readonly statuses: readonly DependencyStatus[];
}): string[] {
  const { colors, statuses } = options;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);

  const labelWidth = Math.max(...statuses.map((s) => s.dependency.displayName.length));
  const lines: string[] = [accent('System dependencies')];
  for (const status of statuses) {
    const marker = chalk.hex(status.available ? colors.success : colors.warning)('●');
    const label = value(status.dependency.displayName.padEnd(labelWidth, ' '));
    const tag = muted(`(${status.dependency.requirement})`);
    lines.push(`  ${marker} ${label} ${tag}  ${muted(status.detail)}`);
  }
  return lines;
}
