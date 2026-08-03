/**
 * `media` domain (L4) — media-tools registrar contract.
 *
 * Identifier-only module (implementation in `mediaToolsRegistrar.ts`), so
 * consumers that need the service identifier — e.g. `agentLifecycle`'s
 * force-instantiation — do not pull the implementation's scoped registration
 * into their module graph. Mirrors the `mcp.ts` / `mcpService.ts` split.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentMediaToolsRegistrar {
  readonly _serviceBrand: undefined;
}

export const IAgentMediaToolsRegistrar: ServiceIdentifier<IAgentMediaToolsRegistrar> =
  createDecorator<IAgentMediaToolsRegistrar>('agentMediaToolsRegistrar');
