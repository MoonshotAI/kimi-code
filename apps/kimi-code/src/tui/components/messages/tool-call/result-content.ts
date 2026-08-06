/**
 * Result content coordinator — builds the result preview body for a
 * completed tool call.
 *
 * Extracted from ToolCallComponent to isolate the dispatcher and the
 * specialised per-tool summary renderers (AgentSwarm, SwarmDiscussion,
 * AskUserQuestion). Generic tools fall through to the shared
 * `pickResultRenderer` registry in `tool-renderers/registry.ts`.
 *
 * Functions are pure: they take a context object and return a list of
 * `Component` instances instead of mutating the parent container.
 */

import { Text, type Component } from '@moonshot-ai/pi-tui';

import { FAILURE_MARK, SUCCESS_MARK } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { t } from '#/i18n';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import { agentSwarmResultSummaryFromOutput } from '../agent-swarm-progress';
import { pickResultRenderer } from '../tool-renderers/registry';

import {
  interpretExitPlanModeOutcome,
  isExitPlanModeOutcomeOutput,
} from './plan-mode';

/** Inputs needed to render a tool call's result body. */
export interface ResultContentContext {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData;
  readonly expanded: boolean;
  /**
   * True when this tool call is an Agent call whose SubagentStateManager
   * has live state. The coordinator must skip the generic result renderer
   * because the single-subagent block owns its own body.
   */
  readonly isSingleSubagentView: boolean;
}

/**
 * Dispatch a completed tool call's result to the right renderer.
 *
 * Order of checks mirrors the original ToolCallComponent.buildContent:
 *   1. AgentSwarm  -> specialised summary header
 *   2. SwarmDiscussion -> specialised summary header
 *   3. empty output / system-reminder -> nothing
 *   4. single-subagent view -> nothing (subagent block handles it)
 *   5. ExitPlanMode rejected -> feedback suggestion block
 *   6. TodoList / EnterPlanMode success -> nothing
 *   7. AskUserQuestion (foreground) -> Q/A block
 *   8. otherwise -> registry renderer (Read/Grep/Bash/Edit/Write/...)
 */
export function buildResultContent(ctx: ResultContentContext): Component[] {
  const { toolCall, result, expanded, isSingleSubagentView } = ctx;

  if (toolCall.name === 'AgentSwarm') {
    return buildAgentSwarmResultSummary(result);
  }

  if (toolCall.name === 'SwarmDiscussion') {
    return buildDiscussionResultSummary(result);
  }

  if (!result.output) return [];

  // The single-subagent view owns its own body — skip the generic path.
  if (isSingleSubagentView) return [];

  if (result.output.trimStart().startsWith('<system-reminder>')) return [];

  if (toolCall.name === 'ExitPlanMode' && isExitPlanModeOutcomeOutput(result.output)) {
    const outcome = interpretExitPlanModeOutcome(result.output);
    if (outcome.kind === 'rejected' && outcome.feedback !== undefined) {
      const trimmed = outcome.feedback.trim();
      if (trimmed.length > 0) {
        return buildExitPlanModeRejectedFeedback(trimmed);
      }
    }
    return [];
  }

  if (toolCall.name === 'TodoList' && !result.is_error) return [];
  if (toolCall.name === 'EnterPlanMode' && !result.is_error) return [];

  if (
    toolCall.name === 'AskUserQuestion' &&
    toolCall.args['background'] !== true &&
    !result.is_error
  ) {
    const rendered = renderAskUserQuestionResult(result.output);
    if (rendered.length > 0) return rendered;
  }

  const renderer = pickResultRenderer(toolCall.name);
  return renderer(toolCall, result, { expanded });
}

// ── ExitPlanMode rejected feedback ──

function buildExitPlanModeRejectedFeedback(feedback: string): Component[] {
  const labelTone = (text: string): string => currentTheme.boldFg('warning', text);
  const components: Component[] = [
    new Text(labelTone(t('tui.messages.toolCall.suggestionLabel')), 2, 0),
  ];
  for (const line of feedback.split('\n')) {
    components.push(new Text(line, 4, 0));
  }
  return components;
}

// ── AskUserQuestion ──

function renderAskUserQuestionResult(output: string): Component[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];

  const accent = (text: string): string => currentTheme.fg('primary', text);

  const answers = (parsed as { answers?: unknown }).answers;
  const note = (parsed as { note?: unknown }).note;

  const hasAnswers =
    typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;

  if (!hasAnswers) {
    const noteText =
      typeof note === 'string' && note.length > 0
        ? note
        : t('tui.messages.toolCall.userDismissedQuestion');
    return [new Text(currentTheme.dim(`  ${noteText}`), 0, 0)];
  }

  const components: Component[] = [];
  for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
    const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
    components.push(new Text(`  ${currentTheme.dim('Q')}  ${question}`, 0, 0));
    components.push(new Text(`  ${accent('→')}  ${answerText}`, 0, 0));
  }
  return components;
}

// ── SwarmDiscussion ──

function buildDiscussionResultSummary(result: ToolResultBlockData): Component[] {
  const dim = (s: string): string => currentTheme.fg('textDim', s);
  const accent = (s: string): string => currentTheme.fg('primary', s);

  const transcriptMatch = result.output.match(/<transcript>([\s\S]*?)<\/transcript>/);
  const summaryTextMatch = result.output.match(/<final_summary>([\s\S]*?)<\/final_summary>/);

  const speechCount =
    result.is_error === true
      ? 0
      : (transcriptMatch?.[1]?.split('\n\n').filter((l) => l.trim().startsWith('[')).length ?? 0);

  const segments: string[] = [];
  if (speechCount > 0) {
    segments.push(`${String(speechCount)} speeches`);
  }

  if (result.is_error === true) {
    segments.push(`${FAILURE_MARK.trimEnd()} ${t('tui.messages.toolCall.failedPeriod')}`);
  } else {
    segments.push(`${SUCCESS_MARK.trimEnd()} ${t('tui.messages.toolCall.completedPeriod')}`);
  }

  const components: Component[] = [
    new Text(
      `${dim(t('tui.messages.toolCall.discussionLabel'))}${segments.join(dim(' · '))}`,
      2, 0,
    ),
  ];

  const summaryText = summaryTextMatch?.[1];
  if (summaryText !== undefined && summaryText !== null && summaryText.trim().length > 0) {
    components.push(new Text('', 2, 0));
    components.push(new Text(accent(t('tui.messages.toolCall.discussionSummary')), 2, 0));
    for (const line of summaryText.trim().split('\n')) {
      components.push(new Text(line, 4, 0));
    }
  }
  return components;
}

// ── AgentSwarm ──

const ABORTED_MARK = '⊘';

function buildAgentSwarmResultSummary(result: ToolResultBlockData): Component[] {
  const summary = agentSwarmResultSummaryFromOutput(result.output);
  const dim = (s: string): string => currentTheme.fg('textDim', s);
  const segments: string[] = [];

  if (summary.completed > 0) {
    segments.push(
      currentTheme.fg(
        'success',
        `${SUCCESS_MARK.trimEnd()} ${t('tui.messages.toolCall.completedStatus', { count: summary.completed })}`,
      ),
    );
  }
  if (summary.failed > 0) {
    segments.push(
      currentTheme.fg(
        'error',
        `${FAILURE_MARK.trimEnd()} ${t('tui.messages.toolCall.failedStatus', { count: summary.failed })}`,
      ),
    );
  }
  if (summary.aborted > 0) {
    segments.push(
      currentTheme.fg(
        'warning',
        `${ABORTED_MARK} ${t('tui.messages.toolCall.abortedStatus', { count: summary.aborted })}`,
      ),
    );
  }

  if (segments.length > 0) {
    return [
      new Text(
        `${dim(t('tui.messages.toolCall.agentSwarmLabel'))}${segments.join(dim(' · '))}`,
        2, 0,
      ),
    ];
  }

  const isAborted = result.is_error === true && /\b(?:aborted|cancelled)\b/i.test(result.output);
  const colorToken = isAborted ? 'warning' : result.is_error === true ? 'error' : 'success';
  const label = isAborted
    ? `${ABORTED_MARK} ${t('tui.messages.toolCall.abortedPeriod')}`
    : result.is_error === true
      ? `${FAILURE_MARK.trimEnd()} ${t('tui.messages.toolCall.failedPeriod')}`
      : `${SUCCESS_MARK.trimEnd()} ${t('tui.messages.toolCall.completedPeriod')}`;
  return [
    new Text(
      `${dim(t('tui.messages.toolCall.agentSwarmLabel'))}${currentTheme.fg(colorToken, label)}`,
      2, 0,
    ),
  ];
}

// Re-exported for callers that need to inspect the discussion/aggregator marks.
export { ABORTED_MARK };

// Helper used by callers that need to know whether the output looks like an
// ExitPlanMode outcome without re-parsing.
export function isExitPlanModeRejectedResult(result: ToolResultBlockData): boolean {
  if (!isExitPlanModeOutcomeOutput(result.output)) return false;
  return interpretExitPlanModeOutcome(result.output).kind === 'rejected';
}
