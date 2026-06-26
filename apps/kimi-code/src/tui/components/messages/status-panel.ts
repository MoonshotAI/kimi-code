/**
 * Status report line builder for `/status`.
 *
 * It mirrors `/usage` visual language but keeps runtime status formatting
 * separate from the TUI orchestration layer.
 */

import type { GoalSnapshot, ModelAlias, PermissionMode, ProviderConfig, SessionStatus } from '@moonshot-ai/kimi-code-sdk';

import { PRODUCT_NAME } from '#/constant/app';
import { currentTheme } from '#/tui/theme';
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
  readonly version: string;
  readonly model: string;
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly thinking: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode: boolean;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly availableModels: Record<string, ModelAlias>;
  readonly availableProviders: Record<string, ProviderConfig>;
  readonly status?: SessionStatus;
  readonly statusError?: string;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
  readonly mcpServersSummary?: string | null;
  readonly goal?: GoalSnapshot | null;
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

function formatPermissionMode(permission: PermissionMode, value: Colorize, errorStyle: Colorize): string {
  if (permission === 'yolo') return errorStyle('yolo');
  if (permission === 'auto') return value('auto');
  return value(permission);
}

function formatPlanMode(planMode: boolean, value: Colorize, muted: Colorize): string {
  return planMode ? value('on') : muted('off');
}

function formatSwarmMode(swarmMode: boolean, value: Colorize, muted: Colorize): string {
  return swarmMode ? value('on') : muted('off');
}

function formatGoalStatus(goal: GoalSnapshot | null | undefined): string | undefined {
  if (goal === null || goal === undefined) return undefined;
  // Truncate by Unicode code points so a surrogate pair (e.g. an emoji) is
  // never split in half at the cut boundary.
  const chars = Array.from(goal.objective);
  const objective = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : goal.objective;
  return `${objective} · ${goal.status}`;
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
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);
  const severityToken = (sev: 'ok' | 'warn' | 'danger'): 'error' | 'warning' | 'success' =>
    sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';

  const permission = options.status?.permission ?? options.permissionMode;
  const planMode = options.status?.planMode ?? options.planMode;
  const swarmMode = options.status?.swarmMode ?? options.swarmMode;
  const sessionId = options.sessionId.trim().length > 0 ? options.sessionId : 'none';
  const modelCount = Object.keys(options.availableModels).length;
  const providerCount = Object.keys(options.availableProviders).length;
  const mcpSummary = options.mcpServersSummary?.trim();
  const goalStatus = formatGoalStatus(options.goal);

  const rows: FieldRow[] = [
    { label: 'Model', value: formatModelStatus(options) },
    { label: 'Directory', value: options.workDir },
    { label: 'Permissions', value: formatPermissionMode(permission, value, errorStyle) },
    { label: 'Plan mode', value: formatPlanMode(planMode, value, muted) },
    { label: 'Swarm', value: formatSwarmMode(swarmMode, value, muted) },
    { label: 'Session', value: sessionId },
  ];
  const title = options.sessionTitle?.trim();
  if (title !== undefined && title.length > 0) rows.push({ label: 'Title', value: title });
  if (goalStatus !== undefined) {
    rows.push({ label: 'Goal', value: goalStatus });
  }
  rows.push(
    { label: 'Providers', value: `${providerCount}` },
    { label: 'Models', value: `${modelCount}` },
  );
  if (mcpSummary !== undefined && mcpSummary.length > 0) {
    rows.push({ label: 'MCP servers', value: mcpSummary });
  }
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
    const barColoured = currentTheme.fg(severityToken(ratioSeverity(safeRatio)), bar);
    lines.push(
      `  ${barColoured}  ${value(`${(safeRatio * 100).toFixed(1)}%`.padStart(6, ' '))}  ` +
        muted(`(${formatTokenCount(tokens)} / ${formatTokenCount(maxTokens)})`),
    );
  } else {
    lines.push(`  ${muted('No context window data available.')}`);
  }

  const managedSection = buildManagedUsageReportLines({
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  return lines;
}
