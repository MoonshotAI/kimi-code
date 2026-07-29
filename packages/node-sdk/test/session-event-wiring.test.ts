/**
 * `SessionEventWiring` — the in-process v1 edge over the v2 per-agent event
 * bus. Covers the status-snapshot fold: v2 emits `agent.status.updated` in
 * slices and the model slice rides only the bind-time emission, so the
 * wiring merges a consistent usage + context + model snapshot into every
 * status event (mirrors kap-server's broadcaster bridge), including the
 * secondary-model derived id resolution.
 * Run: pnpm exec vitest run test/session-event-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/agent-core';
import {
  ContextSizeModel,
  IAgentContextSizeService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentUsageService,
  IEventBus,
  IModelCatalog,
  ISessionInteractionService,
  IWireService,
  SECONDARY_DERIVED_MODEL_ID,
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
  agent.set(IAgentContextSizeService, { get: () => ({ size: 10 }) });
  agent.set(IAgentProfileService, {
    getModel: () => model,
    getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
  });
  agent.set(IAgentUsageService, { status: () => USAGE });
  agent.set(IWireService, {
    getModel: (requested: unknown) => {
      expect(requested).toBe(ContextSizeModel);
      return { length: 0, tokens: 8 };
    },
  });
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
      sub.bus.emit({ type: 'assistant.delta', delta: 'Hi' });
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
    expect(events[1]).toMatchObject({ type: 'assistant.delta', delta: 'Hi' });
    expect(events[1]).not.toHaveProperty('model');
  });

  it('resolves the secondary derived model id to a display string', () => {
    const sub = new FakeAgentHandle('agent-1');
    bindStatusServices(sub, SECONDARY_DERIVED_MODEL_ID);
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      sub.set(IModelCatalog, {
        get: (id: string) => {
          expect(id).toBe(SECONDARY_DERIVED_MODEL_ID);
          return { id, name: 'kimi-k2-wire', displayName: 'Kimi K2' };
        },
      });
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
      // Without a displayName the pointed entry's wire name is shown.
      sub.set(IModelCatalog, { get: (id: string) => ({ id, name: 'kimi-k2-wire' }) });
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
      // A resolution failure falls back to the raw alias.
      sub.set(IModelCatalog, {
        get: () => {
          throw new Error('unknown model');
        },
      });
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
    } finally {
      wiring.dispose();
    }

    expect(events.map((event) => (event as { model?: string }).model)).toEqual([
      'Kimi K2',
      'kimi-k2-wire',
      SECONDARY_DERIVED_MODEL_ID,
    ]);
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
});
