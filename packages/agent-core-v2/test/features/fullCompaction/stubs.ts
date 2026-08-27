import { toDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentFullCompaction,
  type FullCompactionRuntime,
  type FullCompactionStatus,
  type FullCompactionTask,
} from '#/features/fullCompaction/fullCompactionAgentRuntime';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeProvider,
} from '#/agent/runtime/agentRuntime';

export function stubFullCompactionRuntime(
  overrides: Partial<FullCompactionRuntime> = {},
): FullCompactionRuntime {
  const base: FullCompactionRuntime = {
    begin: (): Promise<FullCompactionTask> =>
      Promise.resolve({ id: 'compaction-1', status: 'idle' }),
    cancel: () => Promise.resolve(),
    status: (): FullCompactionStatus => 'idle',
    onDidFinish: Event.None as FullCompactionRuntime['onDidFinish'],
    registerBeforeCompactHook: () => toDisposable(() => {}),
  };
  return { ...base, ...overrides };
}

export function lifecycleWithFullCompaction(
  fullCompaction: FullCompactionRuntime | (() => FullCompactionRuntime),
  inner?: IAgentLifecycleService,
): IAgentLifecycleService {
  const resolveFullCompaction = (): FullCompactionRuntime =>
    typeof fullCompaction === 'function' ? fullCompaction() : fullCompaction;
  return {
    resolve: (agent: unknown, definition: unknown) => {
      if (definition === AgentFullCompaction) return resolveFullCompaction();
      return inner?.resolve(agent as never, definition as never);
    },
    handleOf: (agentId: string) => inner?.handleOf(agentId) ?? ({}),
    onDidCreateScope: (listener: (event: { context: AgentContext }) => void) =>
      inner?.onDidCreateScope(listener as never) ?? toDisposable(() => {}),
  } as unknown as IAgentLifecycleService;
}

export function stubFullCompactionRuntimeProvider(
  runtime: () => FullCompactionRuntime = stubFullCompactionRuntime,
): AgentRuntimeProvider<FullCompactionRuntime> {
  return defineAgentRuntimeProvider(AgentFullCompaction, {
    id: 'fullCompaction',
    createApi: () => runtime(),
  });
}
