import { PRIMARY_SUBAGENT_MODEL_CHOICE } from './configSection';

export const DEFAULT_PROFILE_NAME = 'coder';

export const FORK_WITH_RESUME_UNAVAILABLE =
  'Cannot set resume when forking the current context. Fork creates a new agent; resume continues an existing one.';
export const FORK_WITH_TYPE_UNAVAILABLE =
  'Cannot set a different subagent_type when forking the current context. A fork inherits this agent\'s own agent type.';
export const FORK_WITH_MODEL_UNAVAILABLE =
  'Cannot override the model when forking the current context. A fork inherits this agent\'s model.';
export const FORK_EXPERIMENTAL_UNAVAILABLE =
  'fork is disabled: the subagent_fork experimental flag is off.';
export const FORK_CONTEXT_NOTICE =
  'The conversation above is not your own history: it is a one-time snapshot inherited from the agent that forked you. Treat it as reference material only — you are an independent subagent, not a continuation of that agent. Do the task below directly yourself, then report the result.';

export interface ForkCompatibilityArgs {
  readonly resume?: string;
  readonly subagent_type?: string;
  readonly model?: string;
}

export function forkIncompatibility(
  args: ForkCompatibilityArgs,
  own: { readonly profileName?: string; readonly modelAlias?: string },
): string | undefined {
  const resumeAgentId = args.resume?.trim();
  if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
    return FORK_WITH_RESUME_UNAVAILABLE;
  }
  const requestedProfileName =
    args.subagent_type !== undefined && args.subagent_type.length > 0
      ? args.subagent_type
      : undefined;
  if (requestedProfileName !== undefined && requestedProfileName !== own.profileName) {
    return FORK_WITH_TYPE_UNAVAILABLE;
  }
  if (
    args.model !== undefined &&
    args.model !== PRIMARY_SUBAGENT_MODEL_CHOICE &&
    args.model !== own.modelAlias
  ) {
    return FORK_WITH_MODEL_UNAVAILABLE;
  }
  return undefined;
}

export interface SubagentSpawnPlanInput {
  readonly callerAgentId: string;
  readonly profileName?: string;
  readonly model?: string;
  readonly fork?: boolean;
}

export interface SubagentSpawnPlan {
  readonly profileName: string;
  readonly model: string;
  readonly thinking?: string;
  readonly fork: boolean;
}

export interface SpawnSubagentOptions {
  readonly callerAgentId: string;
  readonly plan: SubagentSpawnPlan;
  readonly labels?: Readonly<Record<string, string>>;
  readonly prompt: string;
}

export interface SpawnedSubagent {
  readonly agentId: string;
  readonly profileName: string;
  readonly model: string;
  readonly promptText: string;
}
