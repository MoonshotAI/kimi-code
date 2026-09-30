import { GOAL_NOT_FOUND, GoalRef, isGoalError } from '@moonshot-ai/harness-core';

import { parseGoalCommand, type ParsedGoalCommand } from '#/cli/goal-command-parse';

import { GoalStatusMessageComponent } from '../components/messages/goal-panel';
import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/errors';
import { canRestoreSubmittedInput } from './resolve';
import type { SlashCommandHost } from './dispatch';

const GOAL_QUEUE_DROPPED_MESSAGE =
  'Upcoming goal queues are not available in this version. Start the next goal with `/goal replace <objective>` once the current one finishes.';

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
      if (parsed.restoreInput === true && canRestoreSubmittedInput(host)) {
        host.restoreInputText(`/goal ${args}`);
      }
      return;
    case 'status':
      await showGoalStatus(host);
      return;
    case 'pause':
      await pauseGoal(host);
      return;
    case 'resume':
      await resumeGoal(host);
      return;
    case 'cancel':
      await cancelGoal(host);
      return;
    case 'next-add':
    case 'next-manage':
      host.showStatus(GOAL_QUEUE_DROPPED_MESSAGE);
      return;
    case 'create':
      await createGoal(host, parsed);
      return;
  }
}

async function createGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
): Promise<void> {
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  const session = await host.ensureSession();
  if (session === undefined) return;
  const main = host.mainAgent();
  if (main === undefined) return;
  const goalFace = main.resolve(GoalRef);
  if (goalFace === undefined) {
    // Goal feature not mounted — the intake prompt would have nothing to call.
    host.showError('Goal mode is not available in this session.');
    return;
  }
  const current = goalFace.getGoal().goal;
  if (current !== null && !parsed.replace) {
    host.showError(
      'A goal is already active. Use `/goal replace <objective>` to replace it, or `/goal status` to inspect it.',
    );
    return;
  }
  host.track('goal_create', { replace: parsed.replace });
  host.sendNormalUserInput(goalIntakePrompt(parsed));
}

function goalIntakePrompt(parsed: Extract<ParsedGoalCommand, { kind: 'create' }>): string {
  const replace = parsed.replace
    ? ' Replace the existing goal (`replace: true`).'
    : '';
  return [
    'The user asked to start goal mode with the following objective:',
    '',
    parsed.objective,
    '',
    `Create the goal now by calling CreateGoal with exactly this objective.${replace} Derive a completionCriterion only when one is stated or directly implied by the objective; otherwise omit it. Once the goal exists, start working toward it immediately in this turn.`,
  ].join('\n');
}

async function pauseGoal(host: SlashCommandHost): Promise<void> {
  const main = host.mainAgent();
  if (main === undefined) {
    host.showStatus('No goal to pause.');
    return;
  }
  const goalFace = main.resolve(GoalRef);
  if (goalFace === undefined) {
    host.showError('Goal mode is not available in this session.');
    return;
  }
  try {
    await goalFace.pauseGoal({}, 'user');
  } catch (error) {
    if (isGoalError(error) && error.code === GOAL_NOT_FOUND) {
      host.showStatus('No goal to pause.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_pause');
  host.showStatus('Goal paused. Use `/goal resume` to continue.');
}

async function resumeGoal(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  const session = await host.ensureSession();
  if (session === undefined) return;
  const main = host.mainAgent();
  if (main === undefined) return;
  const goalFace = main.resolve(GoalRef);
  if (goalFace === undefined) {
    host.showError('Goal mode is not available in this session.');
    return;
  }
  try {
    await goalFace.resumeGoal({ continueIfPaused: true, continueIfBlocked: true }, 'user');
  } catch (error) {
    if (isGoalError(error) && error.code === GOAL_NOT_FOUND) {
      host.showStatus('No goal to resume.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_resume');
}

async function cancelGoal(host: SlashCommandHost): Promise<void> {
  const main = host.mainAgent();
  if (main === undefined) {
    host.showStatus('No goal to cancel.');
    return;
  }
  const goalFace = main.resolve(GoalRef);
  if (goalFace === undefined) {
    host.showError('Goal mode is not available in this session.');
    return;
  }
  try {
    await goalFace.cancelGoal({}, 'user');
  } catch (error) {
    if (isGoalError(error) && error.code === GOAL_NOT_FOUND) {
      host.showStatus('No goal to cancel.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_cancel');
  host.showNotice('Goal cancelled.');
}

async function showGoalStatus(host: SlashCommandHost): Promise<void> {
  const main = host.mainAgent();
  if (main === undefined) {
    host.showStatus('No goal set. Start one with `/goal <objective>`.');
    return;
  }
  const goal = main.resolve(GoalRef)?.getGoal().goal ?? null;
  host.track('goal_status', { status: goal?.status ?? 'none' });
  if (goal === null) {
    host.showStatus('No goal set. Start one with `/goal <objective>`.');
    return;
  }
  host.state.transcriptContainer.addChild(new GoalStatusMessageComponent(goal));
  host.state.ui.requestRender();
}
