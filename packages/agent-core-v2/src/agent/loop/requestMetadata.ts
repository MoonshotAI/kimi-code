import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  BTW_AGENT_LABEL,
  isSubagentMeta,
  subagentProfileName,
  subagentSwarmItem,
  TOWER_WORKER_PROFILE,
} from '#/session/agentLifecycle/subagentMetadata';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export type AgentRole =
  | 'main'
  | 'btw'
  | 'tower_worker'
  | 'swarm_member'
  | 'subagent'
  | 'other';

export type TurnTrigger =
  | 'user'
  | 'skill'
  | 'plugin_command'
  | 'subagent_task'
  | 'swarm_retry'
  | 'goal_continuation'
  | 'cron'
  | 'background_task'
  | 'tower_inbox'
  | 'shell_background'
  | 'other';

export type StepReason = 'turn_start' | 'tool_results' | 'compact';

export function agentRoleOf(agentId: string, meta: AgentMeta | undefined): AgentRole {
  if (agentId === MAIN_AGENT_ID) return 'main';
  if (meta?.labels?.[BTW_AGENT_LABEL] === 'true') return 'btw';
  if (subagentProfileName(meta) === TOWER_WORKER_PROFILE) return 'tower_worker';
  if (subagentSwarmItem(meta) !== undefined) return 'swarm_member';
  return isSubagentMeta(meta) ? 'subagent' : 'other';
}

export function turnTriggerOf(origin: PromptOrigin | undefined): TurnTrigger {
  if (origin === undefined) return 'other';
  switch (origin.kind) {
    case 'user':
      return 'user';
    case 'skill_activation':
      return origin.trigger === 'user-slash' ? 'skill' : 'other';
    case 'plugin_command':
      return 'plugin_command';
    case 'system_trigger':
      if (origin.name === 'subagent') return 'subagent_task';
      if (origin.name === 'goal_continuation') return 'goal_continuation';
      return 'other';
    case 'retry':
      return 'swarm_retry';
    case 'cron_job':
    case 'cron_missed':
      return 'cron';
    case 'task':
      return 'background_task';
    case 'injection':
      if (origin.variant === 'tower_inbox') return 'tower_inbox';
      if (origin.variant === 'shell_command_backgrounded') return 'shell_background';
      return 'other';
    default:
      return 'other';
  }
}

export function userInputIdOf(
  origin: PromptOrigin | undefined,
  promptId: string | undefined,
): string | undefined {
  if (promptId === undefined || promptId.length === 0) return undefined;
  if (origin === undefined) return undefined;
  if (origin.kind === 'user') return promptId;
  if (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') return promptId;
  if (origin.kind === 'plugin_command') return promptId;
  return undefined;
}

export function requestMetadataHeaders(metadata: {
  readonly agentRole: AgentRole;
  readonly turnTrigger?: TurnTrigger;
  readonly stepReason?: StepReason;
  readonly userInputId?: string;
  readonly parentRequestId?: string;
}): Record<string, string> {
  return {
    'X-Msh-Client-Metadata': JSON.stringify({
      agent_role: metadata.agentRole,
      turn_trigger: metadata.turnTrigger,
      step_reason: metadata.stepReason,
      user_input_id: metadata.userInputId,
      parent_request_id: metadata.parentRequestId,
    }).replaceAll(
      /[\u007F-\uFFFF]/g,
      (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`,
    ),
  };
}
