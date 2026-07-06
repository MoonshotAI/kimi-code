/**
 * `wire` domain (L2) — scope-specific DI tokens (`IAgentWireService`,
 * `ISessionWireService`) over the single `IWireService` contract.
 *
 * One `WireService` implementation serves every scope; per-scope isolation
 * comes from distinct tokens, each seeded with its own persistence key at scope
 * creation. Domain services inject the token for their scope
 * (`@IAgentWireService`, `@ISessionWireService`). No App-scope token yet — add
 * one when a use case appears.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { IWireService } from './wireService';

export const IAgentWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('agentWireService');

export const ISessionWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('sessionWireService');
