/**
 * Scope identity context for the ToolCall scope.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`IToolCallContext`) plus DR10 (context field-name normalization).
 *
 * A service living in the ToolCall scope injects this via `@IToolCallContext`
 * to read its identity — `id`, `parentId`, `abortSignal`, `executionScope` —
 * instead of receiving raw ids as method arguments. A ToolCall is owned by a
 * Turn, so `parentId` is the owning `turnId`.
 *
 * DR10 field-name normalization: the raw source uses per-scope names
 * (`toolCallId`, `turnId`, `signal`). The canonical names here are `id` /
 * `parentId` / `abortSignal` / `executionScope` so cross-scope code (managers,
 * aggregators, builders) can be generic.
 */

import { createDecorator } from '../../_base/di';

/**
 * Identity of the ToolCall scope.
 *
 * `executionScope` is the Kaos-domain execution-environment snapshot (cwd / env).
 * It is typed as `unknown` here as a placeholder — P3/P4 will refine it to the
 * real `IExecutionScope` once that type exists. Do not import a not-yet-existing
 * module.
 */
export interface IToolCallContext {
  /** ToolCall id (canonical name; source calls it `toolCallId`). */
  readonly id: string;
  /** Owning Turn id (canonical name; source calls it `turnId`). */
  readonly parentId: string;
  /** Aborts when the owning turn is cancelled / the scope is disposed. */
  readonly abortSignal: AbortSignal;
  /**
   * Execution-environment snapshot. Placeholder `unknown` until P3/P4 introduce
   * the real `IExecutionScope` type.
   */
  readonly executionScope: unknown;
}

/**
 * DI decorator / service identifier for {@link IToolCallContext}.
 */
export const IToolCallContext = createDecorator<IToolCallContext>('toolCallContext');
