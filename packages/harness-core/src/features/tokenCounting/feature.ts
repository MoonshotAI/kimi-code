import { createFeature, useAgent } from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, shallowRef, useExpose, useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import { ConfigRef, useConfigSection } from '#/features/config/index';
import { useLoopEvent } from '#/runtime/index';

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

export const TokenCountingRef = createFacadeToken<TokenCountingFace>('tokenCounting');

export const tokenCounting = createFeature('tokenCounting', {
  agent() {
    const agent = useAgent();
    useConfigSection(tokenCountingConfigSection);
    const config = useInject(ConfigRef);
    const strategy = (): TokenCountingStrategy =>
      config.value?.get<TokenCountingConfig | undefined>(TOKEN_COUNTING_SECTION)?.strategy ??
      DEFAULT_TOKEN_COUNTING_CONFIG.strategy;
    const currentStatus = (): number => statusSize(agent.view.getState().messages, strategy());
    const status = shallowRef(currentStatus());
    useLoopEvent('turn.ended', () => {
      queueMicrotask(() => {
        void agent.flush().then(() => {
          status.value = currentStatus();
        });
      });
    });
    useExpose(TokenCountingRef, {
      status,
      get: (start?: number, end?: number): ContextSize => get(agent.view.getState().messages, start, end),
      statusSize: currentStatus,
      latestMeasured: (): number => latestMeasured(agent.view.getState().messages),
      requestSize,
    });
  },
});
