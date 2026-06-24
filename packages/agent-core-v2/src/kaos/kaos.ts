/**
 * `kaos` domain (L1) — execution-environment abstractions across three
 * scopes.
 *
 * kaos wraps `@moonshot-ai/kaos` (file / process / path primitives) into the
 * DI scope model:
 *  - `IKaosFactory` (Core): builds concrete `Kaos` instances (local / ssh).
 *  - `ISessionKaosService` (Session): owns the session-level tool /
 *    persistence / system-context kaos plus `additionalDirs`.
 *  - `IAgentKaos` (Agent): the per-agent cwd-scoped kaos view.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** Options for building a concrete `Kaos`. Shape is intentionally loose for
 *  the skeleton; it will be tightened when business logic lands. */
export interface KaosFactoryOptions {
  readonly kind: 'local' | 'ssh';
  readonly cwd?: string;
  readonly host?: string;
}

export interface IKaosFactory {
  readonly _serviceBrand: undefined;
  create(options: KaosFactoryOptions): Promise<Kaos>;
}

export const IKaosFactory: ServiceIdentifier<IKaosFactory> =
  createDecorator<IKaosFactory>('kaosFactory');

export interface ISessionKaosService {
  readonly _serviceBrand: undefined;
  readonly toolKaos: Kaos;
  readonly persistenceKaos: Kaos;
  readonly systemContextKaos: Kaos;
  readonly additionalDirs: readonly string[];
  setToolKaos(kaos: Kaos): void;
  addAdditionalDir(dir: string): void;
  removeAdditionalDir(dir: string): void;
}

export const ISessionKaosService: ServiceIdentifier<ISessionKaosService> =
  createDecorator<ISessionKaosService>('sessionKaosService');

export interface IAgentKaos {
  readonly _serviceBrand: undefined;
  /** The agent's cwd-scoped kaos. */
  readonly kaos: Kaos;
  readonly cwd: string;
  chdir(cwd: string): Promise<void>;
}

export const IAgentKaos: ServiceIdentifier<IAgentKaos> =
  createDecorator<IAgentKaos>('agentKaos');
