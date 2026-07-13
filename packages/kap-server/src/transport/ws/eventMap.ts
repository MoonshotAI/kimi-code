/**
 * `/api/v2` WS event map — binds a public event name to the scope's `Event`
 * source. Mirrors the `actionMap` (which binds `resource:action` → method); this
 * binds `event` → an `Event` subscription that yields an `IDisposable`.
 *
 * Only the high-value streams are exposed for now:
 *   Core    `events`                — process-wide `GlobalEvent` bus (`IEventService`)
 *   Session `interactions`          — pending human-in-the-loop requests (`ISessionInteractionService.onDidChangePending`)
 *   Session `interactions:resolved` — request resolutions (`ISessionInteractionService.onDidResolve`)
 *   Agent   `events`                — per-agent `AgentEvent` stream (live events via
 *                                     the per-agent `IEventBus`)
 */

import {
  IEventBus,
  IEventService,
  ISessionInteractionService,
  type GlobalEvent,
  type IDisposable,
  type IScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { ScopeKind } from '../channel';

type Accessor = Scope | IScopeHandle;

export interface EventSource {
  subscribe(scope: Accessor, listener: (data: unknown) => void): IDisposable;
}

export const eventMap: Record<ScopeKind, Record<string, EventSource>> = {
  core: {
    events: {
      subscribe: (scope, listener) =>
        scope.accessor.get(IEventService).subscribe(listener as (event: GlobalEvent) => void),
    },
  },
  session: {
    // Pushes the full pending interaction set whenever it changes. Payload is
    // the current `Interaction[]` (derived from `listPending`), so a client can
    // render a pending approval/question without a follow-up `call`. Resync is
    // out of band: `call interactions:listPending` before `listen`.
    interactions: {
      subscribe: (scope, listener) => {
        const interaction = scope.accessor.get(ISessionInteractionService);
        return interaction.onDidChangePending(() => listener(interaction.listPending()));
      },
    },
    // Pushes `{ id, response }` whenever a pending request is responded to.
    // Paired with `interactions:request` (the non-blocking enqueue): a headless
    // caller posts a request, then matches the resolution here by `id`.
    'interactions:resolved': {
      subscribe: (scope, listener) => {
        const interaction = scope.accessor.get(ISessionInteractionService);
        return interaction.onDidResolve((resolution) => listener(resolution));
      },
    },
  },
  agent: {
    events: {
      subscribe: (scope, listener) => {
        // Every domain emits live events via the per-agent `IEventBus`. The bus
        // is Agent-scoped, so this subscription sees only this agent's events.
        const busD = scope.accessor.get(IEventBus).subscribe((event) => listener(event));
        return { dispose: () => busD.dispose() };
      },
    },
  },
};

export function resolveEventSource(scopeKind: ScopeKind, event: string): EventSource | undefined {
  return eventMap[scopeKind][event];
}
