import { createDecorator } from "#/_base/di";

import type { ContextMessage, Turn } from '../types';

export interface IPromptService {
  prompt(message: ContextMessage): Turn | undefined;
  steer(message: ContextMessage): Turn | undefined;
  retry(trigger?: string): Turn | undefined;
  undo(count: number): number;
  clear(): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPromptService = createDecorator<IPromptService>('promptService.agent');
