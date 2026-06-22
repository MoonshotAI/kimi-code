/**
 * Scope identity context for the Session scope.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`ISessionContext`) plus DR10 (context field-name normalization).
 *
 * A service living in the Session scope (or below) injects this via
 * `@ISessionContext` to read its identity — `id`, `parentId`, `abortSignal`,
 * `executionScope` — instead of receiving raw ids as method arguments. Session
 * is the top-most business scope: its parent is Core, which carries no business
 * identity, so `parentId` is `undefined`.
 *
 * DR10 field-name normalization: the raw source uses per-scope names
 * (`sessionId`, `signal`). The canonical names here are `id` / `parentId` /
 * `abortSignal` / `executionScope` so cross-scope code (managers, aggregators,
 * builders) can be generic.
 */

import { createDecorator } from '../../_base/di';

/**
 * Identity of the Session scope.
 *
 * `executionScope` is the Kaos-domain execution-environment snapshot (cwd / env).
 * It is typed as `unknown` here as a placeholder — P3/P4 will refine it to the
 * real `IExecutionScope` once that type exists. Do not import a not-yet-existing
 * module.
 */
export interface ISessionContext {
  /** Session id (canonical name; source calls it `sessionId`). */
  readonly id: string;
  /**
   * Session has no business parent (its parent is Core). Always `undefined`.
   */
  readonly parentId?: undefined;
  /** Aborts when the Session scope is disposed. */
  readonly abortSignal: AbortSignal;
  /**
   * Execution-environment snapshot. Placeholder `unknown` until P3/P4 introduce
   * the real `IExecutionScope` type.
   */
  readonly executionScope: unknown;
}

/**
 * DI decorator / service identifier for {@link ISessionContext}.
 */
export const ISessionContext = createDecorator<ISessionContext>('sessionContext');
