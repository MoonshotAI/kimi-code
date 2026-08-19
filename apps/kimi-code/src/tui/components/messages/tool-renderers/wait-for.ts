/**
 * WaitFor renderer — the wait result is a timeline (header fields, then
 * `[finished]` / `[completed_during_wait]` / `[still_running]` sections),
 * so the collapsed body shows what the wait came back with instead of the
 * raw key-value dump: the finished task with its outcome, plus counts of
 * tasks that finished alongside or are still running. A timeout is not an
 * error (the tool says so itself), so it renders in the warning tone.
 */

import { Text, type Component } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import { formatGoalElapsed } from '../goal-format';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const DESCRIPTION_MAX = 72;
const RUNNING_SAMPLES = 3;

type WaitForStatus = 'completed' | 'timed_out' | 'no_tasks';

interface WaitForResultView {
  readonly status: WaitForStatus;
  readonly waitedMs: number;
  readonly finishedTaskId?: string;
  readonly finishedStatus?: string;
  readonly finishedDescription?: string;
  readonly extraCount: number;
  readonly runningCount: number;
  readonly runningSamples: readonly string[];
}

export const waitForSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);
  const view = parseWaitForOutput(result.output);
  if (view === undefined) return renderTruncated(toolCall, result, ctx);

  const out: Component[] = [];
  for (const line of glanceLines(view)) {
    out.push(new Text(`  ${currentTheme.dim(line)}`, 0, 0));
  }
  if (ctx.expanded && result.output.length > 0) {
    out.push(new Text(currentTheme.dim(result.output), 4, 0));
  }
  return out;
};

export function buildWaitForHeader(options: {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly bullet: string;
  readonly chip: string;
}): string | undefined {
  const { toolCall, result, bullet, chip } = options;
  if (toolCall.name !== 'WaitFor') return undefined;

  const taskId = typeof toolCall.args['task_id'] === 'string' ? toolCall.args['task_id'] : undefined;
  const argText =
    taskId === undefined ? '' : currentTheme.dimFg('textDim', ` (${taskId})`);

  if (result === undefined) {
    const label =
      taskId === undefined ? 'Waiting for any background task' : 'Waiting for background task';
    return `${bullet}${currentTheme.boldFg('primary', label)}${argText}`;
  }
  if (result.is_error === true) {
    return `${bullet}${currentTheme.boldFg('error', 'Could not wait for background task')}${argText}`;
  }

  const status = parseWaitForOutput(result.output)?.status;
  if (status === 'timed_out') {
    return `${currentTheme.fg('warning', STATUS_BULLET)}${currentTheme.boldFg('warning', 'Wait timed out')}${argText}${chip}`;
  }
  if (status === 'no_tasks') {
    return `${bullet}${currentTheme.boldFg('primary', 'No background tasks running')}${chip}`;
  }
  const label = taskId === undefined ? 'Waited for a background task' : 'Waited for background task';
  return `${bullet}${currentTheme.boldFg('primary', label)}${argText}${chip}`;
}

export const waitForChip = (_toolCall: ToolCallBlockData, result: ToolResultBlockData): string => {
  if (result.is_error === true) return '';
  const view = parseWaitForOutput(result.output);
  if (view === undefined || view.status === 'no_tasks') return '';
  return formatGoalElapsed(view.waitedMs);
};

function glanceLines(view: WaitForResultView): string[] {
  switch (view.status) {
    case 'no_tasks':
      return [];
    case 'timed_out': {
      if (view.runningCount === 0) return [];
      const summary = `${pluralizeTasks(view.runningCount)} still running`;
      if (view.runningSamples.length === 0) return [summary];
      const remaining = view.runningCount - view.runningSamples.length;
      const tail = remaining > 0 ? `, +${String(remaining)} more` : '';
      return [`${summary}: ${view.runningSamples.join(', ')}${tail}`];
    }
    case 'completed': {
      const taskId = view.finishedTaskId ?? 'task';
      const status = view.finishedStatus ?? 'completed';
      const marker = status === 'completed' ? '✓' : '✗';
      const description =
        view.finishedDescription === undefined
          ? ''
          : ` · ${truncateOneLine(view.finishedDescription, DESCRIPTION_MAX)}`;
      const lines = [`${marker} ${taskId} ${status}${description}`];
      const parts: string[] = [];
      if (view.extraCount > 0) parts.push(`+${String(view.extraCount)} more finished during wait`);
      if (view.runningCount > 0) parts.push(`${pluralizeTasks(view.runningCount)} still running`);
      if (parts.length > 0) lines.push(parts.join(' · '));
      return lines;
    }
  }
}

function pluralizeTasks(count: number): string {
  return `${String(count)} background task${count === 1 ? '' : 's'}`;
}

function parseWaitForOutput(output: string): WaitForResultView | undefined {
  const status = field(output, 'wait_status');
  if (status !== 'completed' && status !== 'timed_out' && status !== 'no_tasks') return undefined;
  const waitedMs = Number(field(output, 'waited_ms') ?? 0);
  const finished = section(output, 'finished');
  const duringWait = section(output, 'completed_during_wait');
  const stillRunning = section(output, 'still_running');
  const runningCount = stillRunning === undefined ? 0 : countField(stillRunning, 'active_background_tasks');
  return {
    status,
    waitedMs: Number.isFinite(waitedMs) ? waitedMs : 0,
    finishedTaskId: field(output, 'task_id'),
    finishedStatus: finished === undefined ? undefined : field(finished, 'status'),
    finishedDescription: finished === undefined ? undefined : field(finished, 'description'),
    extraCount: duringWait === undefined ? 0 : countOccurrences(duringWait, /^task_id: /gm),
    runningCount,
    runningSamples:
      stillRunning === undefined ? [] : sampleDescriptions(stillRunning, runningCount),
  };
}

function field(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}: (.+)$`, 'm').exec(text);
  return match?.[1];
}

function countField(text: string, name: string): number {
  const value = Number(field(text, name) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function section(output: string, name: string): string | undefined {
  const match = new RegExp(`^\\[${name}\\]$`, 'm').exec(output);
  if (match === null) return undefined;
  const rest = output.slice(match.index + match[0].length);
  const next = /^\[/m.exec(rest);
  return (next === null ? rest : rest.slice(0, next.index)).trim();
}

function countOccurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function sampleDescriptions(stillRunning: string, runningCount: number): readonly string[] {
  const descriptions = [...stillRunning.matchAll(/^description: (.+)$/gm)].map((match) =>
    truncateOneLine(match[1] ?? '', 40),
  );
  return descriptions.slice(0, Math.min(RUNNING_SAMPLES, runningCount));
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.replaceAll(/\s+/g, ' ').trim();
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, Math.max(0, max - 1))}…`;
}
