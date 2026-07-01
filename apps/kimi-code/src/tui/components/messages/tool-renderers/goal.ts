import { Text } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { formatTokenCount } from '#/utils/usage/usage-format';

import { formatGoalElapsed, pluralizeGoalCount } from '../goal-format';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

type GoalToolName = 'CreateGoal' | 'GetGoal' | 'SetGoalBudget' | 'UpdateGoal';

interface GoalSnapshotView {
  readonly objective: string;
  readonly status: string;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly terminalReason?: string | undefined;
}

const GOAL_TOOLS = new Set<string>([
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
]);

export function isGoalToolName(toolName: string): toolName is GoalToolName {
  return GOAL_TOOLS.has(toolName);
}

export const goalSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);

  switch (toolCall.name) {
    case 'CreateGoal':
    case 'GetGoal':
      return renderGoalSnapshot(toolCall, result, ctx);
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return [];
    default:
      return renderTruncated(toolCall, result, ctx);
  }
};

export function buildGoalToolHeader(options: {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly bullet: string;
  readonly chip: string;
}): string | undefined {
  const { toolCall, result, bullet, chip } = options;
  if (!isGoalToolName(toolCall.name)) return undefined;

  const tone = result?.is_error === true ? 'error' : 'primary';
  const label = currentTheme.boldFg(tone, goalToolLabel(toolCall.name, result, toolCall.args));
  const marker =
    result !== undefined && result.is_error !== true
      ? currentTheme.fg('primary', STATUS_BULLET)
      : bullet;
  const arg =
    toolCall.name === 'UpdateGoal'
      ? undefined
      : formatGoalToolArgument(toolCall.name, toolCall.args);
  const argText = arg === undefined ? '' : currentTheme.dimFg('textDim', ` (${arg})`);
  return `${marker}${label}${argText}${chip}`;
}

function formatGoalBudgetArg(args: Record<string, unknown>): string | undefined {
  const value = args['value'];
  const unit = args['unit'];
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof unit !== 'string') {
    return undefined;
  }
  if (unit.length === 0) return undefined;
  const normalized = unit === 'turns' || unit === 'tokens'
    ? Math.max(1, Math.round(value))
    : value;
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${String(normalized)} ${normalized === 1 ? singular : unit}`;
}

export function goalStatusChip(output: string): string {
  const goal = parseGoalValue(output);
  if (goal === undefined) return '';
  if (goal === null) return 'no goal';
  return stringField(goal, 'status') ?? '';
}

function renderGoalSnapshot(
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  _ctx: Parameters<ResultRenderer>[2],
) {
  const goal = parseGoalToolOutput(result.output);
  if (goal === undefined) return renderTruncated(toolCall, result, _ctx);

  const muted = (s: string) => currentTheme.dimFg('textDim', s);
  const value = (s: string) => currentTheme.fg('text', s);
  if (goal === null) return [new Text(muted('  No current goal.'), 0, 0)];

  const lines = [
    `  ${value(`Goal ${goal.status}: ${truncateOneLine(goal.objective, 96)}`)}`,
    `    ${muted(formatGoalStats(goal))}`,
  ];
  if (goal.terminalReason !== undefined && goal.terminalReason.length > 0) {
    lines.push(`    ${muted(goal.terminalReason)}`);
  }
  return lines.map((line) => new Text(line, 0, 0));
}

function goalToolLabel(
  toolName: GoalToolName,
  result: ToolResultBlockData | undefined,
  args: Record<string, unknown>,
): string {
  const failed = result?.is_error === true;
  const finished = result !== undefined;
  switch (toolName) {
    case 'CreateGoal':
      return failed ? 'Could not start goal' : finished ? 'Started goal' : 'Starting goal';
    case 'GetGoal':
      return failed ? 'Could not check goal' : finished ? 'Checked goal' : 'Checking goal';
    case 'SetGoalBudget':
      return failed
        ? 'Could not set goal budget'
        : finished
          ? 'Set goal budget'
          : 'Setting goal budget';
    case 'UpdateGoal': {
      const status = stringArg(args, 'status');
      const suffix = status ?? 'status';
      return failed
        ? `Could not report goal ${suffix}`
        : finished
          ? `Reported goal ${suffix}`
          : `Reporting goal ${suffix}`;
    }
  }
}

function formatGoalToolArgument(
  toolName: GoalToolName,
  args: Record<string, unknown>,
): string | undefined {
  switch (toolName) {
    case 'CreateGoal': {
      const objective = stringArg(args, 'objective');
      return objective === undefined ? undefined : truncateOneLine(objective, 60);
    }
    case 'SetGoalBudget':
      return formatGoalBudgetArg(args);
    case 'UpdateGoal':
      return stringArg(args, 'status');
    case 'GetGoal':
      return undefined;
  }
}

function parseGoalToolOutput(output: string): GoalSnapshotView | null | undefined {
  const goal = parseGoalValue(output);
  if (goal === undefined || goal === null) return goal;
  const objective = stringField(goal, 'objective');
  const status = stringField(goal, 'status');
  if (objective === undefined || status === undefined) return undefined;
  return {
    objective,
    status,
    turnsUsed: numberField(goal, 'turnsUsed'),
    tokensUsed: numberField(goal, 'tokensUsed'),
    wallClockMs: numberField(goal, 'wallClockMs'),
    terminalReason: stringField(goal, 'terminalReason'),
  };
}

function parseGoalValue(output: string): Record<string, unknown> | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !('goal' in parsed)) return undefined;
  const goal = parsed['goal'];
  if (goal === null) return null;
  if (!isRecord(goal)) return undefined;
  return goal;
}

function formatGoalStats(goal: GoalSnapshotView): string {
  return [
    pluralizeGoalCount(goal.turnsUsed, 'turn'),
    `${formatTokenCount(goal.tokensUsed)} tokens`,
    formatGoalElapsed(goal.wallClockMs),
  ].join(' · ');
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.replaceAll(/\s+/g, ' ').trim();
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, Math.max(0, max - 1))}…`;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
