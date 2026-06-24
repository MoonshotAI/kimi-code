/**
 * `environment` domain (L1) — Core-scope path + OS/shell probe contract.
 *
 * Merges v1 `services/environment` (resolved paths: `homeDir` / `configPath`)
 * with the kaos `Environment` OS/shell probe. The probe itself is delegated
 * to `@moonshot-ai/kaos` (`detectEnvironmentFromNode`); this domain owns the
 * Core-scope service and the resolved-paths view.
 *
 * `IEnvironmentOptions` (the host-provided `homeDir`) is a *context token*:
 * it is seeded into the Core scope via `createCoreScope({ extra:
 * environmentSeed(homeDir) })` rather than resolved from a registry
 * descriptor. This is the same pattern used by `ISessionContext` /
 * `IAgentContext` / `ITurnContext` at lower scopes.
 */

import type { Environment } from '@moonshot-ai/kaos';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

/** Host-provided paths, seeded into the Core scope. */
export interface IEnvironmentOptions {
  readonly homeDir: string;
}

export const IEnvironmentOptions: ServiceIdentifier<IEnvironmentOptions> =
  createDecorator<IEnvironmentOptions>('environmentOptions');

export interface IEnvironmentService {
  readonly _serviceBrand: undefined;
  /** Resolved kimi home directory (e.g. `~/.kimi-code`). */
  readonly homeDir: string;
  /** Resolved absolute path to `config.toml`. */
  readonly configPath: string;
  /** Lazily detected / cached OS + shell probe. */
  detect(): Promise<Environment>;
}

export const IEnvironmentService: ServiceIdentifier<IEnvironmentService> =
  createDecorator<IEnvironmentService>('environmentService');

/** Build the Core-scope seed that wires `homeDir` for `IEnvironmentService`. */
export function environmentSeed(homeDir: string): ScopeSeed {
  return [[IEnvironmentOptions as ServiceIdentifier<unknown>, { homeDir } satisfies IEnvironmentOptions]];
}
