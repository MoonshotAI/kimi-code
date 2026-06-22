import { UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';
import type { Event as ProtocolEvent, SessionStatus } from '@moonshot-ai/protocol';
import { describe, expect, it, vi } from 'vitest';

import { Emitter, IInstantiationService } from '../../src';
import type { IAgentConfigService } from '../../src/agent/config';
import type { IContextService } from '../../src/agent/context';
import type { IPermissionService, PermissionMode } from '../../src/agent/permission';
import type { IPlanService } from '../../src/agent/plan';
import type { IRecordsService } from '../../src/agent/records';
import { AgentStatusService, type AgentStatusHost } from '../../src/agent/status';
import type { ISwarmService } from '../../src/agent/swarm';
import type { IUsageService } from '../../src/agent/usage';
import { TestInstantiationService } from '#/_base/di/test';
import type { IDomainEventBus } from '../../src/event/event-bus';
import type { AgentEvent, UsageStatus } from '../../src/rpc';
import {
  IApprovalService,
  type ICoreRuntime,
  type IEventService,
  IPromptService,
  IQuestionService,
} from '../../src/services';
import { SessionRuntimeService } from '../../src/services/session/sessionRuntimeService';

// ─── status projection model ────────────────────────────────────────────────
//
// Two projections publish status events. Both are driven from the outside:
// neither service reaches back into `Agent` through a callback closure.
//
// 1. `agent.status.updated` — service-driven.
//    Status-driving services (plan / swarm / usage) call
//    `IAgentStatusService.notifyStatusChanged()` after mutating state. The
//    service reads its inputs lazily from an injected `AgentStatusHost` and
//    publishes the event on the domain event bus.
//
// 2. `session.status_changed` — event-driven.
//    `SessionRuntimeService` subscribes to `IEventService.onDidPublish`. When a
//    relevant bus event arrives it recomputes the per-session status, fires its
//    local `onDidChangeStatus`, and republishes `event.session.status_changed`.
//
// This file pins both trigger chains so the projection model stays event /
// service driven and no "service calls Agent" status callback creeps back in.

// ─── agent.status.updated helpers ───────────────────────────────────────────

interface HostOverrides {
  readonly restoring?: boolean;
  readonly hasModel?: boolean;
  readonly model?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number | undefined;
  readonly usage?: UsageStatus | undefined;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly permission?: PermissionMode;
}

function makeHost(overrides: HostOverrides = {}): {
  host: AgentStatusHost;
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  const modelCapabilities = {
    ...UNKNOWN_CAPABILITY,
    max_context_tokens: overrides.maxContextTokens,
  };
  const restoring = overrides.restoring ?? false;
  const host: AgentStatusHost = {
    records: { restoring: restoring ? { time: 0 } : null } as unknown as IRecordsService,
    config: {
      hasModel: overrides.hasModel ?? true,
      model: overrides.model ?? 'test-model',
      modelCapabilities,
    } as unknown as IAgentConfigService,
    context: {
      tokenCount: overrides.contextTokens ?? 0,
    } as unknown as IContextService,
    usage: {
      status: () => overrides.usage,
    } as unknown as IUsageService,
    planMode: { isActive: overrides.planMode ?? false } as unknown as IPlanService,
    swarmMode: { isActive: overrides.swarmMode ?? false } as unknown as ISwarmService,
    permission: { mode: overrides.permission ?? 'manual' } as unknown as IPermissionService,
    eventBus: {
      publish: (event: AgentEvent) => {
        events.push(event);
      },
    } as unknown as IDomainEventBus,
  };
  return { host, events };
}

// ─── session.status_changed helpers ─────────────────────────────────────────

function makeEventServiceStub(): {
  eventService: IEventService;
  published: ProtocolEvent[];
} {
  const published: ProtocolEvent[] = [];
  const emitter = new Emitter<ProtocolEvent>();
  return {
    published,
    eventService: {
      _serviceBrand: undefined,
      publish: vi.fn((event: ProtocolEvent) => {
        published.push(event);
        emitter.fire(event);
      }) as IEventService['publish'],
      onDidPublish: emitter.event,
    },
  };
}

function makeRuntimeService(): {
  svc: SessionRuntimeService;
  eventBus: ReturnType<typeof makeEventServiceStub>;
  dispose: () => void;
} {
  const eventBus = makeEventServiceStub();
  const promptService: IPromptService = {
    _serviceBrand: undefined,
    getCurrentPromptId: vi.fn().mockReturnValue(undefined),
  } as unknown as IPromptService;
  const approvalService: IApprovalService = {
    _serviceBrand: undefined,
    listPending: vi.fn().mockReturnValue([]),
  } as unknown as IApprovalService;
  const questionService: IQuestionService = {
    _serviceBrand: undefined,
    listPending: vi.fn().mockReturnValue([]),
  } as unknown as IQuestionService;

  const instantiation = new TestInstantiationService(undefined, true);
  instantiation.stub(IInstantiationService, instantiation);
  instantiation.stub(IPromptService, promptService);

  const core = { _serviceBrand: undefined } as unknown as ICoreRuntime;

  const svc = new SessionRuntimeService(
    core,
    eventBus.eventService,
    instantiation,
    approvalService,
    questionService,
  );
  return {
    svc,
    eventBus,
    dispose: () => {
      svc.dispose();
      instantiation.dispose();
    },
  };
}

function statusEvent(
  overrides: { type: string; sessionId: string; reason?: string },
): ProtocolEvent {
  return overrides as unknown as ProtocolEvent;
}

// ─── agent.status.updated chain ─────────────────────────────────────────────

describe('agent.status.updated projection (service-driven)', () => {
  it('publishes when a status-driving service notifies a plan-mode change', () => {
    const { host, events } = makeHost({ planMode: true });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('agent.status.updated');
    if (event?.type !== 'agent.status.updated') throw new Error('unexpected event type');
    expect(event.planMode).toBe(true);
  });

  it('publishes when a status-driving service notifies a swarm-mode change', () => {
    const { host, events } = makeHost({ swarmMode: true });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    const event = events[0];
    expect(event?.type).toBe('agent.status.updated');
    if (event?.type !== 'agent.status.updated') throw new Error('unexpected event type');
    expect(event.swarmMode).toBe(true);
  });

  it('keeps the restoring gate so no event leaks mid-restore', () => {
    const { host, events } = makeHost({ restoring: true, planMode: true });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    expect(events).toHaveLength(0);
  });
});

// ─── session.status_changed chain ───────────────────────────────────────────

describe('session.status_changed projection (event-driven)', () => {
  it('fires onDidChangeStatus and republishes when a turn.started bus event arrives', () => {
    const { svc, eventBus, dispose } = makeRuntimeService();
    try {
      const listener = vi.fn();
      svc.onDidChangeStatus(listener);

      eventBus.eventService.publish(statusEvent({ type: 'turn.started', sessionId: 's' }));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's',
          status: 'running' satisfies SessionStatus,
          previousStatus: 'idle' satisfies SessionStatus,
        }),
      );
      const republished = eventBus.published.find(
        (e) => (e as { type?: string }).type === 'event.session.status_changed',
      );
      expect(republished).toMatchObject({
        type: 'event.session.status_changed',
        sessionId: 's',
        status: 'running',
        previous_status: 'idle',
      });
    } finally {
      dispose();
    }
  });

  it('transitions running -> idle when turn.ended arrives with a success reason', () => {
    const { svc, eventBus, dispose } = makeRuntimeService();
    try {
      svc.onDidChangeStatus(vi.fn());
      eventBus.eventService.publish(statusEvent({ type: 'turn.started', sessionId: 's' }));

      const listener = vi.fn();
      svc.onDidChangeStatus(listener);
      eventBus.eventService.publish(
        statusEvent({ type: 'turn.ended', sessionId: 's', reason: 'success' }),
      );

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's',
          status: 'idle' satisfies SessionStatus,
          previousStatus: 'running' satisfies SessionStatus,
        }),
      );
    } finally {
      dispose();
    }
  });

  it('does not fire when the incoming bus event leaves the status unchanged', () => {
    const { svc, eventBus, dispose } = makeRuntimeService();
    try {
      const listener = vi.fn();
      svc.onDidChangeStatus(listener);

      eventBus.eventService.publish(statusEvent({ type: 'prompt.completed', sessionId: 's' }));

      expect(listener).not.toHaveBeenCalled();
      const republished = eventBus.published.find(
        (e) => (e as { type?: string }).type === 'event.session.status_changed',
      );
      expect(republished).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
