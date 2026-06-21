import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';
import { describe, expect, it, vi } from 'vitest';

import { DomainEventBus } from '#/event/event-bus';
import { shouldProjectToProtocol } from '#/event/projection';
import type { AgentEvent } from '#/rpc';
import type { IEventService } from '#/services/event/event';

// ─── projection boundary model ──────────────────────────────────────────────
//
// `IDomainEventBus` carries bare `AgentEvent`s (no agentId/sessionId). The
// `forward` callback it is constructed with is the projection onto the
// protocol transport bus (`IEventService`): in production it calls
// `agent.rpc.emitEvent`, which the daemon's `BridgeClientAPI.emitEvent`
// re-publishes to `IEventService.publish`. `WSBroadcastService` subscribes to
// `IEventService.onDidPublish`.
//
// These tests pin the boundary encoded by `shouldProjectToProtocol`:
//   - which representative domain events project (current policy: all), and
//   - that the projection still feeds `IEventService.onDidPublish` so
//     `WSBroadcastService`'s input stream is unchanged.

const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';

const statusEvent = (): AgentEvent =>
  ({ type: 'agent.status.updated', planMode: false }) satisfies AgentEvent;

const turnStartedEvent = (): AgentEvent =>
  ({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }) satisfies AgentEvent;

const warningEvent = (message: string): AgentEvent =>
  ({ type: 'warning', message }) satisfies AgentEvent;

/** Stamp a bare domain event with the agent/session ids the protocol bus requires. */
function toProtocol(event: AgentEvent): ProtocolEvent {
  return { ...event, agentId: AGENT_ID, sessionId: SESSION_ID } as ProtocolEvent;
}

interface EventServiceStub extends IEventService {
  readonly published: ProtocolEvent[];
}

function makeEventService(): EventServiceStub {
  const listeners = new Set<(event: ProtocolEvent) => void>();
  const published: ProtocolEvent[] = [];
  return {
    _serviceBrand: undefined,
    published,
    publish(event: ProtocolEvent): void {
      published.push(event);
      for (const listener of listeners) listener(event);
    },
    onDidPublish(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

/**
 * Wire a `DomainEventBus` the way `agent/factory.ts` does, but route the
 * projection through `shouldProjectToProtocol` so the helper is the single
 * source of truth for what reaches `IEventService`.
 */
function makeProjectingBus(eventService: IEventService): DomainEventBus {
  return new DomainEventBus((event: AgentEvent) => {
    if (shouldProjectToProtocol(event)) {
      eventService.publish(toProtocol(event));
    }
  });
}

describe('shouldProjectToProtocol (domain → protocol projection boundary)', () => {
  it('projects an agent status event', () => {
    expect(shouldProjectToProtocol(statusEvent())).toBe(true);
  });

  it('projects a turn lifecycle event', () => {
    expect(shouldProjectToProtocol(turnStartedEvent())).toBe(true);
  });

  it('projects a diagnostic warning event', () => {
    expect(shouldProjectToProtocol(warningEvent('boom'))).toBe(true);
  });

  it('keeps WSBroadcastService input unchanged: the projection still feeds IEventService.onDidPublish', () => {
    const eventService = makeEventService();
    const bus = makeProjectingBus(eventService);
    const received = vi.fn();
    const subscription = eventService.onDidPublish(received);

    const status = statusEvent();
    const turn = turnStartedEvent();
    const warning = warningEvent('fwd');
    bus.publish(status);
    bus.publish(turn);
    bus.publish(warning);

    // Every published domain event reaches the protocol bus exactly once,
    // stamped with agentId/sessionId — i.e. the stream WSBroadcastService
    // subscribes to is unchanged.
    expect(received).toHaveBeenCalledTimes(3);
    expect(eventService.published).toEqual([
      toProtocol(status),
      toProtocol(turn),
      toProtocol(warning),
    ]);
    for (const event of eventService.published) {
      expect(event.agentId).toBe(AGENT_ID);
      expect(event.sessionId).toBe(SESSION_ID);
    }

    subscription.dispose();
  });

  it('keeps in-process subscribers unaffected by the projection gate', () => {
    // Projection is orthogonal to in-process delivery: gating the `forward`
    // callback must not swallow events from `IDomainEventBus` subscribers.
    const eventService = makeEventService();
    const bus = makeProjectingBus(eventService);
    const inProcess = vi.fn();
    const subscription = bus.subscribe('warning', inProcess);

    const warning = warningEvent('local');
    bus.publish(warning);

    expect(inProcess).toHaveBeenCalledOnce();
    expect(inProcess).toHaveBeenCalledWith(warning);
    expect(eventService.published).toEqual([toProtocol(warning)]);

    subscription.dispose();
  });
});
