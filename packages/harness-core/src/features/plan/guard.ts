import type { ToolBeforeHook } from '@moonshot-ai/agent-core';

import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  type Interactions,
} from '#/features/interaction/index';
import type { PermissionFace } from '#/features/permission/index';

import { formatAutoApprovedPlanForOutput, requestExitPlanModeApproval } from './review';
import type { PlanData } from './storage';
import { parseExitPlanModeArgs } from './tools/exit-plan-mode';

export function createPlanGuard(deps: {
  readonly planPath: () => string | null;
  readonly status: () => Promise<PlanData | null>;
  readonly recordRevision: () => Promise<void>;
  readonly exit: (id?: string) => Promise<void>;
  readonly interactions: Interactions;
  readonly sessionId: string;
  readonly agentId: string;
  readonly permission?: () => PermissionFace | undefined;
}): ToolBeforeHook {
  const { planPath, status, recordRevision, exit, interactions, sessionId, agentId, permission } =
    deps;
  return async ({ toolCall }) => {
    const path = planPath();
    if (toolCall.name === 'ExitPlanMode') {
      if (path === null) return undefined;
      const current = await status();
      if (current === null || current.content.trim().length === 0) return undefined;
      const args = parseExitPlanModeArgs(toolCall.arguments);
      if (!args.ok) return undefined;
      await recordRevision().catch(() => {});
      if (permission?.()?.mode() === 'auto') {
        await exit();
        return deniedWith(
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
      return deniedWith(planModeWriteDeniedMessage(path));
    }
    if (toolCall.name === 'TaskStop') {
      return deniedWith(
        'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
      );
    }
    if (toolCall.name === 'CronCreate' || toolCall.name === 'CronDelete') {
      return deniedWith(
        `${toolCall.name} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
      );
    }
    return undefined;
  };
}

function deniedWith(text: string) {
  return { type: 'denied' as const, result: { content: [{ type: 'text' as const, text }] } };
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
