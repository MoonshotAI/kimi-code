import type { Agent } from '#/agent';
import { isKimiError } from '#/errors';

import type { ExecutableToolErrorResult } from '../../../loop/types';
import type { SessionGoalStore } from '../../../session/goal';

/**
 * Returns the agent's goal store, or a typed `isError` tool result when goal
 * tools are unavailable (non-main agent, or a session without a goal store).
 * Goal tools are main-agent-only.
 */
export function requireGoalStore(
  agent: Agent,
  toolName: string,
): SessionGoalStore | ExecutableToolErrorResult {
  if (agent.type !== 'main') {
    return { isError: true, output: `${toolName} is only available to the main agent.` };
  }
  if (agent.goals === undefined) {
    return {
      isError: true,
      output: `${toolName} requires goal mode, which is not available in this session.`,
    };
  }
  return agent.goals;
}

/** Narrowing helper: did `requireGoalStore` return an error result? */
export function isGoalToolError(
  value: SessionGoalStore | ExecutableToolErrorResult,
): value is ExecutableToolErrorResult {
  return (value as ExecutableToolErrorResult).isError === true;
}

/** Converts a thrown error (typically a typed `KimiError`) into a tool error result. */
export function goalErrorResult(error: unknown): ExecutableToolErrorResult {
  if (isKimiError(error)) {
    return { isError: true, output: `${error.code}: ${error.message}` };
  }
  return { isError: true, output: error instanceof Error ? error.message : String(error) };
}
