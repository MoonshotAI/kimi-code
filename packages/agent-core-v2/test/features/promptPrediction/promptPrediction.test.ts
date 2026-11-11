import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { CoreLoopRequester, OperationLoopRequesterOptions } from '#/agent/loop/requesterContract';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/features/plan/plan';
import { SessionPromptPredictionService } from '#/features/promptPrediction/promptPredictionService';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionActivityView,
  type SessionActivityChangedEvent,
} from '#/session/sessionActivity/sessionActivity';

type PredictionOutcome = Extract<LlmOutcome, { type: 'done' }>;

function finish(
  text: string,
  toolCalls: PredictionOutcome['entry']['message']['toolCalls'] = [],
  finishReason: NonNullable<PredictionOutcome['finish']>['finishReason'] = 'completed',
): PredictionOutcome {
  return {
    type: 'done',
    finish: { finishReason, rawFinishReason: finishReason },
    entry: {
      message: {
        role: 'assistant',
        content: text.length === 0 ? [] : [{ type: 'think', think: 'reasoning' }, { type: 'text', text }],
        toolCalls,
      },
    },
    usage: { inputOther: 3, output: 2, inputCacheRead: 5, inputCacheCreation: 1 },
    timing: {
      firstTokenLatencyMs: 120,
      streamDurationMs: 230,
      requestBuildMs: 3,
      serverFirstTokenMs: 117,
      serverDecodeMs: 220,
      clientConsumeMs: 4,
      clientBlockedMs: 200,
    },
    requestId: 'request-1',
  };
}

describe('SessionPromptPredictionService', () => {
  it('keeps prediction isolated, strictly once, cancellable, and stale-safe', async () => {
    let enabled = false;
    let lastEnded = { turnId: 0, reason: 'completed' as const };
    let contextSnapshot: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const originalContext = contextSnapshot;
    let nextResult = () => Promise.resolve(finish('inspect the failing test'));
    const requests: Array<{
      options: OperationLoopRequesterOptions;
      input?: Parameters<CoreLoopRequester['generate']>[0];
      signal?: AbortSignal;
    }> = [];
    const requester = {
      prepareOperation: async (options: OperationLoopRequesterOptions, signal: AbortSignal) => {
        const request: (typeof requests)[number] = { options, signal };
        requests.push(request);
        options.onTrace?.({ requestId: 'request-1' });
        return {
          generate: (
            input: Parameters<CoreLoopRequester['generate']>[0],
            control: { signal: AbortSignal },
          ) => {
            request.input = input;
            request.signal = control.signal;
            return nextResult();
          },
        };
      },
    };
    const loop = {
      requester,
      history: () => contextSnapshot,
      snapshot: () => ({
        state: 'idle',
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: false,
      }),
    };
    const handle = {
      id: MAIN_AGENT_ID,
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentLoopService) return loop;
          if (token === IAgentStateService) return { get: () => ({ lastEnded }) };
          if (token === IAgentPlanService) return { status: async () => null };
          if (token === IAgentScopeContext) return { agentContext: { agentId: MAIN_AGENT_ID } };
          if (token === ITelemetryService) return telemetry;
          throw new Error('unexpected service');
        },
      },
    };
    const activityEmitter = new Emitter<SessionActivityChangedEvent>();
    const lifecycle = {
      handleOf: (id: string) => id === MAIN_AGENT_ID ? handle : undefined,
      onWillClose: new Emitter<never>().event,
      onDidCreateScope: new Emitter<never>().event,
      onDidClose: new Emitter<never>().event,
    } as unknown as IAgentLifecycleService;
    const activity = {
      state: () => ({
        busy: false,
        mainTurnActive: false,
        pendingInteraction: 'none',
        lastTurnReason: 'completed',
      }),
      onDidChange: activityEmitter.event,
    } as unknown as ISessionActivityView;
    const flags = { enabled: () => enabled } as unknown as IFlagService;
    const log = { info: vi.fn() } as unknown as ILogService;
    const telemetry = { track2: vi.fn() } as unknown as ITelemetryService;
    const service = new SessionPromptPredictionService(lifecycle, activity, flags, log);

    await expect(service.predict({ predictionId: 'disabled', expectedTurnId: 0 })).resolves.toBeNull();
    enabled = true;
    await expect(service.predict({ predictionId: 'first', expectedTurnId: 0 })).resolves.toBe(
      'inspect the failing test',
    );
    await expect(service.predict({ predictionId: 'duplicate', expectedTurnId: 0 })).resolves.toBeNull();
    expect(log.info).toHaveBeenCalledWith('prompt prediction finished', expect.objectContaining({
      status: 'generated',
      input_other: 3,
      cache_read_pct: 55.56,
      ttft_ms: 120,
      stream_duration_ms: 230,
      request_build_ms: 3,
      server_first_token_ms: 117,
      server_decode_ms: 220,
      client_consume_ms: 4,
      client_blocked_ms: 200,
    }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.options.source()).toEqual({
      type: 'operation',
      turnId: 0,
      requestKind: 'prompt_prediction',
    });
    expect(requests[0]?.input?.content?.entries).toHaveLength(2);
    expect(requests[0]?.input?.content?.entries?.at(-1)?.message).toEqual({
      role: 'user',
      content: [{
        type: 'text',
        text: expect.stringMatching(
          /predict what THEY would type[\s\S]*NEVER SUGGEST[\s\S]*Stay silent if the next step[\s\S]*Format: 2-12 words, match the user's style and language\. Or nothing\./,
        ),
      }],
    });
    expect(requests[0]?.options.tools).toBeUndefined();
    expect(contextSnapshot).toBe(originalContext);
    expect(contextSnapshot).toHaveLength(1);

    lastEnded = { turnId: 1, reason: 'completed' };
    nextResult = () => Promise.resolve(finish('', [{ type: 'function', id: 'call-1', name: 'Read', arguments: '{}' }]));
    await expect(service.predict({ predictionId: 'tools', expectedTurnId: 1 })).resolves.toBeNull();
    expect(contextSnapshot).toBe(originalContext);
    expect(requests).toHaveLength(2);

    lastEnded = { turnId: 2, reason: 'completed' };
    nextResult = () => Promise.resolve(finish('run this\u001b[2J'));
    await expect(service.predict({ predictionId: 'control', expectedTurnId: 2 })).resolves.toBeNull();
    expect(requests).toHaveLength(3);

    lastEnded = { turnId: 3, reason: 'completed' };
    nextResult = () => Promise.resolve(finish('partial', [], 'filtered'));
    await expect(service.predict({ predictionId: 'filtered', expectedTurnId: 3 })).resolves.toBeNull();
    expect(requests).toHaveLength(4);

    lastEnded = { turnId: 4, reason: 'completed' };
    nextResult = () => new Promise<PredictionOutcome>(() => {});
    const cancelled = service.predict({ predictionId: 'cancel-me', expectedTurnId: 4 });
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(service.cancel('other')).toBe(false);
    expect(service.cancel('cancel-me', 'escape')).toBe(true);
    expect(service.cancel('cancel-me', 'escape')).toBe(false);
    await expect(cancelled).resolves.toBeNull();
    expect(requests[4]?.signal?.aborted).toBe(true);
    expect(telemetry.track2).toHaveBeenCalledWith('prediction_generated', expect.objectContaining({
      status: 'cancelled',
      reason: 'escape',
    }));
    expect(log.info).toHaveBeenCalledWith('prompt prediction finished', expect.objectContaining({
      status: 'cancelled',
      reason: 'escape',
    }));

    lastEnded = { turnId: 5, reason: 'completed' };
    let resolveStale!: (result: PredictionOutcome) => void;
    nextResult = () => new Promise<PredictionOutcome>((resolve) => {
      resolveStale = resolve;
    });
    const stale = service.predict({ predictionId: 'stale', expectedTurnId: 5 });
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    contextSnapshot = [];
    resolveStale(finish('must not leak'));
    await expect(stale).resolves.toBeNull();

    lastEnded = { turnId: 6, reason: 'completed' };
    contextSnapshot = originalContext;
    nextResult = () => new Promise<PredictionOutcome>(() => {});
    const activityCancelled = service.predict({ predictionId: 'activity-cancelled', expectedTurnId: 6 });
    await vi.waitFor(() => expect(requests).toHaveLength(7));
    activityEmitter.fire({
      state: {
        busy: true,
        mainTurnActive: false,
        pendingInteraction: 'none',
        lastTurnReason: 'completed',
      },
      cause: 'background',
    });
    await expect(activityCancelled).resolves.toBeNull();
    expect(requests[6]?.signal?.aborted).toBe(true);
    expect(telemetry.track2).toHaveBeenCalledWith('prediction_generated', expect.objectContaining({
      status: 'cancelled',
      reason: 'activity_background',
    }));

    lastEnded = { turnId: 7, reason: 'completed' };
    vi.useFakeTimers();
    const timedOut = service.predict({ predictionId: 'timeout', expectedTurnId: 7 });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(8);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(timedOut).resolves.toBeNull();
      expect(requests[7]?.signal?.aborted).toBe(true);
      expect(telemetry.track2).toHaveBeenCalledWith('prediction_generated', expect.objectContaining({
        status: 'timeout',
      }));
    } finally {
      vi.useRealTimers();
    }

    lastEnded = { turnId: 8, reason: 'completed' };
    const disposed = service.predict({ predictionId: 'dispose', expectedTurnId: 8 });
    await vi.waitFor(() => expect(requests).toHaveLength(9));
    service.dispose();
    await expect(disposed).resolves.toBeNull();
    expect(requests[8]?.signal?.aborted).toBe(true);
    expect(telemetry.track2).toHaveBeenCalledWith('prediction_generated', expect.objectContaining({
      status: 'cancelled',
      reason: 'disposed',
    }));
    expect(service.cancel('dispose')).toBe(false);
  });
});
