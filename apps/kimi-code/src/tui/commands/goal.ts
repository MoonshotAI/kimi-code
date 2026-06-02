import { ErrorCodes, isKimiError, type PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import {
  GoalStartPermissionPromptComponent,
  type GoalStartPermissionChoice,
} from '../components/dialogs/goal-start-permission-prompt';
import { buildGoalReportLines, GoalSetMessageComponent, goalPanelTitle } from '../components/messages/goal-panel';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const RESUME_GOAL_INPUT = 'Resume the active goal.';

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly replace: boolean;
    }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'cancel']);

/**
 * Parses the deterministic `/goal` command grammar. Reserved subcommands
 * (`pause`/`resume`/`cancel`/`status`/`replace`) are only honored as the first
 * token; use `/goal -- <objective>` to start a goal whose text begins with one
 * of those words. (`cancel` is the single discard action — it removes the
 * current goal.) Stop conditions are expressed in the objective in natural
 * language (e.g. "…or stop after 20 turns"); the model honors them when it
 * self-audits each turn and reports `complete`/`blocked` via UpdateGoal.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'cancel' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  // (e.g. `/goal -- pause the rollout`).
  if (tokens[index] === '--') {
    index += 1;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    // A usage hint, not a failure — shown in the same calm style as the other
    // "nothing to act on" messages (no goal to pause/resume/cancel).
    return {
      kind: 'error',
      severity: 'hint',
      message: 'Provide a goal objective, e.g. `/goal Ship feature X`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Reference long details by file path.`,
    };
  }
  return { kind: 'create', objective, replace };
}

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
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
    case 'create':
      await createGoal(host, parsed, args);
      return;
  }
}

async function createGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  rawArgs?: string,
): Promise<void> {
  // A goal must be able to start a model turn; refuse to create one otherwise.
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showGoalStartPermissionPrompt(host, parsed, rawArgs ?? parsed.objective);
    return;
  }

  await startGoal(host, parsed);
}

function showGoalStartPermissionPrompt(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  rawArgs: string,
): void {
  const commandText = `/goal ${rawArgs.trim()}`;
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus('Goal not started.');
  };
  host.mountEditorReplacement(
    new GoalStartPermissionPromptComponent({
      colors: host.state.theme.colors,
      onSelect: (choice) => {
        if (choice === 'cancel') {
          cancelStart();
          return;
        }
        host.restoreEditor();
        void startGoalWithPermission(host, parsed, choice);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startGoalWithPermission(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
  choice: GoalStartPermissionChoice,
): Promise<void> {
  if (choice === 'auto' || choice === 'yolo') {
    if (!(await setPermissionForGoal(host, choice))) return;
  }
  await startGoal(host, parsed);
}

async function setPermissionForGoal(host: SlashCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(`Failed to set permission mode: ${formatErrorMessage(error)}`);
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
): Promise<void> {
  try {
    await host.requireSession().createGoal({
      objective: parsed.objective,
      replace: parsed.replace,
    });
  } catch (error) {
    if (isKimiError(error) && error.code === ErrorCodes.GOAL_ALREADY_EXISTS) {
      host.showError(
        'A goal is already active. Use `/goal replace <objective>` to replace it, or `/goal status` to inspect it.',
      );
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_create', { replace: parsed.replace });
  host.state.transcriptContainer.addChild(new GoalSetMessageComponent(host.state.theme.colors));
  host.state.ui.requestRender();
  host.sendNormalUserInput(parsed.objective);
}

async function pauseGoal(host: SlashCommandHost): Promise<void> {
  try {
    await host.requireSession().pauseGoal();
  } catch (error) {
    if (isKimiError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus('No goal to pause.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  if (isStreaming(host)) host.cancelInFlight?.();
  host.showStatus('Goal paused. Use `/goal resume` to continue.');
}

async function resumeGoal(host: SlashCommandHost): Promise<void> {
  try {
    await host.requireSession().resumeGoal();
  } catch (error) {
    if (isKimiError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus('No goal to resume.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.showStatus('Goal resumed.');
  host.sendNormalUserInput(RESUME_GOAL_INPUT);
}

async function cancelGoal(host: SlashCommandHost): Promise<void> {
  try {
    await host.requireSession().cancelGoal();
  } catch (error) {
    if (isKimiError(error) && error.code === ErrorCodes.GOAL_NOT_FOUND) {
      host.showStatus('No goal to cancel.');
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  if (isStreaming(host)) host.cancelInFlight?.();
  host.showStatus('Goal cancelled.');
}

async function showGoalStatus(host: SlashCommandHost): Promise<void> {
  const { goal } = await host.requireSession().getGoal();
  if (goal === null) {
    host.showStatus('No goal set. Start one with `/goal <objective>`.');
    return;
  }
  const lines = buildGoalReportLines({ colors: host.state.theme.colors, goal });
  const panel = new UsagePanelComponent(lines, host.state.theme.colors.primary, goalPanelTitle(goal));
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

function isStreaming(host: SlashCommandHost): boolean {
  return host.state.appState.streamingPhase !== 'idle';
}
