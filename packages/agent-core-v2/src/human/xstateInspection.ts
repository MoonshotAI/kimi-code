import type { InspectionEvent } from 'xstate';

export type XstateInspectionEventType = InspectionEvent['type'];

export interface XstateInspectionEnvelope {
  readonly type: XstateInspectionEventType;
  readonly timestamp: number;
  readonly actorSessionId: string;
  readonly actorId?: string;
  readonly logicId?: string;
  readonly eventType?: string;
  readonly stateValue?: unknown;
}

export type XstateInspectionListener = (envelope: XstateInspectionEnvelope) => void;

export interface XstateInspectionCollector {
  subscribe(listener: XstateInspectionListener): () => void;
  publish(event: InspectionEvent): void;
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toEnvelope(event: InspectionEvent, now: () => number): XstateInspectionEnvelope {
  const actorRef = event.actorRef as { id?: unknown; logic?: unknown };
  const logic = actorRef.logic as { id?: unknown } | undefined;
  const snapshot = 'snapshot' in event ? (event.snapshot as { value?: unknown }) : undefined;
  return {
    type: event.type,
    timestamp: now(),
    actorSessionId: event.actorRef.sessionId,
    actorId: scalar(actorRef.id),
    logicId: scalar(logic?.id),
    eventType:
      'event' in event
        ? event.event.type
        : event.type === '@xstate.action'
          ? event.action.type
          : undefined,
    stateValue: snapshot?.value,
  };
}

export function createXstateInspectionCollector(input?: {
  now?: () => number;
}): XstateInspectionCollector {
  const now = input?.now ?? Date.now;
  const listeners = new Set<XstateInspectionListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      if (listeners.size === 0) return;
      const envelope = toEnvelope(event, now);
      for (const listener of listeners) listener(envelope);
    },
  };
}

export const xstateInspectionCollector = createXstateInspectionCollector();
