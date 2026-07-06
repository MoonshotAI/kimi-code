/**
 * `event` domain barrel — re-exports the canonical `IEventBus` contract and its
 * scoped service, plus the legacy `IEventService` binding (kept until Phase 3
 * cuts its consumers over and deletes it). Importing this barrel registers both
 * bindings into the scope registry.
 *
 * The legacy `DomainEvent` payload type (`./event`) is intentionally NOT
 * re-exported here: the barrel-level `DomainEvent` is the new discriminated
 * union (`./eventBus`). Consumers that still need the legacy payload type
 * import it directly from `#/app/event/event`.
 */

export * from './eventBus';
export * from './eventBusService';
export { IEventService, type DomainEvent as GlobalEvent } from './event';
export * from './eventService';
