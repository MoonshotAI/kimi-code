/**
 * `event` domain barrel (di-v3).
 *
 * Two buses live here:
 *
 * - {@link IEventService} / {@link EventService} (`./event.ts` / `./eventService.ts`)
 *   — the daemon's in-process pub-sub bus for the protocol `Event` union
 *   (`AgentEvent & { agentId, sessionId }`). `WSBroadcastService`
 *   (`@moonshot-ai/server`) subscribes via `onDidPublish` to do WS fan-out.
 *
 * - {@link IDomainEventBus} / {@link DomainEventBus} (`./event-bus.ts`) — the
 *   agent's in-process pub-sub for bare `AgentEvent`s (no transport stamps).
 *
 * {@link shouldProjectToProtocol} (`./projection.ts`) is the documented,
 * tested policy pinning the projection between the two.
 *
 * Internal support files are not re-exported. The contract + impl are named
 * exports (not `export *`) so the barrel surface stays explicit and mirrors
 * the symbols `services/index.ts` used to re-export for this domain.
 */

export { IEventService } from './event';
export { EventService } from './eventService';
export { DomainEventBus, IDomainEventBus } from './event-bus';
export { shouldProjectToProtocol } from './projection';
