import { MAIN_AGENT_ID, type LlmModel } from '@moonshot-ai/agent-core';

import type { SpawnModelEntry, SpawnProfile, SpawnProfileCatalog } from './catalog';

export const DEFAULT_PROFILE_NAME = 'coder';
export const FORK_PROFILE_LABEL = 'fork';
export const PRIMARY_MODEL_CHOICE = 'primary';

export const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.';
export const FORK_WITH_RESUME_UNAVAILABLE =
  'Cannot set resume when forking the current context. Fork creates a new agent; resume continues an existing one.';
export const FORK_WITH_TYPE_UNAVAILABLE =
  "Cannot set a different subagent_type when forking the current context. A fork inherits this agent's own agent type.";
export const FORK_WITH_MODEL_UNAVAILABLE =
  'Cannot override the model when forking the current context. A fork inherits this agent\'s model.';
export const FORK_EXPERIMENTAL_UNAVAILABLE =
  'fork is disabled: the subagent_fork experimental flag is off.';
export const FORK_CONTEXT_NOTICE =
  'The conversation above is not your own history: it is a one-time snapshot inherited from the agent that forked you. Treat it as reference material only — you are an independent subagent, not a continuation of that agent. Do the task below directly yourself, then report the result.';
export const PROMPT_REQUIRED_MESSAGE = 'Provide a non-empty prompt for the subagent.';

export interface SpawnArgs {
  readonly prompt?: string;
  readonly description?: string;
  readonly subagent_type?: string;
  readonly resume?: string;
  readonly run_in_background?: boolean;
  readonly fork?: boolean;
  readonly model?: string;
}

export function readResumeAgentId(args: SpawnArgs): string | undefined {
  const resume = args.resume?.trim();
  return resume !== undefined && resume.length > 0 ? resume : undefined;
}

export function readProfileName(args: SpawnArgs): string | undefined {
  return args.subagent_type !== undefined && args.subagent_type.length > 0
    ? args.subagent_type
    : undefined;
}

export function forkIncompatibility(
  args: SpawnArgs,
  own: { readonly profileName?: string; readonly modelAlias?: string },
): string | undefined {
  if (readResumeAgentId(args) !== undefined) {
    return FORK_WITH_RESUME_UNAVAILABLE;
  }
  const requestedProfileName = readProfileName(args);
  if (requestedProfileName !== undefined && requestedProfileName !== own.profileName) {
    return FORK_WITH_TYPE_UNAVAILABLE;
  }
  if (
    args.model !== undefined &&
    args.model !== PRIMARY_MODEL_CHOICE &&
    args.model !== own.modelAlias
  ) {
    return FORK_WITH_MODEL_UNAVAILABLE;
  }
  return undefined;
}

export function validateSpawnArgs(
  args: SpawnArgs,
  own: { readonly profileName?: string; readonly modelAlias?: string },
  forkEnabled: boolean,
): string | undefined {
  if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
    return PROMPT_REQUIRED_MESSAGE;
  }
  if (readResumeAgentId(args) !== undefined && readProfileName(args) !== undefined) {
    return RESUME_WITH_TYPE_UNAVAILABLE;
  }
  if (args.fork === true) {
    if (!forkEnabled) {
      return FORK_EXPERIMENTAL_UNAVAILABLE;
    }
    return forkIncompatibility(args, own);
  }
  return undefined;
}

export type SpawnModelResolution =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'explicit'; readonly name: string; readonly model: LlmModel };

export interface SpawnPlanInput {
  readonly callerAgentId: string;
  readonly profileName?: string;
  readonly model?: string;
  readonly fork: boolean;
}

export type SpawnPlan =
  | {
      readonly ok: true;
      readonly profileName: string;
      readonly profile?: SpawnProfile;
      readonly model: SpawnModelResolution;
      readonly fork: boolean;
    }
  | { readonly ok: false; readonly error: string };

export function planSpawn(
  input: SpawnPlanInput,
  env: {
    readonly catalog: SpawnProfileCatalog;
    readonly models: readonly SpawnModelEntry[];
  },
): SpawnPlan {
  const requested = input.profileName !== undefined && input.profileName.length > 0
    ? input.profileName
    : undefined;
  if (input.callerAgentId !== MAIN_AGENT_ID) {
    return {
      ok: false,
      error: `Subagent type "${requested ?? DEFAULT_PROFILE_NAME}" is not allowed for this agent. Allowed subagent types: none.`,
    };
  }
  const model = resolveSpawnModel(input.model, env.models);
  if (typeof model === 'string') {
    return { ok: false, error: model };
  }
  if (input.fork) {
    return { ok: true, profileName: FORK_PROFILE_LABEL, model, fork: true };
  }
  const profileName = requested ?? DEFAULT_PROFILE_NAME;
  const profile = env.catalog.get(profileName);
  if (profile === undefined) {
    return { ok: false, error: `Unknown agent type: "${profileName}".` };
  }
  return { ok: true, profileName: profile.name, profile, model, fork: false };
}

function resolveSpawnModel(
  requested: string | undefined,
  models: readonly SpawnModelEntry[],
): SpawnModelResolution | string {
  if (requested === undefined || requested === PRIMARY_MODEL_CHOICE) {
    return { kind: 'inherit' };
  }
  const entry = models.find((candidate) => candidate.name === requested);
  if (entry !== undefined) {
    return { kind: 'explicit', name: entry.name, model: entry.model };
  }
  if (models.length === 0) {
    return `Invalid model "${requested}": no subagent model pool is configured, so subagents inherit the caller's model (pass "primary" or omit the model parameter).`;
  }
  const available = [...models.map((candidate) => candidate.name), PRIMARY_MODEL_CHOICE];
  return `Invalid model "${requested}". Available models: ${available.join(', ')}.`;
}
