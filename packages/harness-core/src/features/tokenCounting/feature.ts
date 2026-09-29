import {
  AgentStoreRef,
  ConfigRef,
  createFeature,
  useAgentStore,
  useConfigSection,
} from '@moonshot-ai/agent-core';
import {
  createToken,
  inject,
  pushCleanup,
  shallowRef,
  useExpose,
  useNode,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';

import {
  DEFAULT_TOKEN_COUNTING_CONFIG,
  TOKEN_COUNTING_SECTION,
  tokenCountingConfigSection,
  type TokenCountingConfig,
} from './configSection';
import {
  get,
  latestMeasured,
  requestSize,
  statusSize,
  type ContextSize,
  type TokenCountingRequest,
  type TokenCountingStrategy,
} from './tokenCounting';

export interface TokenCountingFace {
  readonly status: ShallowRef<number>;
  get(start?: number, end?: number): ContextSize;
  statusSize(): number;
  latestMeasured(): number;
  requestSize(request: TokenCountingRequest): number;
}

export const TokenCountingRef = createToken<TokenCountingFace>('tokenCounting');

export const tokenCounting = createFeature('tokenCounting', {
  agent() {
    const node = useNode();
    const store = useAgentStore();
    useConfigSection(tokenCountingConfigSection);
    const configEntries = node.providerRef(ConfigRef);
    const strategy = (): TokenCountingStrategy =>
      configEntries.value.at(-1)?.value.get<TokenCountingConfig | undefined>(TOKEN_COUNTING_SECTION)
        ?.strategy ?? DEFAULT_TOKEN_COUNTING_CONFIG.strategy;
    const currentStatus = (): number => statusSize(store.getState().history, strategy());
    const status = shallowRef(currentStatus());
    pushCleanup(
      node,
      inject(AgentStoreRef).onCommit((entry) => {
        if (entry.event.type === 'turn.ended') {
          status.value = currentStatus();
        }
      }),
    );
    useExpose(TokenCountingRef, {
      status,
      get: (start?: number, end?: number): ContextSize =>
        get(store.getState().history, start, end),
      statusSize: currentStatus,
      latestMeasured: (): number => latestMeasured(store.getState().history),
      requestSize,
    });
  },
});
