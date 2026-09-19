import { dispatchTools, type PromptGate, type ScopeFactory } from '#/agent/machine';
import { createTurnMachine, type CreateTurnMachineOptions } from '#/agent/turn';
import type { LlmRequestConfig, LlmRequester } from '#/llm/requester/requester';
import { createToolMachine } from '#/tool/machine';

import { mountAgentFeatures, type AgentFeatureUnitProps } from './agentFeatureUnit';
import type { SessionFeatureHost } from './sessionFeatureUnit';

export type FeatureScopeOptions = Omit<AgentFeatureUnitProps, 'self' | 'sessionId' | 'features'> & {
  readonly requester: LlmRequester;
  readonly turnOptions?: CreateTurnMachineOptions;
  readonly request?: LlmRequestConfig;
  readonly promptGate?: PromptGate;
} & ({
  readonly session: SessionFeatureHost;
  readonly features?: AgentFeatureUnitProps['features'];
} | {
  readonly session?: never;
  readonly sessionId: string;
  readonly features: AgentFeatureUnitProps['features'];
});

export type FeatureScopeFactory = (...args: Parameters<ScopeFactory>) => Promise<Awaited<ReturnType<ScopeFactory>> & {
  handle: import('./agentFeatureUnit').AgentFeatureHost;
}>;

export function createAgentScopeFactory(options: FeatureScopeOptions): FeatureScopeFactory {
  return async (self, signal) => {
    signal.throwIfAborted();
    const host = options.session === undefined
      ? mountAgentFeatures({ ...options, self })
      : options.session.mountAgent({ ...options, self });
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([host.ready(), aborted]);
      signal.throwIfAborted();
      const extensions = host.extensions;
      return {
        handle: host,
        store: options.store,
        tools: extensions.tools,
        request: options.request,
        promptGate: options.promptGate,
        toolLogic: createToolMachine({ execute: (input) => dispatchTools(extensions.tools).execute(input) }),
        turnLogic: createTurnMachine(options.requester, {
          ...options.turnOptions,
          getTools: () => extensions.tools.filter((tool) => tool.deferred !== true),
          messageResolvers: [{
            id: 'features',
            resolve: async (messages, context) => {
              await host.ready();
              for (const resolver of [...(options.turnOptions?.messageResolvers ?? []), ...extensions.messageResolvers]) {
                messages = await resolver.resolve(messages, context);
              }
              return messages;
            },
          }],
          onBeforeStep: async (context) => {
            await host.ready();
            await options.turnOptions?.onBeforeStep?.(context);
            const hooks = [...extensions.beforeSteps];
            for (const hook of hooks) await hook(context);
          },
        }),
      };
    } catch (error) {
      const cleanup = await host.disposeAsync().then(
        () => ({ ok: true as const }),
        (cleanupError: unknown) => ({ ok: false as const, error: cleanupError }),
      );
      if (!cleanup.ok) {
        throw new AggregateError([error, cleanup.error], error instanceof Error ? error.message : String(error), { cause: error });
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}
