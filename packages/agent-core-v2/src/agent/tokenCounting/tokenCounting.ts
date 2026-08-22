import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

export type TokenCountingStrategy = 'measured+estimated' | 'measured' | 'estimated';

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

export interface TokenCountingRequest {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
}
