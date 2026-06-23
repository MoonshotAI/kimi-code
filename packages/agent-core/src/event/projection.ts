/**
 * Domain → protocol event projection boundary.
 *
 * Two buses sit on either side of the agent/daemon split:
 *
 * - {@link IDomainEventBus} (`./event-bus.ts`) — the agent's in-process
 *   pub-sub for `AgentEvent` (domain events produced by the `Agent` / turn
 *   loop and the per-domain services). It carries bare domain events with no
 *   `agentId` / `sessionId` stamped on them.
 *
 * - `IEventService` (`./event.ts`) — the daemon's transport
 *   bus. A pub-sub for the protocol `Event`
 *   (= `AgentEvent & { agentId, sessionId }`). `WSBroadcastService`
 *   (`@moonshot-ai/server/services/WSBroadcastService`) subscribes to it via
 *   `onDidPublish` to do WS fan-out, journaling, and replay.
 *
 * The projection between the two is the `forward` callback `DomainEventBus`
 * is constructed with. In production it is wired in
 * `agent/factory.ts` as:
 *
 * ```ts
 * new DomainEventBus((event) => {
 *   if (!agent.records.restoring) void agent.rpc?.emitEvent?.(event);
 * });
 * ```
 *
 * `agent.rpc.emitEvent` crosses the in-process RPC to the daemon, where
 * `BridgeClientAPI.emitEvent`
 * (`services/coreProcess/coreProcessClient.ts`) calls
 * `IEventService.publish(event)`. So every domain event that flows through
 * `IDomainEventBus` lands on `IEventService` and therefore reaches
 * `WSBroadcastService`.
 *
 * **Current policy: every `AgentEvent` published on `IDomainEventBus` is
 * projected to the protocol bus.** There is no per-event-type filter — the
 * only gate is the `agent.records.restoring` lifecycle flag inside the
 * `forward` callback, which is a runtime replay/restore state, not a
 * per-type rule. {@link shouldProjectToProtocol} encodes this policy so the
 * boundary has a single, testable source of truth.
 *
 * This module is documentation + a pure helper. It intentionally does NOT
 * change which events are projected, and it leaves `IEventService` and
 * `WSBroadcastService` untouched.
 */

import type { AgentEvent } from '#/rpc';

/**
 * Returns whether a domain `AgentEvent` published on {@link IDomainEventBus}
 * is projected onto the protocol transport bus (`IEventService`), and
 * therefore forwarded to `WSBroadcastService`.
 *
 * Today the projection is total: every domain event projects. The helper
 * exists so the boundary is named and pinned by tests; when a future policy
 * starts dropping events (e.g. in-process-only diagnostics) this is the
 * single place the rule changes.
 */
export function shouldProjectToProtocol(event: AgentEvent): boolean {
  // Reference the parameter so the signature stays meaningful even though the
  // current policy is unconditional — every domain event projects.
  void event;
  return true;
}
