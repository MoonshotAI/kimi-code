import { describe, expect, it, vi } from 'vitest';

import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { WireRecord } from '#/wire/record';
import { FeedbackModelRequestRecorded } from '#/session/feedback/feedbackContext';
import { SessionFeedbackContextService } from '#/session/feedback/feedbackContextService';
import { SessionRequestAttributionService } from '#/session/requestAttribution/requestAttributionService';
import { requestMetadataHeaders } from '#/agent/loop/requestMetadata';
import { AgentLoopRequestObserver } from '#/agent/loop/requestObservation';
import { AgentStateService } from '#/agent/state/agentStateService';
import type { RequestConfigSnapshot, ResolvedRequestContext } from '#/agent/loop/requesterContract';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import type { ILogService } from '#/_base/log/log';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

const context = makeSessionContext({
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  sessionDir: '/tmp/session-1',
  sessionScope: 'workspaces/workspace-1/sessions/session-1',
  cwd: '/tmp',
});

class StoredLogs {
  readonly records = new Map<string, WireRecord[]>();

  add(agentId: string, event: FeedbackModelRequestRecorded): void {
    this.addRaw(agentId, event.serialize());
  }

  addRaw(agentId: string, record: WireRecord): void {
    const scope = context.scope(`agents/${agentId}`);
    const records = this.records.get(scope) ?? [];
    records.push(record);
    this.records.set(scope, records);
  }

  reader(): IAppendLogStore {
    return {
      read: <R>(scope: string): AsyncIterable<R> => {
        const records = this.records.get(scope) ?? [];
        return (async function* (): AsyncGenerator<R> {
          for (const record of records) yield record as R;
        })();
      },
      flush: async () => {},
    } as unknown as IAppendLogStore;
  }
}

function reader(logs: StoredLogs): SessionFeedbackContextService {
  const metadata = {
    read: async () => ({ agents: { main: {}, 'sub-1': {} } }),
  } as unknown as ISessionMetadata;
  return new SessionFeedbackContextService(logs.reader(), context, metadata);
}

function request(
  agentId: string,
  input: {
    readonly rootTurnId?: number;
    readonly turnId?: number;
    readonly step: number;
    readonly model: string;
    readonly provider: string;
    readonly traceId?: string;
    readonly time: number;
  },
): FeedbackModelRequestRecorded {
  return new FeedbackModelRequestRecorded({
    agentId,
    rootTurnId: input.rootTurnId ?? 7,
    turnId: input.turnId ?? input.step,
    step: input.step,
    model: input.model,
    provider: input.provider,
    traceId: input.traceId,
  }, input.time);
}

describe('SessionFeedbackContextService', () => {
  it('rebuilds main and subagent facts with numeric steps and model-provider deduplication', async () => {
    const logs = new StoredLogs();
    logs.add('main', request('main', { step: 1, model: 'model-a', provider: 'kimi', traceId: 'trace-a', time: 100 }));
    logs.add('sub-1', request('sub-1', { step: 1, turnId: 1, model: 'model-a', provider: 'kimi', time: 110 }));
    logs.add('main', request('main', { step: 2, model: 'model-b', provider: 'openai', traceId: 'trace-old', time: 120 }));
    logs.add('sub-1', request('sub-1', { step: 9, turnId: 2, model: 'model-c', provider: 'anthropic', time: 130 }));
    logs.add('main', request('main', { step: 10, model: 'model-b', provider: 'openai', time: 140 }));
    logs.add('main', request('main', { step: 10, model: 'model-final', provider: 'openai', traceId: 'trace-final', time: 150 }));

    const expected = {
      model: 'model-final',
      provider: 'openai',
      traceId: 'trace-final',
      participantModels: [
        { model: 'model-a', provider: 'kimi' },
        { model: 'model-b', provider: 'openai' },
        { model: 'model-c', provider: 'anthropic' },
        { model: 'model-final', provider: 'openai' },
      ],
    };
    await expect(reader(logs).read(7)).resolves.toEqual(expected);
    await expect(reader(logs).read(7)).resolves.toEqual(expected);
  });

  it('omits trace when the final main step did not provide one', async () => {
    const logs = new StoredLogs();
    logs.add('main', request('main', { step: 1, model: 'model-a', provider: 'kimi', traceId: 'trace-old', time: 100 }));
    logs.add('main', request('main', { step: 2, model: 'model-a', provider: 'kimi', time: 200 }));

    const result = await reader(logs).read(7);
    expect(result).toMatchObject({ model: 'model-a', provider: 'kimi' });
    expect(result?.traceId).toBeUndefined();
  });

  it('returns unknown for old logs and unrelated root turns', async () => {
    const logs = new StoredLogs();
    logs.addRaw('main', { type: 'metadata', time: 50 });
    logs.add('main', request('main', { rootTurnId: 8, step: 1, model: 'model-a', provider: 'kimi', time: 100 }));

    await expect(reader(logs).read(7)).resolves.toBeUndefined();
  });
});

describe('feedback request attribution', () => {
  it('inherits the parent root turn without adding it to external headers', () => {
    const attribution = new SessionRequestAttributionService();
    attribution.noteRootTurn('main', 12);

    expect(attribution.noteSubagentDispatch('sub-1', 'main')).toMatchObject({ rootTurnId: 12 });
    const headers = requestMetadataHeaders({ agentRole: 'main', rootTurnId: 12 });
    const metadata = JSON.parse(headers['X-Msh-Client-Metadata']!) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('rootTurnId');
    expect(metadata).not.toHaveProperty('root_turn_id');
  });
});

describe('AgentLoopRequestObserver feedback facts', () => {
  it('persists the actual completed request context', () => {
    const dispatcher = { dispatch: vi.fn(async (_event: FeedbackModelRequestRecorded) => {}) };
    const usage = { record: vi.fn(async () => {}) };
    const source = { type: 'turn' as const, rootTurnId: 7, turnId: 3, step: 2 };
    const observer = new AgentLoopRequestObserver(
      {} as ILogService,
      { setContext: vi.fn() } as unknown as ITelemetryService,
      dispatcher as unknown as IEventDispatcher,
      usage as unknown as ISessionUsageService,
      {} as ISessionTokenCountingService,
      { agentId: 'main', agentContext: {} } as unknown as IAgentScopeContext,
      new AgentStateService(),
      new SessionRequestAttributionService(),
    );
    const observation = observer.start(source, {} as RequestConfigSnapshot);
    observation.prepare({
      source,
      model: { id: 'actual-model', providerType: undefined, protocol: 'kimi' },
      modelAlias: 'configured-alias',
      promptCacheProbe: undefined,
      messages: [],
      logFields: {},
    } as unknown as ResolvedRequestContext);
    const outcome = {
      requestId: 'trace-actual',
      message: {},
      usage: undefined,
      timing: undefined,
    } as unknown as Extract<LlmOutcome, { type: 'done' }>;

    observer.completeRequest(observation, outcome);

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    const event = dispatcher.dispatch.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(FeedbackModelRequestRecorded);
    expect(event).toMatchObject({
      agentId: 'main',
      rootTurnId: 7,
      turnId: 3,
      step: 2,
      model: 'actual-model',
      provider: 'kimi',
      traceId: 'trace-actual',
    });
  });
});
