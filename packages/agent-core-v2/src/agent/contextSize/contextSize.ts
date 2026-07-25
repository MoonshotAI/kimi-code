import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

export interface IAgentContextSizeService {
  readonly _serviceBrand: undefined;

  get(start?: number, end?: number): ContextSize;
  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void;
}

export const IAgentContextSizeService =
  createDecorator<IAgentContextSizeService>('agentContextSizeService');
