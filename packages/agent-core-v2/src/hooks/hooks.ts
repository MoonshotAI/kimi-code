/**
 * `hooks` domain (L6) — user hook engine.
 *
 * Defines the public contract of the hook engine: the `HookResult` model and the
 * `IHookEngine` used to run the user-prompt-submit, pre-tool-call, and session
 * start/end hook points. Session-scoped — one instance per session.
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
