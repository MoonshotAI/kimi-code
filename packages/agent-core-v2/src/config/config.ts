/**
 * `config` domain (L2) — configuration registry + service + per-agent view.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ConfigSection {
  readonly domain: string;
  readonly schema: unknown;
}

export interface IConfigRegistry {
  readonly _serviceBrand: undefined;
  registerSection(domain: string, schema: unknown): void;
  getSection(domain: string): ConfigSection | undefined;
  merge(base: unknown, patch: unknown): unknown;
}

export const IConfigRegistry: ServiceIdentifier<IConfigRegistry> =
  createDecorator<IConfigRegistry>('configRegistry');

export interface ConfigChangedEvent {
  readonly domain: string;
}

export interface IConfigService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<ConfigChangedEvent>;
  get<T = unknown>(domain: string): T;
  set(domain: string, patch: unknown): Promise<void>;
}

export const IConfigService: ServiceIdentifier<IConfigService> =
  createDecorator<IConfigService>('configService');

export interface IAgentConfigService {
  readonly _serviceBrand: undefined;
  readonly modelAlias: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly systemPrompt: string | undefined;
  readonly provider: string | undefined;
  readonly cwd: string;
  setModel(alias: string): Promise<void>;
  setThinking(level: string): Promise<void>;
}

export const IAgentConfigService: ServiceIdentifier<IAgentConfigService> =
  createDecorator<IAgentConfigService>('agentConfigService');
