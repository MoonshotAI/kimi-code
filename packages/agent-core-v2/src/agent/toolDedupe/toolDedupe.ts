import type { ContentPart } from '#/kosong/contract/message';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ToolDedupeOutput = string | ContentPart[];

export interface ToolDedupeSuccessResult {
  readonly output: ToolDedupeOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ToolDedupeErrorResult {
  readonly output: ToolDedupeOutput;
  readonly isError: true;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export type ToolDedupeResult = ToolDedupeSuccessResult | ToolDedupeErrorResult;

export interface IAgentToolDedupeService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolDedupeService: ServiceIdentifier<IAgentToolDedupeService> =
  createDecorator<IAgentToolDedupeService>('agentToolDedupeService');
