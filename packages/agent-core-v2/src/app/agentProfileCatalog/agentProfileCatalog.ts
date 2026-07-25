/**
 * `agentProfileCatalog` domain (L3) — App-scope registry of named agent
 * profiles.
 *
 * A profile is "how an Agent runs": the full system prompt it renders for a
 * given context, the tool set it may use, plus optional per-invocation and
 * summary-distillation behavior for child agents. A profile is model-agnostic:
 * the same profile can be bound to any Model. Together with a bound Model, a
 * profile uniquely determines an Agent's behavior (`Profile + Model ⇒ Agent`).
 *
 * Every profile is self-contained: `systemPrompt(context)` returns the complete
 * prompt (base + role overlay are merged at definition time, not at spawn
 * time). Profiles stay independent of concrete model aliases, but may declare
 * a symbolic primary/secondary preference used as the default when spawned as
 * a subagent. The builtin {@link DEFAULT_AGENT_PROFILE_NAME} (`agent`) is the
 * default profile used when an Agent is bound to a Model without naming a
 * profile.
 *
 * `tools` is an allowlist of exact builtin names plus `mcp__` globs
 * (`undefined` = every tool active); `disallowedTools` denies with the same
 * matching semantics, applied on top of the allowlist result. `subagents` is
 * an allowlist of subagent profile names the agent may delegate to
 * (`undefined` = any type).
 *
 * Profiles are contributed at module load via `registerAgentProfile(...)`, the
 * same "import = register" pattern used by `registerTool` and
 * `registerConfigSection`. `AgentProfileCatalogService` consumes the accumulated
 * contributions on construction and exposes `get(name)` / `getDefault()` /
 * `list()` to callers (the `Agent` tool, the swarm scheduler, and the per-agent
 * profile binding). Contributions are keyed by `name`; a later-registered
 * profile with the same name overrides an earlier one.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ILogger } from '#/_base/log/log';
import type { ISessionProcessRunner } from '#/session/process/processRunner';

export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

export type AgentModelPreference = 'primary' | 'secondary';

export interface AgentProfilePromptPrefixContext {
  readonly cwd: string;
  readonly runner: ISessionProcessRunner;
  readonly log?: ILogger;
}

export interface AgentProfileSummaryPolicy {
  readonly minChars: number;
  readonly continuationPrompt: string;
  readonly retries: number;
}

export interface AgentProfileContext {
  readonly cwd?: string;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  readonly osKind?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly now?: string;
  readonly skills?: string;
  readonly skillActive?: boolean;
  readonly [key: string]: unknown;
}

export interface AgentProfile {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly override?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference?: AgentModelPreference;
  systemPrompt(context: AgentProfileContext): string;
  readonly promptPrefix?: (ctx: AgentProfilePromptPrefixContext) => Promise<string>;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
}

export interface IAgentProfileCatalogService {
  readonly _serviceBrand: undefined;

  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
}

export const IAgentProfileCatalogService: ServiceIdentifier<IAgentProfileCatalogService> =
  createDecorator<IAgentProfileCatalogService>('agentProfileCatalogService');
