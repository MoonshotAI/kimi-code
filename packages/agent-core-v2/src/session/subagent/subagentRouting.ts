/**
 * `subagent` domain (L6) — dual-model routing contract.
 *
 * Defines the `ISubagentRoutingService` used by the `Agent` tool and the
 * `swarm` domain to resolve the model alias and thinking effort for child
 * agents. Resolution chain (highest wins): session metadata override →
 * `[subagent]` config default → caller inheritance. Inert when the
 * `dual-model-routing` flag is off. Session-scoped — one instance per session,
 * holding the cached session-level overrides.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISubagentRoutingService {
  readonly _serviceBrand: undefined;
  /** Resolves when session metadata overrides are loaded. */
  readonly ready: Promise<void>;
  /** Effective subagent model alias, or undefined when flag off / no override / no config default. */
  getSubagentModel(): string | undefined;
  /** Effective subagent thinking effort, or undefined when flag off / no override / no config default. */
  getSubagentThinkingEffort(): string | undefined;
  /** Resolve model for a new child agent. Falls back to parentModelAlias when routing yields nothing. */
  resolveChildModel(parentModelAlias: string): string;
  /** Resolve thinking effort for a new child. Falls back to parentThinkingEffort when routing yields nothing. */
  resolveChildThinkingEffort(parentThinkingEffort: string): string;
  /** Set or clear (undefined/empty string) the session-level subagent model override. Persists to session metadata. */
  setSubagentModel(alias: string | undefined): Promise<void>;
  /** Set or clear (undefined/empty string) the session-level subagent thinking effort override. Persists to session metadata. */
  setSubagentThinkingEffort(effort: string | undefined): Promise<void>;
}

export const ISubagentRoutingService: ServiceIdentifier<ISubagentRoutingService> =
  createDecorator<ISubagentRoutingService>('subagentRoutingService');
