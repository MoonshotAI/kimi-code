import type { HistoryMessage, UserEntry } from '#/history/message';
import type { ToolDescription } from '#/llm/message';
import type { PolicyRegistry } from '#/llm/policy/registry';
import type { ToolExecutor } from '#/tool/index';
import type { WaitOpts } from '#/utils/wait';
import { AgentMachine } from './agent-machine';
import type { LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookRegistration } from './contract/hook';
import type { RemindEntry } from './contract/inbox';
import type { TurnOutcome } from './contract/outcome';
import type { HookRegistry } from './hook/registry';
import type { LoopLlmRequester } from './request';
import type { LoopState } from './state';
import type { WaitForTasks } from './tool/tasks';

export interface CreateLoopOptions {
  readonly requester?: LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly hooks?: readonly HookRegistration[];
  readonly input?: LoopInput;
  readonly abortGraceMs?: number;
  readonly onListenerError?: (error: unknown, event: LoopEmitted) => void;
}

export interface Loop {
  readonly state: LoopState;
  readonly baseRequester: LoopLlmRequester | undefined;
  readonly requester: LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly waitForTasks: WaitForTasks;
  readonly hooks: HookRegistry;
  readonly policy: PolicyRegistry;
  submit(entry: UserEntry): LoopAck<'prompt.submitted'> | undefined;
  notify(entry: UserEntry): LoopAck<'prompt.notified'> | undefined;
  remind(entry: RemindEntry): LoopAck<'prompt.reminded'> | undefined;
  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined;
  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined;
  continue(): void;
  abort(reason?: unknown): void;
  abortTool(toolCallId: string, reason?: unknown): void;
  detachTool(toolCallId: string): void;
  setRequester(requester: LoopLlmRequester | undefined): void;
  setContext(messages: HistoryMessage[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined;
  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined;
  setTools(tools: readonly ToolDescription[]): LoopAck<'tools.settled'> | undefined;
  subscribe(listener: (event: LoopEmitted) => void): () => void;
  wait<T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>>;
  runTurn(entry: UserEntry, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export function createLoop(options: CreateLoopOptions): Loop {
  return new AgentMachine(options);
}
