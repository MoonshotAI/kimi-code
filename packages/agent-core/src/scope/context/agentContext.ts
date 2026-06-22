/**
 * Scope identity context for the Agent scope.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`IAgentContext`) plus DR10 (context field-name normalization).
 *
 * A service living in the Agent scope (or below) injects this via
 * `@IAgentContext` to read its identity — `id`, `parentId`, `abortSignal`,
 * `executionScope` — instead of receiving raw ids as method arguments. An Agent
 * is owned by a Session, so `parentId` is the owning `sessionId`.
 *
 * DR10 field-name normalization: the raw source uses per-scope names
 * (`agentId`, `sessionId`, `signal`). The canonical names here are `id` /
 * `parentId` / `abortSignal` / `executionScope` so cross-scope code (managers,
 * aggregators, builders) can be generic.
 */

import { createDecorator } from '../../_base/di';

/**
 * Identity of the Agent scope.
 *
 * `executionScope` is the Kaos-domain execution-environment snapshot (cwd / env).
 * It is typed as `unknown` here as a placeholder — P3/P4 will refine it to the
 * real `IExecutionScope` once that type exists. Do not import a not-yet-existing
 * module.
 */
export interface IAgentContext {
  /** Agent id (canonical name; source calls it `agentId`). */
  readonly id: string;
  /** Owning Session id (canonical name; source calls it `sessionId`). */
  readonly parentId: string;
  /** Aborts when the Agent scope is disposed. */
  readonly abortSignal: AbortSignal;
  /**
   * Execution-environment snapshot. Placeholder `unknown` until P3/P4 introduce
   * the real `IExecutionScope` type.
   */
  readonly executionScope: unknown;
}

/**
 * DI decorator / service identifier for {@link IAgentContext}.
 */
export const IAgentContext = createDecorator<IAgentContext>('agentContext');
