/**
 * `agentProfileCatalog` domain (L3) — App-scope registry of named agent profiles
 * that a parent Agent can invoke a child Agent under.
 *
 * A profile is "how an Agent runs": which tools are active, what system prompt
 * overlay is applied on top of the caller's prompt, an optional per-invocation
 * prompt prefix (e.g. explore's git-context block), and an optional summary
 * distillation policy (min chars + continuation prompt) applied when a caller
 * awaits the child's turn output.
 *
 * Profiles are contributed at module load via `registerAgentProfile(...)`, the
 * same "import = register" pattern used by `registerTool` and
 * `registerConfigSection`. `AgentProfileCatalogService` consumes the accumulated
 * contributions on construction and exposes `get(name)` / `list()` to callers
 * (currently the `Agent` tool). Contributions are keyed by `name`; a
 * later-registered profile with the same name overrides an earlier one.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ILogger } from '#/app/log';
import type { ISessionProcessRunner } from '#/session/process';

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

export interface AgentProfileDefinition {
  /** Stable identifier; must be unique across contributions. */
  readonly name: string;
  /** Short human-readable label; surfaced to the caller (LLM) as "Available agent types". */
  readonly description?: string;
  /** When-to-use hint appended to `description` in the caller's tool spec. */
  readonly whenToUse?: string;
  /**
   * Text appended to the parent's system prompt when a child agent is spawned
   * under this profile. Undefined = use parent's system prompt verbatim.
   */
  readonly systemPromptOverlay?: string;
  /**
   * Tool names the child agent may use. Undefined = inherit the parent's
   * active tool set (`coder` behaves this way for the special case where the
   * parent is also a `coder`).
   */
  readonly activeToolNames?: readonly string[];
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
  get(name: string): AgentProfileDefinition | undefined;
  /** Enumerate every registered profile. Stable order (insertion order). */
  list(): readonly AgentProfileDefinition[];
}

export const IAgentProfileCatalogService: ServiceIdentifier<IAgentProfileCatalogService> =
  createDecorator<IAgentProfileCatalogService>('agentProfileCatalogService');
