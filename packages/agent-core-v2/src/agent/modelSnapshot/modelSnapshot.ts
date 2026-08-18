import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Model } from '#/kosong/model/catalog';
import type { ModelOverride } from '#/kosong/model/model';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import type { OAuthRef } from '#/kosong/provider/provider';
import type { Protocol } from '#/kosong/protocol/protocol';

export type ModelSnapshotRecord = {
  providerId?: string;
  baseUrl?: string;
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
};

export interface IAgentModelSnapshotService {
  readonly _serviceBrand: undefined;

  resolve(alias: string): Model;
  resolveRequester(alias: string): ModelRequester;
}

export const IAgentModelSnapshotService: ServiceIdentifier<IAgentModelSnapshotService> =
  createDecorator<IAgentModelSnapshotService>('agentModelSnapshotService');
