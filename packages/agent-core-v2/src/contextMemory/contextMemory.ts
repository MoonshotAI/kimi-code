import { createDecorator } from "#/_base/di";

import type { Hooks } from '#/hooks';
import type { ContextMessage } from '#/types';

export interface IContextMemory {
  getHistory(): readonly ContextMessage[];
  spliceHistory(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void;

  readonly hooks: Hooks<{
    onSpliced: {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    };
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IContextMemory = createDecorator<IContextMemory>('agentContextMemoryService');
