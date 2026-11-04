import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { AgentLLMRequestFinish, AgentLLMRequestOverrides } from '#/agent/loop/requesterContract';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/features/plan/plan';
import { SessionPromptPredictionService } from '#/features/promptPrediction/promptPredictionService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

function finish(text: string, toolCalls: AgentLLMRequestFinish['message']['toolCalls'] = []): AgentLLMRequestFinish {
  return {
    message: {
      role: 'assistant',
      content: text.length === 0 ? [] : [{ type: 'think', think: 'reasoning' }, { type: 'text', text }],
      toolCalls,
    },
    usage: { inputOther: 3, output: 2, inputCacheRead: 5, inputCacheCreation: 1 },
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
    const requests: Array<{ overrides?: AgentLLMRequestOverrides; signal?: AbortSignal }> = [];
    const requester = {
      start: (overrides?: AgentLLMRequestOverrides, _onPart?: unknown, signal?: AbortSignal) => {
        requests.push({ overrides, signal });
        return { trace: { requestId: 'request-1' }, result: nextResult() };
      },
    };
    const loop = {
      requester,
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
          if (token === IAgentContextMemoryService) return { get: () => contextSnapshot };
          if (token === IAgentStateService) return { get: () => ({ lastEnded }) };
          if (token === IAgentPlanService) return { status: async () => null };
          if (token === IAgentToolRegistryService) {
            return {
              list: () => [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' } }],
            };
          }
          if (token === IAgentScopeContext) return { agentContext: { agentId: MAIN_AGENT_ID } };
          throw new Error('unexpected service');
        },
      },
    };
    const activityEmitter = new Emitter<never>();
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
    const usage = {
      status: () => ({
        currentTurn: { inputOther: 4, output: 1, inputCacheCreation: 2 },
      }),
    } as unknown as ISessionUsageService;
    const flags = { enabled: () => enabled } as unknown as IFlagService;
    const telemetry = { track2: vi.fn() } as unknown as ITelemetryService;
    const service = new SessionPromptPredictionService(lifecycle, activity, usage, flags, telemetry);

    await expect(service.predict({ predictionId: 'disabled', expectedTurnId: 0 })).resolves.toBeNull();
    enabled = true;
    await expect(service.predict({ predictionId: 'first', expectedTurnId: 0 })).resolves.toBe(
      'inspect the failing test',
    );
    await expect(service.predict({ predictionId: 'duplicate', expectedTurnId: 0 })).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.overrides?.source).toEqual({
      type: 'operation',
      turnId: 0,
      requestKind: 'prompt_prediction',
    });
    expect(requests[0]?.overrides?.messages).toHaveLength(2);
    expect(requests[0]?.overrides?.tools).toHaveLength(1);
    expect(contextSnapshot).toBe(originalContext);
    expect(contextSnapshot).toHaveLength(1);

    lastEnded = { turnId: 1, reason: 'completed' };
    nextResult = () => Promise.resolve(finish('', [{ type: 'function', id: 'call-1', name: 'Read', arguments: '{}' }]));
    await expect(service.predict({ predictionId: 'tools', expectedTurnId: 1 })).resolves.toBeNull();
    expect(contextSnapshot).toBe(originalContext);
    expect(requests).toHaveLength(2);

    lastEnded = { turnId: 2, reason: 'completed' };
    nextResult = () => new Promise<AgentLLMRequestFinish>(() => {});
    const cancelled = service.predict({ predictionId: 'cancel-me', expectedTurnId: 2 });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(service.cancel('other')).toBe(false);
    expect(service.cancel('cancel-me')).toBe(true);
    expect(service.cancel('cancel-me')).toBe(false);
    await expect(cancelled).resolves.toBeNull();
    expect(requests[2]?.signal?.aborted).toBe(true);

    lastEnded = { turnId: 3, reason: 'completed' };
    let resolveStale!: (result: AgentLLMRequestFinish) => void;
    nextResult = () => new Promise<AgentLLMRequestFinish>((resolve) => {
      resolveStale = resolve;
    });
    const stale = service.predict({ predictionId: 'stale', expectedTurnId: 3 });
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    contextSnapshot = [];
    resolveStale(finish('must not leak'));
    await expect(stale).resolves.toBeNull();

    lastEnded = { turnId: 4, reason: 'completed' };
    contextSnapshot = originalContext;
    nextResult = () => new Promise<AgentLLMRequestFinish>(() => {});
    const disposed = service.predict({ predictionId: 'dispose', expectedTurnId: 4 });
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    service.dispose();
    await expect(disposed).resolves.toBeNull();
    expect(requests[4]?.signal?.aborted).toBe(true);
    expect(service.cancel('dispose')).toBe(false);
  });
});
