/**
 * `hooks` domain (L6) — session-scope user hook engine.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface HookResult {
  readonly continue: boolean;
  readonly message?: string;
}

export interface IHookEngine {
  readonly _serviceBrand: undefined;
  runUserPromptSubmit(prompt: string): Promise<HookResult>;
  runPreToolCall(toolName: string, args: unknown): Promise<HookResult>;
  runSessionStart(): Promise<void>;
  runSessionEnd(): Promise<void>;
}

export const IHookEngine: ServiceIdentifier<IHookEngine> =
  createDecorator<IHookEngine>('hookEngine');
