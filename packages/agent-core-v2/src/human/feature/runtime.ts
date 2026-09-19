import type { AgentEmitted, AgentMachineSelf } from '#/agent/machine';
import { createSystemEntry, createUserEntry } from '#/agent/turn';
import { createToken, currentUnit, hasCurrentUnit, pushCleanup } from '#/kernel/index';
import type { SystemMessage, UserMessage } from '#/llm/message';
import type { Subscription } from '#/xstate2';

export interface AgentContextValue {
  readonly sessionId: string;
  readonly agentId: string;
}

export interface AgentRuntimeValue {
  on<T extends AgentEmitted['type']>(type: T, handler: (event: Extract<AgentEmitted, { type: T }>) => void): Subscription;
  notify(message: UserMessage): void;
  remind(key: string, message: UserMessage | SystemMessage): void;
}

export const AgentScope = createToken<import('#/kernel/index').EffectScope>('feature.agentScope');

export const SessionFeatureReady = createToken<() => Promise<void>>('feature.sessionReady');

export const AgentContext = createToken<AgentContextValue>('AgentContext');

export const AgentRuntime = createToken<AgentRuntimeValue>('AgentRuntime');

export function createAgentRuntime(actor: Pick<AgentMachineSelf, 'on' | 'send'>): AgentRuntimeValue {
  return {
    on: (type, handler) => {
      const subscription = actor.on(type, (event) => handler(event as Parameters<typeof handler>[0]));
      if (hasCurrentUnit()) {
        pushCleanup(currentUnit(), () => subscription.unsubscribe());
      }
      return subscription;
    },
    notify: (message) => actor.send({ type: 'input.notify', entry: { message } }),
    remind: (key, message) => actor.send({
      type: 'input.remind',
      key,
      entry: message.role === 'system' ? createSystemEntry(message) : createUserEntry(message),
    }),
  };
}
