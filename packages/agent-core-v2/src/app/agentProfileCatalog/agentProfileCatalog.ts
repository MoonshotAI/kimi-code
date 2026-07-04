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
 * time). The builtin {@link DEFAULT_AGENT_PROFILE_NAME} (`agent`) is the default
 * profile used when an Agent is bound to a Model without naming a profile.
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

import type { ILogger } from '#/app/log';
import type { ISessionProcessRunner } from '#/session/process';

/** Name of the builtin default profile (the top-level interactive agent). */
export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

export interface AgentProfilePromptPrefixContext {
  readonly cwd: string;
  readonly runner: ISessionProcessRunner;
  readonly log?: ILogger;
}

export interface AgentProfileSummaryPolicy {
  /** Minimum length (in characters) of the child's summary before it is
   *  considered acceptable. Shorter summaries trigger a continuation turn. */
  readonly minChars: number;
  /** Continuation prompt appended to the child agent when the summary is too
   *  short, asking it to expand. */
  readonly continuationPrompt: string;
  /** Number of continuation attempts before giving up. */
  readonly retries: number;
}

/**
 * Runtime context supplied to a profile's system-prompt renderer. Captures
 * everything determined at render time (working dir, AGENTS.md, host OS/shell,
 * skills, …). Assembled by the `profile` domain and passed into
 * {@link AgentProfile.systemPrompt}.
 */
export interface AgentProfileContext {
  readonly cwd?: string;
  /** 2-level tree listing of the working directory, for LLM orientation. */
  readonly cwdListing?: string;
  /** Concatenated AGENTS.md instruction hierarchy (user-level + project-level). */
  readonly agentsMd?: string;
  /** Rendered listings of additional workspace directories. */
  readonly additionalDirsInfo?: string;
  /** Host OS family (`macOS` / `Linux` / `Windows` / raw platform). */
  readonly osKind?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  /** ISO timestamp captured at render time. */
  readonly now?: string;
  /** Rendered model-facing listing of available skills. */
  readonly skills?: string;
  readonly [key: string]: unknown;
}

export interface AgentProfile {
  /** Stable identifier; must be unique across contributions. */
  readonly name: string;
  /** Short human-readable label; surfaced to the caller (LLM) as "Available agent types". */
  readonly description?: string;
  /** When-to-use hint appended to `description` in the caller's tool spec. */
  readonly whenToUse?: string;
  /** Tool names (and MCP glob patterns) the agent may use under this profile. */
  readonly tools: readonly string[];
  /**
   * Render the complete system prompt for this profile given the runtime
   * context. Self-contained — includes the base prompt and any role overlay.
   */
  systemPrompt(context: AgentProfileContext): string;
  /**
   * Optional per-invocation prompt prefix produced from the caller's context
   * (e.g. `explore`'s `<git-context>` block). Prepended to the caller-supplied
   * prompt before the child's first turn. Best-effort — a thrown error / empty
   * return skips the prefix.
   */
  readonly promptPrefix?: (ctx: AgentProfilePromptPrefixContext) => Promise<string>;
  /**
   * Optional summary distillation policy applied by the caller after the
   * child's turn ends. Undefined = accept whatever the child returned.
   */
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
}

export interface IAgentProfileCatalogService {
  readonly _serviceBrand: undefined;

  /** Return the profile with the given name, or `undefined` when unknown. */
  get(name: string): AgentProfile | undefined;
  /**
   * Return the builtin default profile ({@link DEFAULT_AGENT_PROFILE_NAME}).
   * Throws when no default profile is registered (a programming-time invariant
   * violation, not a request failure).
   */
  getDefault(): AgentProfile;
  /** Enumerate every registered profile. Stable order (insertion order). */
  list(): readonly AgentProfile[];
}

export const IAgentProfileCatalogService: ServiceIdentifier<IAgentProfileCatalogService> =
  createDecorator<IAgentProfileCatalogService>('agentProfileCatalogService');
