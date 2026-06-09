/**
 * `defaultServicesModule()` — DI entries shipped by `@moonshot-ai/services`.
 *
 * Thin projection of the global singleton registry maintained by
 * `@moonshot-ai/agent-core`. Each service impl file self-registers at
 * module-load time via `registerSingleton` (ctor overload for pure `@I…`
 * injection, descriptor overload when a leading options bag is required).
 * Importing this `module.ts` triggers the side-effect imports below, which
 * populate the registry; `defaultServicesModule()` snapshots the registry
 * via `getSingletonServiceDescriptors()`.
 *
 * Usage:
 *
 *   const services = new ServiceCollection(...defaultServicesModule());
 *
 * Each entry is `[ServiceIdentifier, SyncDescriptor]`. The descriptor carries
 * the `supportsDelayedInstantiation` flag; no extra projection is needed.
 *
 * Consumers (e.g. the daemon) override entries with `services.set(...)` for
 * runtime static args (`CoreProcessService` with real `coreProcessOptions`)
 * or prebuilt instances (`PinoLogger`). Later registrations win.
 *
 * Per-domain layout: see `packages/services/AGENTS.md`. Classes live in
 * per-domain folders (`session/`, `message/`, …) with one `<domain>.ts`
 * contracts file and one `<domain>Service.ts` impl file each.
 */

import {
  getSingletonServiceDescriptors,
  SyncDescriptor,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core';

// Side-effect imports — each impl file calls `registerSingleton(...)` at
// file bottom. Ordering matters: it determines the order entries surface from
// `getSingletonServiceDescriptors()`, which the daemon's reverse-dispose
// semantics piggy-back on. CoreProcessService MUST register first — the
// existing `defaultServicesModule()` test
// (`packages/services/test/coreProcessService.test.ts:315`) asserts it
// sits at index 0, and downstream `a.get(...)` "touch" ordering in
// `packages/daemon/src/start.ts` assumes the bridge is the first
// service-package entry into the construction-order list.
import './coreProcess/coreProcessService';
import './event/eventService';
import './session/sessionService';
import './message/messageService';
import './prompt/promptService';
import './tool/toolService';
import './mcp/mcpService';
import './task/taskService';
import './authSummary/authSummaryService';
import './oauth/oauthService';
import './modelCatalog/modelCatalogService';

export type ServiceModuleEntry = readonly [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServiceIdentifier<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SyncDescriptor<any>,
];

export function defaultServicesModule(): ReadonlyArray<ServiceModuleEntry> {
  return getSingletonServiceDescriptors().map(
    ([id, descriptor]) => [id, descriptor] as const,
  );
}
