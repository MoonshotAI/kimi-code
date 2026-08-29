import type { ContentPart } from '#/kosong/contract/message';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ExecutableToolErrorResult, ExecutableToolSuccessResult } from '#/tool/toolContract';

export type ToolDedupeOutput = string | ContentPart[];

export interface ToolDedupeSuccessResult extends ExecutableToolSuccessResult {
  readonly message?: string | undefined;
}

export interface ToolDedupeErrorResult extends ExecutableToolErrorResult {
  readonly message?: string | undefined;
}

export type ToolDedupeResult = ToolDedupeSuccessResult | ToolDedupeErrorResult;

export interface IAgentToolDedupeService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolDedupeService: ServiceIdentifier<IAgentToolDedupeService> =
  createDecorator<IAgentToolDedupeService>('agentToolDedupeService');
