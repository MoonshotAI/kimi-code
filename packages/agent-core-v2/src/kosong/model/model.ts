import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { Protocol } from '#/kosong/protocol/protocol';

import type { OAuthRef } from '../provider/provider';

export interface ModelOverride {
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
}

export interface ModelRecord {
  providerId?: string;

  baseUrl?: string;
  apiKey?: string;
  oauth?: OAuthRef;

  protocol?: Protocol;

  name?: string;
  aliases?: string[];

  provider?: string;
  model?: string;
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  betaApi?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;

  overrides?: ModelOverride;

  [key: string]: unknown;
}

export type ModelsSection = Record<string, ModelRecord>;

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface DefaultModelChangedEvent {
  readonly id: string | undefined;
}

export interface IModelService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil>;
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil>;
  get(id: string): ModelRecord | undefined;
  list(): Readonly<Record<string, ModelRecord>>;
  getDefaultModel(): string | undefined;
  set(id: string, model: ModelRecord): Promise<void>;
  delete(id: string): Promise<void>;
  loadAll(models: ModelsSection, defaultModel: string | undefined): void;
  replaceAll(models: ModelsSection): Promise<void>;
  setDefaultModel(id: string | undefined): Promise<void>;
}

export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');
