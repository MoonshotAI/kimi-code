import { toDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentPrompt } from '#/actor/prompt/promptAgentRuntime';
import type {
  PromptHandle,
  PromptInput,
  PromptQueueSnapshot,
  PromptRuntime,
  PromptSubmitInput,
  PromptSubmitResult,
} from '#/actor/prompt/prompt';
import type { ContextMessage } from '#/actor/contextMemory/types';
import type { Turn } from '#/actor/loop/internal/loop';

export function deferredHandle(input: { readonly id?: string } = {}): PromptHandle {
  const state = { value: 'pending' as PromptHandle['state'] };
  return {
    id: input.id ?? 'prompt-1',
    userMessageId: input.id ?? 'prompt-1',
    createdAt: '1970-01-01T00:00:00.000Z',
    get state() { return state.value; },
    set state(next: PromptHandle['state']) { state.value = next; },
    message: { role: 'user', content: [], toolCalls: [], origin: { kind: 'user' } },
    launched: Promise.resolve(undefined),
    completion: Promise.resolve({ promptId: input.id ?? 'prompt-1', result: undefined, state: 'blocked' }),
  };
}

export function stubPromptRuntime(overrides: Partial<PromptRuntime> = {}): PromptRuntime {
  const base: PromptRuntime = {
    submit: (_input: PromptSubmitInput): Promise<PromptSubmitResult> =>
      Promise.resolve({ promptId: 'prompt-1', createdAt: '1970-01-01T00:00:00.000Z', state: 'queued' }),
    reserveAdmission: (promptId?: string) => ({
      id: promptId ?? 'prompt-1',
      dispose: () => {},
    }),
    submitMessage: (_message: ContextMessage): Promise<PromptHandle> =>
      Promise.resolve(deferredHandle()),
    enqueue: (_input: PromptInput): Promise<PromptHandle> =>
      Promise.resolve(deferredHandle()),
    list: (): PromptQueueSnapshot => ({ active: undefined, pending: [] }),
    steer: (_promptIds: readonly string[]): Promise<readonly PromptHandle[]> => Promise.resolve([]),
    abort: () => true,
    drain: () => Promise.resolve(),
    inject: (_message: ContextMessage): Promise<Turn | undefined> => Promise.resolve(undefined),
    retry: () => Promise.resolve(undefined),
    clear: () => {},
    registerBeforeSubmitHook: () => toDisposable(() => {}),
  };
  return { ...base, ...overrides };
}

export function lifecycleWithPrompt(
  prompt: PromptRuntime | (() => PromptRuntime),
  inner?: IAgentLifecycleService,
): IAgentLifecycleService {
  const resolvePrompt = (): PromptRuntime => (typeof prompt === 'function' ? prompt() : prompt);
  return {
    resolve: (agent: unknown, definition: unknown) => {
      if (definition === AgentPrompt) return resolvePrompt();
      return inner?.resolve(agent as never, definition as never);
    },
    get: (agentId: unknown) => inner?.get(agentId as never),
    onDidCreate: (listener: (event: unknown) => void) =>
      inner?.onDidCreate?.(listener as never) ?? toDisposable(() => {}),
  } as unknown as IAgentLifecycleService;
}
