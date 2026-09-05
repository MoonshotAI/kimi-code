import { renderPrompt } from '#/_base/utils/render-prompt';
import { COMPACT_USER_MESSAGE_MAX_TOKENS } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { CompactionBudget } from '#/agent/fullCompaction/fullCompaction';

import compactionAheadTemplate from './compaction-ahead.md?raw';
import contextBudgetTemplate from './context-budget.md?raw';

export const CONTEXT_BUDGET_REMINDER_VARIANT = 'context_budget';
export const COMPACTION_AHEAD_REMINDER_VARIANT = 'compaction_ahead';

export const COMPACTION_AHEAD_LEAD_RATIO = 0.1;

export type ContextBudgetBucket = 'half' | 'three_quarters';

export interface ContextBudgetDisclosure {
  readonly bucket: ContextBudgetBucket;
}

const BUCKET_THRESHOLDS: readonly (readonly [ContextBudgetBucket, number])[] = [
  ['three_quarters', 0.75],
  ['half', 0.5],
];

const WRITE_TOOL_NAMES = new Set(['Write', 'Edit']);
const BASH_TOOL_NAMES = new Set(['Bash']);
const TODO_TOOL_NAMES = new Set(['TodoList', 'SetTodoList']);

export interface CompactionAheadFollowUp {
  readonly stepCount: number;
  readonly writeCallCount: number;
  readonly bashCallCount: number;
  readonly todoCallCount: number;
}

export function contextBudgetBucket(budget: CompactionBudget): ContextBudgetBucket | undefined {
  if (!Number.isFinite(budget.triggerTokens) || budget.triggerTokens <= 0) return undefined;
  const share = budget.used / budget.triggerTokens;
  for (const [bucket, threshold] of BUCKET_THRESHOLDS) {
    if (share >= threshold) return bucket;
  }
  return undefined;
}

export function compactionAheadLeadTokens(budget: CompactionBudget): number {
  return Math.ceil(budget.maxSize * COMPACTION_AHEAD_LEAD_RATIO);
}

export function shouldRemindCompactionAhead(budget: CompactionBudget): boolean {
  if (!Number.isFinite(budget.triggerTokens) || budget.maxSize <= 0) return false;
  if (budget.used >= budget.triggerTokens) return false;
  return budget.triggerTokens - budget.used <= compactionAheadLeadTokens(budget);
}

export function renderContextBudgetReminder(budget: CompactionBudget): string {
  return renderPrompt(contextBudgetTemplate, {
    used_pct: percent(budget.used, budget.maxSize),
    max_k: thousands(budget.maxSize),
    trigger_k: thousands(budget.triggerTokens),
    trigger_pct: percent(budget.triggerTokens, budget.maxSize),
    kept_k: thousands(COMPACT_USER_MESSAGE_MAX_TOKENS),
  }).trimEnd();
}

export function renderCompactionAheadReminder(budget: CompactionBudget): string {
  return renderPrompt(compactionAheadTemplate, {
    used_pct: percent(budget.used, budget.maxSize),
    trigger_pct: percent(budget.triggerTokens, budget.maxSize),
    remaining_k: thousands(Math.max(0, budget.triggerTokens - budget.used)),
    kept_k: thousands(COMPACT_USER_MESSAGE_MAX_TOKENS),
  }).trimEnd();
}

export function isContextBudgetReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' &&
    (message.origin.variant === CONTEXT_BUDGET_REMINDER_VARIANT ||
      message.origin.variant === COMPACTION_AHEAD_REMINDER_VARIANT)
  );
}

export function isCompactionAheadReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === COMPACTION_AHEAD_REMINDER_VARIANT
  );
}

export function summarizeCompactionAheadFollowUp(
  history: readonly ContextMessage[],
): CompactionAheadFollowUp | undefined {
  let reminderIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (isCompactionAheadReminder(history[index]!)) {
      reminderIndex = index;
      break;
    }
  }
  if (reminderIndex < 0) return undefined;

  let stepCount = 0;
  let writeCallCount = 0;
  let bashCallCount = 0;
  let todoCallCount = 0;
  for (const message of history.slice(reminderIndex + 1)) {
    if (message.role !== 'assistant') continue;
    stepCount += 1;
    for (const toolCall of message.toolCalls) {
      if (WRITE_TOOL_NAMES.has(toolCall.name)) writeCallCount += 1;
      else if (BASH_TOOL_NAMES.has(toolCall.name)) bashCallCount += 1;
      else if (TODO_TOOL_NAMES.has(toolCall.name)) todoCallCount += 1;
    }
  }
  return { stepCount, writeCallCount, bashCallCount, todoCallCount };
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function thousands(tokens: number): number {
  return Math.round(tokens / 1000);
}
