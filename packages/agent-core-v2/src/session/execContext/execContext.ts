/**
 * `execContext` domain (L1) — the Session's execution context.
 *
 * Defines `IExecContext`, an immutable snapshot of the working directory the
 * session runs in (`cwd`) and the env layers that are overlaid onto every
 * spawned process (`envLayers`). The context is seeded into the Session scope
 * by `session-lifecycle` when the session is created and never mutates in
 * place — `withCwd` / `withEnv` return derived contexts.
 *
 * Consumed by:
 *   - `session/agentFs` — the fs implementation resolves relative paths
 *     against `cwd`
 *   - `session/process` — the process runner uses `cwd` and merges the env
 *     layers onto every spawn
 *   - business code that renders a "current cwd" (tool descriptions,
 *     permission policies, profile context)
 *
 * Pure facts — no store, no IO. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface IExecContext {
  readonly _serviceBrand: undefined;

  /** Absolute path to the session's working directory. */
  readonly cwd: string;

  /** Ordered list of env overlays applied on top of `process.env` when
   *  spawning a process. Later layers win. */
  readonly envLayers: readonly Record<string, string>[];

  /** Return a new `IExecContext` rooted at `cwd`, keeping the same env
   *  layers. Does not mutate this context. */
  withCwd(cwd: string): IExecContext;

  /** Return a new `IExecContext` with `env` appended to `envLayers`. Does
   *  not mutate this context. */
  withEnv(env: Record<string, string>): IExecContext;
}

export const IExecContext: ServiceIdentifier<IExecContext> =
  createDecorator<IExecContext>('execContext');

/**
 * Construct a plain immutable `IExecContext` value. Used by `session-lifecycle`
 * when creating a fresh Session scope, and by `withCwd`/`withEnv` derivations
 * inside session-scoped services.
 */
export function createExecContext(
  cwd: string,
  envLayers: readonly Record<string, string>[] = [],
): IExecContext {
  const ctx: IExecContext = {
    _serviceBrand: undefined,
    cwd,
    envLayers,
    withCwd: (nextCwd: string) => createExecContext(nextCwd, envLayers),
    withEnv: (env: Record<string, string>) => createExecContext(cwd, [...envLayers, env]),
  };
  return ctx;
}

/**
 * Build the DI seed pair used by `session-lifecycle` to inject an
 * `IExecContext` into a new Session scope.
 */
export function execContextSeed(ctx: IExecContext): ScopeSeed {
  return [[IExecContext as ServiceIdentifier<unknown>, ctx]];
}
