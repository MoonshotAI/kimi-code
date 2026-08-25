import { assign, setup, type Snapshot } from 'xstate';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { permissionModeReminderEffects } from '#/features/permissionMode/internal/permissionModeEffects';
import { toContractMode, toWireMode } from '#/features/permissionMode/internal/modeMapping';
import {
  PermissionSetMode,
  type PermissionModeState,
  type WirePermissionMode,
} from '#/features/permissionMode/permissionModeOps';

export type PermissionMode = 'default' | 'plan' | 'auto' | 'dangerous';

export interface PermissionModeChangeEvent {
  readonly previous: PermissionMode;
  readonly current: PermissionMode;
}

interface PermissionModeActorContext {
  readonly runtime: AgentRuntimeContext<PermissionModeState>;
  readonly ledger: PermissionModeState;
}

interface PermissionModeCommitEvent {
  readonly type: 'permissionMode.commit';
  readonly ledger: PermissionModeState;
}

type PermissionModeActorSnapshot = Snapshot<unknown> & {
  readonly context: PermissionModeActorContext;
};

const permissionModeActorLogic = setup({
  types: {} as {
    context: PermissionModeActorContext;
    input: AgentRuntimeContext<PermissionModeState>;
    events: PermissionModeCommitEvent | AgentRuntimeRestoreEvent;
  },
  actors: { permissionModeReminderEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    ledger: { mode: 'manual', configured: false },
  }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'permissionModeReminderEffects',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
  on: {
    'permissionMode.commit': {
      actions: assign({ ledger: ({ event }) => event.ledger }),
    },
  },
});

export class PermissionModeRuntime {
  private readonly changeListeners = new Set<(event: PermissionModeChangeEvent) => void>();
  private observedMode: WirePermissionMode | undefined;
  private observation: IDisposable | undefined;

  readonly onDidChange: Event<PermissionModeChangeEvent> = (listener) => {
    this.startObservation();
    this.changeListeners.add(listener);
    return toDisposable(() => {
      this.changeListeners.delete(listener);
    });
  };

  constructor(private readonly context: AgentRuntimeContext<PermissionModeState>) {}

  mode(): PermissionMode {
    return toContractMode(this.context.getState().mode);
  }

  configured(): boolean {
    return this.context.getState().configured;
  }

  async changeMode(mode: PermissionMode): Promise<void> {
    const wire = toWireMode(mode);
    const current = this.context.getState();
    if (wire === current.mode && current.configured) return;
    await this.context.dispatch(
      new PermissionSetMode({ agentId: this.context.agent.agentId, mode: wire }),
    );
  }

  private startObservation(): void {
    if (this.observation !== undefined) return;
    this.observedMode = this.context.getState().mode;
    this.observation = this.context.onDidChange((state) => {
      const previous = this.observedMode;
      if (previous === undefined || state.mode === previous) return;
      this.observedMode = state.mode;
      const event: PermissionModeChangeEvent = {
        previous: toContractMode(previous),
        current: toContractMode(state.mode),
      };
      for (const listener of this.changeListeners) listener(event);
    });
  }
}

export const AgentPermissionMode =
  defineAgentRuntimeContract<PermissionModeRuntime>('permissionMode');

export const permissionModeAgentRuntimeProvider = defineAgentRuntimeProvider<
  PermissionModeState,
  PermissionModeRuntime
>(AgentPermissionMode, {
  id: 'permissionMode',
  logic: permissionModeActorLogic,
  durable: {
    events: [PermissionSetMode],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof PermissionSetMode) {
        state.mode = event.mode;
        state.configured = true;
      }
    },
    read: (snapshot) => (snapshot as PermissionModeActorSnapshot).context.ledger,
    commit: (actor, ledger) => {
      actor.send({ type: 'permissionMode.commit', ledger });
    },
  },
  createApi: (context) => new PermissionModeRuntime(context),
  inspect: (snapshot) => (snapshot as PermissionModeActorSnapshot).context.ledger.mode,
});
