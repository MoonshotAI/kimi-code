import { createDecorator } from '../../../di';

export interface ContextSizeStatus {
  readonly contextTokens: number;
  readonly contextTokensWithPending: number;
}

export interface IContextSizeService {
  readonly _serviceBrand: undefined;

  getStatus(): ContextSizeStatus;
  measure(length: number, tokens: number): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IContextSizeService =
  createDecorator<IContextSizeService>('agentContextSizeService');
