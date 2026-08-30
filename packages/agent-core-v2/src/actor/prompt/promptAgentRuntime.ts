import { fromCallback, setup } from 'xstate';

import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import type {
  PromptAdmissionReservation,
  PromptBeforeSubmitHook,
  PromptHandle,
  PromptInput,
  PromptQueueSnapshot,
  PromptRuntime,
  PromptSubmitInput,
  PromptSubmitResult,
} from './prompt';
import type { ContextMessage } from '#/actor/contextMemory/types';
import type { Turn } from '#/actor/loop/internal/loop';
import { PromptDomain } from './internal/promptDomain';
import { PromptAccepted } from './promptOps';

export type { PromptRuntime } from './prompt';

export class AgentPromptRuntime implements PromptRuntime {
  constructor(private readonly context: AgentRuntimeContext<ReadonlySet<string>>) {}

  private get domain(): PromptDomain {
    return this.context.getLogicState<PromptActorContext>().domain;
  }

  submit(input: PromptSubmitInput): Promise<PromptSubmitResult> {
    return this.domain.submit(input);
  }

  reserveAdmission(promptId?: string): PromptAdmissionReservation {
    return this.domain.reserveAdmission(promptId);
  }

  submitMessage(message: ContextMessage): Promise<PromptHandle> {
    return this.domain.submitMessage(message);
  }

  enqueue(input: PromptInput): Promise<PromptHandle> {
    return this.domain.enqueue(input);
  }

  list(): PromptQueueSnapshot {
    return this.domain.list();
  }

  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    return this.domain.steer(promptIds);
  }

  abort(promptId: string, reason?: Error): boolean {
    return this.domain.abort(promptId, reason);
  }

  drain(reason?: Error): Promise<void> {
    return this.domain.drain(reason);
  }

  inject(message: ContextMessage): Promise<Turn | undefined> {
    return this.domain.inject(message);
  }

  retry(): Promise<Turn | undefined> {
    return this.domain.retry();
  }

  clear(): void {
    this.domain.clear();
  }

  registerBeforeSubmitHook(name: string, hook: PromptBeforeSubmitHook) {
    return this.domain.registerBeforeSubmitHook(name, hook);
  }
}

export const AgentPrompt = defineAgentRuntimeContract<PromptRuntime>('prompt');

interface PromptActorContext {
  readonly runtime: AgentRuntimeContext<ReadonlySet<string>>;
  readonly domain: PromptDomain;
  admitted: ReadonlySet<string>;
}

interface PromptCommitEvent {
  readonly type: 'prompt.commit';
  readonly admitted: ReadonlySet<string>;
}

const promptEffects = fromCallback(({ input }: { input: PromptDomain }) => {
  const attached = input.attach();
  return () => attached.dispose();
});

const promptActorLogic = setup({
  types: {} as {
    context: PromptActorContext;
    input: AgentRuntimeContext<ReadonlySet<string>>;
    events: AgentRuntimeRestoreEvent | PromptCommitEvent;
  },
  actors: { promptEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    domain: new PromptDomain(input),
    admitted: new Set<string>(),
  }),
  on: {
    'prompt.commit': {
      actions: ({ context, event }) => {
        context.admitted = event.admitted;
      },
    },
  },
  invoke: {
    src: 'promptEffects',
    input: ({ context }) => context.domain,
  },
});

export const promptAgentRuntimeProvider = defineAgentRuntimeProvider<
  ReadonlySet<string>,
  PromptRuntime
>(AgentPrompt, {
  id: 'prompt',
  logic: promptActorLogic,
  eager: true,
  durable: {
    events: [PromptAccepted],
    undoable: false,
    transition: (state, event) => {
      if (!(event instanceof PromptAccepted)) return undefined;
      if (state.has(event.promptId)) return state;
      return new Set([...state, event.promptId]);
    },
    read: (snapshot) => (snapshot as unknown as { context: PromptActorContext }).context.admitted,
    commit: (actor, state) => {
      actor.send({ type: 'prompt.commit', admitted: state });
    },
  },
  createApi: (context) => new AgentPromptRuntime(context),
  inspect: (snapshot) => {
    const { context } = snapshot as unknown as { context: PromptActorContext };
    return {
      admitted: context.admitted.size,
      queue: context.domain.list(),
    };
  },
});
