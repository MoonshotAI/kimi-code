/**
 * `kaos` domain (L1) — execution-environment service contracts.
 *
 * Defines the execution-environment contracts: `IKaosFactory` for creating
 * `Kaos` instances (Core), `ISessionKaosService` for the session's tool /
 * persistence / system-context environments (Session), and `IAgentKaos` for
 * the per-agent working directory (Agent).
 */

import type { Kaos } from '@moonshot-ai/kaos';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

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
  readonly kaos: Kaos;
  readonly cwd: string;
  chdir(cwd: string): Promise<void>;
}

export const IAgentKaos: ServiceIdentifier<IAgentKaos> =
  createDecorator<IAgentKaos>('agentKaos');
