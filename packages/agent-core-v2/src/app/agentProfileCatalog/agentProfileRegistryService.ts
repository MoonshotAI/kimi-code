/**
 * `agentProfileCatalog` domain (L3) — `IAgentProfileRegistry` impl.
 *
 * App-scope singleton backed by the generic `ContributionRegistry`: storage
 * keys encode the (sourceId, workspaceKey) pair so a workspace-local source id
 * (`workspace`, `extra`, `explicit`) coexists across handlers, while global
 * sources (`builtin`, `plugin`, `user`) register once. The registry is pure
 * storage — merging, name dedup, and override rules live in the Session-scope
 * catalog projection.
 */

import { ContributionRegistry } from '#/_base/contribution/registry';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { AgentProfileContribution } from './agentProfileContribution';

import type {
  AgentProfileRegistration,
  AgentProfileRegistryChange,
  IAgentProfileRegistry,
  RegisterAgentProfileOptions,
} from './agentProfileRegistry';
import { IAgentProfileRegistry as IAgentProfileRegistryDecorator } from './agentProfileRegistry';

function encodeKey(sourceId: string, workspaceKey: string | undefined): string {
  return JSON.stringify([sourceId, workspaceKey ?? null]);
}

function decodeKey(key: string): AgentProfileRegistryChange {
  const [sourceId, workspaceKey] = JSON.parse(key) as [string, string | null];
  return { sourceId, workspaceKey: workspaceKey ?? undefined };
}

export class AgentProfileRegistryService
  extends Disposable
  implements IAgentProfileRegistry
{
  declare readonly _serviceBrand: undefined;

  private readonly registry = this._register(
    new ContributionRegistry<AgentProfileRegistration>(),
  );

  readonly onDidChange: Event<AgentProfileRegistryChange> = (listener, thisArg, disposables) =>
    this.registry.onDidChange(
      (key) => listener.call(thisArg, decodeKey(key)),
      undefined,
      disposables,
    );

  register(
    sourceId: string,
    contribution: AgentProfileContribution,
    options?: RegisterAgentProfileOptions,
  ): IDisposable {
    const registration: AgentProfileRegistration = {
      sourceId,
      priority: options?.priority ?? 0,
      workspaceKey: options?.workspaceKey,
      contribution,
    };
    return this.registry.register(encodeKey(sourceId, options?.workspaceKey), registration);
  }

  unregister(sourceId: string, workspaceKey?: string): void {
    this.registry.unregister(encodeKey(sourceId, workspaceKey));
  }

  entries(): readonly AgentProfileRegistration[] {
    return this.registry.entries().map((entry) => entry.contribution);
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentProfileRegistryDecorator,
  AgentProfileRegistryService,
  ScopeActivation.OnScopeCreated,
  'agentProfileCatalog',
);
