import { toDisposable } from '#/_base/di/lifecycle';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentUndo,
  type UndoAvailability,
  type UndoResult,
  type UndoRuntime,
} from '#/features/undo/undoAgentRuntime';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeProvider,
} from '#/agent/runtime/agentRuntime';

export function stubUndoRuntime(overrides: Partial<UndoRuntime> = {}): UndoRuntime {
  const base: UndoRuntime = {
    availability: (): UndoAvailability => ({ canUndo: false }),
    undo: (): Promise<UndoResult> => Promise.resolve({ applied: true }),
    registerUndoParticipant: () => toDisposable(() => {}),
  };
  return { ...base, ...overrides };
}

export function lifecycleWithUndo(
  undo: UndoRuntime | (() => UndoRuntime),
  inner?: IAgentLifecycleService,
): IAgentLifecycleService {
  const resolveUndo = (): UndoRuntime =>
    typeof undo === 'function' ? undo() : undo;
  return {
    resolve: (agent: unknown, definition: unknown) => {
      if (definition === AgentUndo) return resolveUndo();
      return inner?.resolve(agent as never, definition as never);
    },
    handleOf: (agentId: string) => inner?.handleOf(agentId) ?? ({}),
    onDidCreateScope: (listener: (event: { context: AgentContext }) => void) =>
      inner?.onDidCreateScope(listener as never) ?? toDisposable(() => {}),
  } as unknown as IAgentLifecycleService;
}

export function stubUndoRuntimeProvider(
  runtime: () => UndoRuntime = stubUndoRuntime,
): AgentRuntimeProvider<UndoRuntime> {
  return defineAgentRuntimeProvider(AgentUndo, {
    id: 'undo',
    createApi: () => runtime(),
  });
}
