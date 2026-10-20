import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, shallowRef, useExpose, type Ref } from '@moonshot-ai/agent-core/kernel/index';

import { useLoopEvent } from '#/runtime/index';

export interface LlmRequestTiming {
  readonly requestBuildMs?: number;
  readonly ttftMs: number;
  readonly serverFirstTokenMs: number;
  readonly streamDurationMs: number;
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
}

export interface TimingFace {
  readonly timing: Ref<LlmRequestTiming | undefined>;
}

export const TimingRef = createFacadeToken<TimingFace>('timing');

export const timing = createFeature('timing', {
  agent() {
    const now = Date.now;
    const current = shallowRef<LlmRequestTiming | undefined>(undefined);
    let lastEventAt: number | undefined;
    let retryAnchor: { at: number; delayMs: number } | undefined;
    let sentAt: number | undefined;
    let attemptStartedAt: number | undefined;
    let firstDeltaAt: number | undefined;
    let lastHandledAt = 0;
    let serverDecodeMs = 0;
    let clientConsumeMs = 0;

    const resetWindow = (): void => {
      sentAt = undefined;
      attemptStartedAt = undefined;
      firstDeltaAt = undefined;
      serverDecodeMs = 0;
      clientConsumeMs = 0;
    };

    useLoopEvent('turn.started', () => {
      retryAnchor = undefined;
      lastEventAt = now();
    });
    useLoopEvent('tool.ended', () => {
      lastEventAt = now();
    });
    useLoopEvent('llm.started', () => {
      const t = now();
      attemptStartedAt =
        retryAnchor === undefined ? lastEventAt : retryAnchor.at + retryAnchor.delayMs;
      retryAnchor = undefined;
      sentAt = t;
      firstDeltaAt = undefined;
      serverDecodeMs = 0;
      clientConsumeMs = 0;
      lastEventAt = t;
    });
    useLoopEvent('llm.streaming.part', () => {
      const arrivedAt = now();
      if (sentAt === undefined) return;
      if (firstDeltaAt === undefined) {
        firstDeltaAt = arrivedAt;
      } else {
        serverDecodeMs += arrivedAt - lastHandledAt;
      }
      const handledAt = now();
      clientConsumeMs += handledAt - arrivedAt;
      lastHandledAt = handledAt;
      lastEventAt = handledAt;
    });
    useLoopEvent('llm.retrying', (event) => {
      const t = now();
      retryAnchor = event.reason === 'backoff' ? { at: t, delayMs: event.delayMs } : undefined;
      resetWindow();
      lastEventAt = t;
    });
    useLoopEvent('llm.ended', (event) => {
      if (event.outcome.type === 'aborted') return;
      const t = now();
      if (event.outcome.type === 'done' && sentAt !== undefined && firstDeltaAt !== undefined) {
        serverDecodeMs += t - lastHandledAt;
        current.value = {
          requestBuildMs:
            attemptStartedAt === undefined ? undefined : Math.max(0, sentAt - attemptStartedAt),
          ttftMs: Math.max(0, firstDeltaAt - (attemptStartedAt ?? sentAt)),
          serverFirstTokenMs: Math.max(0, firstDeltaAt - sentAt),
          streamDurationMs: Math.max(0, t - firstDeltaAt),
          serverDecodeMs: Math.max(0, serverDecodeMs),
          clientConsumeMs: Math.max(0, clientConsumeMs),
        };
      }
      if (event.outcome.type === 'failed') retryAnchor = undefined;
      resetWindow();
      lastEventAt = t;
    });
    useExpose(TimingRef, { timing: current });
  },
});
