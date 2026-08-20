/**
 * `SessionEventWiring` — the in-process v1 edge over the v2 per-agent event
 * bus. Covers the status-snapshot fold: v2 emits `agent.status.updated` in
 * slices and the model slice rides only the bind-time emission, so the
 * wiring merges a consistent usage + context + model snapshot into every
 * status event (mirrors kap-server's broadcaster bridge).
 * Run: pnpm exec vitest run test/session-event-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/agent-core';
import {
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentScopeContext,
  IEventBus,
  ISessionInteractionService,
  ISessionTokenCountingService,
  ISessionUsageService,
  makeAgentScopeContext,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import { SessionEventWiring, type SessionEventSink } from '#/v2/session-wiring';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FakeBusEvent = { type: string } & Record<string, unknown>;

class FakeAgentBus {
  private handlers: Array<(e: FakeBusEvent) => void> = [];
  subscribe(handler: (e: FakeBusEvent) => void): { dispose(): void } {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: FakeBusEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
}

class FakeAgentHandle {
  readonly kind = 2;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  private readonly services = new Map<unknown, unknown>();
  constructor(readonly id: string) {
    this.services.set(
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: id, agentScope: `agents/${id}` }),
    );
    this.services.set(IEventBus, this.bus);
    this.accessor = {
      get: (token: unknown) => this.services.get(token),
    };
  }
  set(token: unknown, service: unknown): void {
    this.services.set(token, service);
  }
  dispose(): void {}
}

function makeSession(agents: FakeAgentHandle[]): ISessionScopeHandle {
  const lifecycle = {
    list: () => agents,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  const interactions = {
    onDidChangePending: () => ({ dispose: () => {} }),
    listPending: () => [],
  };
  const accessor = {
    get: (token: unknown): unknown => {
      if (token === IAgentLifecycleService) return lifecycle;
      if (token === ISessionInteractionService) return interactions;
      return undefined;
    },
  };
  return { id: 's1', kind: 1, accessor, dispose: () => {} } as unknown as ISessionScopeHandle;
}

function collectingSink(): { sink: SessionEventSink; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    sink: {
      receiveEvent: (event) => {
        events.push(event);
      },
      requestApproval: () => Promise.resolve('cancelled' as never),
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
    },
  };
}

const USAGE = {
  total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
};

function bindStatusServices(agent: FakeAgentHandle, model: string): void {
  agent.set(ISessionTokenCountingService, { statusSize: () => 10 });
  agent.set(IAgentProfileService, {
    getModel: () => model,
    getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
  });
  agent.set(ISessionUsageService, { status: () => USAGE });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventWiring status snapshot fold', () => {
  it('folds a consistent usage + context + model snapshot into every status event', () => {
    const sub = new FakeAgentHandle('agent-1');
    bindStatusServices(sub, 'sub-model');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      // The v2 model slice rides only the subagent's bind-time emission, which
      // reaches clients before `subagent.spawned` and is dropped there; a
      // later usage-only slice must still carry the model at this edge.
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
      // Non-status events pass through untouched.
      sub.bus.emit({ type: 'assistant.delta', delta: 'Hi', time: 1_700_000_000_123 });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'agent.status.updated',
      sessionId: 's1',
      agentId: 'agent-1',
      usage: USAGE,
      contextTokens: 10,
      maxContextTokens: 128_000,
      model: 'sub-model',
    });
    expect(events[1]).toMatchObject({
      type: 'assistant.delta',
      delta: 'Hi',
      time: 1_700_000_000_123,
    });
    expect(events[1]).not.toHaveProperty('model');
  });

  it('passes status events through unchanged when the agent services are incomplete', () => {
    const sub = new FakeAgentHandle('agent-1');
    // No profile/usage/context/wire services bound — nothing to fold in.
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'agent.status.updated', usage: USAGE });
    expect(events[0]).not.toHaveProperty('model');
  });

  it('strips the internal promptAttachments field from turn.started', () => {
    const sub = new FakeAgentHandle('agent-1');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      // `promptAttachments` is transcript-projection metadata: kap-server
      // strips it from the WS wire event, so SDK consumers must not see it
      // either.
      sub.bus.emit({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'user' },
        prompt: 'describe this',
        promptAttachments: [{ kind: 'image', fileId: 'f_1' }],
      });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'turn.started',
      turnId: 1,
      sessionId: 's1',
      agentId: 'agent-1',
      prompt: 'describe this',
    });
    expect(events[0]).not.toHaveProperty('promptAttachments');
  });
});
