/**
 * Live event bus — fans the three WS event streams (core `events`, session
 * `interactions`, agent `events`) out to every UI consumer through one React
 * context. Subscriptions are registered in `App`; panels and the chat view
 * subscribe here instead of opening their own sockets.
 */

import { createContext, useContext, useEffect, useRef } from 'react';

export interface LiveEvent {
  readonly source: 'core' | 'session' | 'agent';
  readonly data: unknown;
  readonly at: number;
}

type LiveHandler = (event: LiveEvent) => void;
export type Emit = (event: LiveEvent) => void;

interface LiveBus {
  readonly subscribe: (handler: LiveHandler) => () => void;
  /** Last N events recorded since connect (for the event log's initial view). */
  readonly getRecent: () => readonly LiveEvent[];
}

const LiveBusContext = createContext<LiveBus>({ subscribe: () => () => {}, getRecent: () => [] });

/** Extract the discriminant `type` of an agent/core event payload, if any. */
export function eventType(event: LiveEvent): string {
  const data = event.data as { type?: unknown } | null;
  return typeof data?.type === 'string' ? data.type : '';
}

/**
 * Render a wire payload field as display text: strings pass through,
 * numbers/booleans are stringified, anything else (or missing) falls back —
 * never "[object Object]".
 */
export function payloadField(
  payload: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * The provider assigns its `emit` to `busRef` so the WS subscription wiring in
 * `App` (which lives above the React tree's hooks it needs) can publish.
 */
const RECENT_LIMIT = 500;

export function LiveBusProvider({
  busRef,
  children,
}: {
  busRef: React.MutableRefObject<Emit | null>;
  children: React.ReactNode;
}) {
  const handlers = useRef(new Set<LiveHandler>());
  const recent = useRef<LiveEvent[]>([]);
  const bus = useRef<LiveBus>({
    subscribe: (handler) => {
      handlers.current.add(handler);
      return () => handlers.current.delete(handler);
    },
    getRecent: () => recent.current,
  });
  busRef.current = (event) => {
    const buf = recent.current;
    if (buf.length >= RECENT_LIMIT) buf.splice(0, buf.length - RECENT_LIMIT + 1);
    buf.push(event);
    for (const handler of handlers.current) handler(event);
  };
  return <LiveBusContext.Provider value={bus.current}>{children}</LiveBusContext.Provider>;
}

/** Subscribe to the merged live stream. */
export function useLiveEvent(handler: LiveHandler): void {
  const { subscribe } = useContext(LiveBusContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}

/** Read the buffered recent events (for initial log rendering). */
export function useRecentEvents(): readonly LiveEvent[] {
  const { getRecent } = useContext(LiveBusContext);
  return getRecent();
}
