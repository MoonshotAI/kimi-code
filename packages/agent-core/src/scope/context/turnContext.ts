/**
 * Scope identity context for the Turn scope.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`ITurnContext`) plus DR10 (context field-name normalization).
 *
 * A service living in the Turn scope (or below) injects this via
 * `@ITurnContext` to read its identity — `id`, `parentId`, `abortSignal`,
 * `executionScope` — instead of receiving raw ids as method arguments. A Turn
 * is owned by an Agent, so `parentId` is the owning `agentId`. `abortSignal`
 * fires on ESC / abort-driven cancellation of the turn.
 *
 * DR10 field-name normalization: the raw source uses per-scope names
 * (`turnId`, `agentId`, `signal`). The canonical names here are `id` /
 * `parentId` / `abortSignal` / `executionScope` so cross-scope code (managers,
 * aggregators, builders) can be generic.
 */

import { createDecorator } from '../../di/instantiation';

/**
 * Identity of the Turn scope.
 *
 * `executionScope` is the Kaos-domain execution-environment snapshot (cwd / env).
 * It is typed as `unknown` here as a placeholder — P3/P4 will refine it to the
 * real `IExecutionScope` once that type exists. Do not import a not-yet-existing
 * module.
 */
export interface ITurnContext {
  /** Turn id (canonical name; source calls it `turnId`). */
  readonly id: string;
  /** Owning Agent id (canonical name; source calls it `agentId`). */
  readonly parentId: string;
  /** Aborts on ESC / abort-driven cancellation of the turn. */
  readonly abortSignal: AbortSignal;
  /**
   * Execution-environment snapshot. Placeholder `unknown` until P3/P4 introduce
   * the real `IExecutionScope` type.
   */
  readonly executionScope: unknown;
}

/**
 * DI decorator / service identifier for {@link ITurnContext}.
 */
export const ITurnContext = createDecorator<ITurnContext>('turnContext');
