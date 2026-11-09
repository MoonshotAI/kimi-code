import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export const REQUEST_METADATA_HEADER = 'X-Msh-Internal-Metadata';

export const BTW_AGENT_LABEL = 'btw';
export const TOWER_WORKER_PROFILE = 'tower-worker';
export const SESSION_INIT_LABEL = 'sessionInit';

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

export type StepReason = 'turn_start' | 'tool_results' | 'notify' | 'retry' | 'recovery';

export interface RequestMetadata {
  readonly agent_role: AgentRole;
  readonly turn_trigger?: TurnTrigger;
  readonly step_reason?: StepReason;
  readonly user_input_id?: string;
}

export function agentRoleOf(agentId: string, meta: AgentMeta | undefined): AgentRole {
  if (agentId === 'main') return 'main';
  const labels = meta?.labels;
  if (labels?.[BTW_AGENT_LABEL] === 'true') return 'btw';
  if (labels?.['profileName'] === TOWER_WORKER_PROFILE) return 'tower_worker';
  if (firstLabel(labels, 'swarmItem', meta?.swarmItem) !== undefined) return 'swarm_member';
  if (labels?.[SESSION_INIT_LABEL] !== undefined) return 'subagent';
  if (firstLabel(labels, 'parentAgentId', meta?.parentAgentId ?? undefined) !== undefined) {
    return 'subagent';
  }
  if (meta?.type === 'sub') return 'subagent';
  return 'other';
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

export function requestMetadataHeader(metadata: RequestMetadata): Record<string, string> {
  const body: Record<string, string> = { agent_role: metadata.agent_role };
  if (metadata.turn_trigger !== undefined) body['turn_trigger'] = metadata.turn_trigger;
  if (metadata.step_reason !== undefined) body['step_reason'] = metadata.step_reason;
  if (metadata.user_input_id !== undefined) body['user_input_id'] = metadata.user_input_id;
  return { [REQUEST_METADATA_HEADER]: JSON.stringify(body) };
}

function firstLabel(
  labels: Readonly<Record<string, string>> | undefined,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const value = labels?.[key] ?? fallback;
  return value !== undefined && value.length > 0 ? value : undefined;
}
