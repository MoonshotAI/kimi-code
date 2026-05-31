/**
 * Status report line builder for `/status`.
 *
 * It mirrors `/usage` visual language but keeps runtime status formatting
 * separate from the TUI orchestration layer.
 */

import type { ModelAlias, PermissionMode, SessionStatus } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import { PRODUCT_NAME } from '#/constant/app';
import type { ColorPalette } from '#/tui/theme/colors';
import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format';

import { buildManagedUsageReportLines, type ManagedUsageReport } from './usage-panel';

interface FieldRow {
  readonly label: string;
  readonly value: string;
  readonly severity?: 'error';
}

export interface StatusReportOptions {
  readonly colors: ColorPalette;
  readonly version: string;
  readonly model: string;
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly thinking: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly availableModels: Record<string, ModelAlias>;
  readonly status?: SessionStatus;
  readonly statusError?: string;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
}

type Colorize = (text: string) => string;

function displayModelName(alias: string, models: Record<string, ModelAlias>): string {
  const model = models[alias];
  return model?.displayName ?? model?.model ?? alias;
}

function formatModelStatus(options: StatusReportOptions): string {
  const model = options.status?.model ?? options.model;
  if (model.trim().length === 0) return 'not set';

  const thinking = (options.status?.thinkingLevel ?? (options.thinking ? 'on' : 'off')) === 'off'
    ? 'off'
    : 'on';
  return `${displayModelName(model, options.availableModels)} (thinking ${thinking})`;
}

function addFieldRows(
  lines: string[],
  rows: readonly FieldRow[],
  muted: Colorize,
  value: Colorize,
  errorStyle: Colorize,
): void {
  const labelWidth = Math.max(10, ...rows.map((row) => row.label.length));
  for (const row of rows) {
    const colorize = row.severity === 'error' ? errorStyle : value;
    lines.push(`  ${muted(row.label.padEnd(labelWidth, ' '))}  ${colorize(row.value)}`);
  }
}

function contextValues(options: StatusReportOptions): {
  ratio: number;
  tokens: number;
  maxTokens: number;
} {
  return {
    ratio: options.status?.contextUsage ?? options.contextUsage,
    tokens: options.status?.contextTokens ?? options.contextTokens,
    maxTokens: options.status?.maxContextTokens ?? options.maxContextTokens,
  };
}

export function buildStatusReportLines(options: StatusReportOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  const permission = options.status?.permission ?? options.permissionMode;
  const planMode = options.status?.planMode ?? options.planMode;
  const sessionId = options.sessionId.trim().length > 0 ? options.sessionId : 'none';
  const rows: FieldRow[] = [
    { label: 'Model', value: formatModelStatus(options) },
    { label: 'Directory', value: options.workDir },
    { label: 'Permissions', value: permission },
    { label: 'Plan mode', value: planMode ? 'on' : 'off' },
    { label: 'Session', value: sessionId },
  ];
  const goal = options.status?.goal;
  if (goal !== undefined && goal !== null) {
    rows.push({ label: 'Goal', value: goal.status });
  }
  const title = options.sessionTitle?.trim();
  if (title !== undefined && title.length > 0) rows.push({ label: 'Title', value: title });
  if (options.statusError !== undefined) {
    rows.push({ label: 'Warning', value: options.statusError, severity: 'error' });
  }

  const lines: string[] = [
    `${accent(`>_ ${PRODUCT_NAME}`)} ${muted(`(v${options.version})`)}`,
    '',
  ];
  addFieldRows(lines, rows, muted, value, errorStyle);

  const { ratio, tokens, maxTokens } = contextValues(options);
  lines.push('');
  lines.push(accent('Context window'));
  if (maxTokens > 0) {
    const safeRatio = safeUsageRatio(ratio);
    const bar = renderProgressBar(safeRatio, 20);
    const barColoured = chalk.hex(severityHex(ratioSeverity(safeRatio)))(bar);
    lines.push(
      `  ${barColoured}  ${value(`${(safeRatio * 100).toFixed(1)}%`.padStart(6, ' '))}  ` +
        muted(`(${formatTokenCount(tokens)} / ${formatTokenCount(maxTokens)})`),
    );
  } else {
    lines.push(`  ${muted('No context window data available.')}`);
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
