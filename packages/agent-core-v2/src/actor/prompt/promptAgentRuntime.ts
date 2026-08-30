import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
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
import { promptActorLogic, type PromptActorSnapshot } from './internal/promptMachine';
import {
  abortPrompt,
  clearPrompts,
  drainPrompts,
  enqueuePrompt,
  injectPrompt,
  listPrompts,
  registerBeforeSubmitHook,
  reserveAdmission,
  retryPrompt,
  steerPrompts,
  submitMessage,
  submitPrompt,
} from './internal/promptOperations';
import { PromptAccepted } from './promptOps';

export type { PromptRuntime } from './prompt';

export class AgentPromptRuntime implements PromptRuntime {
  constructor(private readonly context: AgentRuntimeContext<ReadonlySet<string>>) {}

  submit(input: PromptSubmitInput): Promise<PromptSubmitResult> {
    return submitPrompt(this.context, input);
  }

  reserveAdmission(promptId?: string): PromptAdmissionReservation {
    return reserveAdmission(this.context, promptId);
  }

  submitMessage(message: ContextMessage): Promise<PromptHandle> {
    return submitMessage(this.context, message);
  }

  enqueue(input: PromptInput): Promise<PromptHandle> {
    return enqueuePrompt(this.context, input);
  }

  list(): PromptQueueSnapshot {
    return listPrompts(this.context);
  }

  steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    return steerPrompts(this.context, promptIds);
  }

  abort(promptId: string, reason?: Error): boolean {
    return abortPrompt(this.context, promptId, reason);
  }

  drain(reason?: Error): Promise<void> {
    return drainPrompts(this.context, reason);
  }

  inject(message: ContextMessage): Promise<Turn | undefined> {
    return injectPrompt(this.context, message);
  }

  retry(): Promise<Turn | undefined> {
    return retryPrompt(this.context);
  }

  clear(): void {
    clearPrompts(this.context);
  }

  registerBeforeSubmitHook(name: string, hook: PromptBeforeSubmitHook) {
    return registerBeforeSubmitHook(this.context, name, hook);
  }
}

export const AgentPrompt = defineAgentRuntimeContract<PromptRuntime>('prompt');

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
    read: (snapshot) => (snapshot as PromptActorSnapshot).context.admitted,
    commit: (actor, state) => {
      actor.send({ type: 'prompt.commit', admitted: state });
    },
  },
  createApi: (context) => new AgentPromptRuntime(context),
  inspect: (snapshot) => {
    const { context } = snapshot as PromptActorSnapshot;
    return {
      admitted: context.admitted.size,
      queue: {
        active: context.active?.id,
        launching: context.launching?.id,
        pending: context.pending.map((record) => record.id),
        steering: context.steering,
      },
    };
  },
});
