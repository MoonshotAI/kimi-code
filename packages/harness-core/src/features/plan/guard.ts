import type { LoopHooks } from '@moonshot-ai/agent-core/loop/index';

import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  type Interactions,
} from '#/features/interaction/index';

import { blockedWith, formatAutoApprovedPlanForOutput, requestExitPlanModeApproval } from './review';
import type { PlanData } from './storage';
import { parseExitPlanModeArgs } from './tools/exit-plan-mode';

export function createPlanGuard(deps: {
  readonly ready: Promise<void>;
  readonly planPath: () => string | null;
  readonly status: () => Promise<PlanData | null>;
  readonly recordRevision: () => Promise<void>;
  readonly exit: (id?: string) => Promise<void>;
  readonly interactions: Interactions;
  readonly sessionId: string;
  readonly agentId: string;
  readonly permissionMode?: () => string | undefined;
}): LoopHooks['tool.starting'] {
  const { ready, planPath, status, recordRevision, exit, interactions, sessionId, agentId, permissionMode } =
    deps;
  return async ({ toolCall }) => {
    await ready;
    const path = planPath();
    if (toolCall.name === 'ExitPlanMode') {
      if (path === null) return undefined;
      const current = await status();
      if (current === null || current.content.trim().length === 0) return undefined;
      const args = parseExitPlanModeArgs(toolCall.arguments);
      if (!args.ok) return undefined;
      await recordRevision().catch(() => {});
      if (permissionMode?.() === 'auto') {
        await exit();
        return blockedWith(
          `Exited plan mode. ${formatAutoApprovedPlanForOutput(current.content, current.path)}`,
        );
      }
      const options =
        args.options !== undefined && args.options.length >= 2 ? args.options : undefined;
      return requestExitPlanModeApproval(
        interactions,
        { exit },
        { plan: current.content, path: current.path, options },
        {
          [INTERACTION_TAG_SESSION_ID]: sessionId,
          [INTERACTION_TAG_AGENT_ID]: agentId,
          [INTERACTION_TAG_TOOL_CALL_ID]: toolCall.id,
        },
      );
    }
    if (path === null) return undefined;
    if (toolCall.name === 'Write' || toolCall.name === 'Edit') {
      const target = readWriteTargetPath(toolCall.arguments);
      if (target !== undefined && target === path) return undefined;
      return blockedWith(planModeWriteDeniedMessage(path));
    }
    if (toolCall.name === 'TaskStop') {
      return blockedWith(
        'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
      );
    }
    if (toolCall.name === 'CronCreate' || toolCall.name === 'CronDelete') {
      return blockedWith(
        `${toolCall.name} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
      );
    }
    return undefined;
  };
}

function planModeWriteDeniedMessage(planFilePath: string): string {
  return (
    `Plan mode is active. You may only write to the current plan file: ${planFilePath}. ` +
    'Call ExitPlanMode to exit plan mode before editing other files.'
  );
}

function readWriteTargetPath(raw: string | null): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const filePath = record['file_path'];
  if (typeof filePath === 'string') return filePath;
  const path = record['path'];
  return typeof path === 'string' ? path : undefined;
}
