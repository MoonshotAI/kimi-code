import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { AgentProfileContribution } from './agentProfileContribution';

export interface AgentProfileRegistration {
  readonly sourceId: string;
  readonly priority: number;
  readonly workspaceKey?: string;
  readonly contextKey?: string;
  readonly contribution: AgentProfileContribution;
}

export interface AgentProfileRegistryChange {
  readonly sourceId: string;
  readonly workspaceKey?: string;
  readonly contextKey?: string;
}

export interface AgentProfileViewer {
  readonly workspaceKey: string;
  readonly contextKeys?: readonly string[];
}

export function isVisibleAgentProfileSource(source: AgentProfileRegistryChange, viewer: AgentProfileViewer): boolean {
  return (
    (source.workspaceKey === undefined || source.workspaceKey === viewer.workspaceKey) &&
    (source.contextKey === undefined || viewer.contextKeys?.includes(source.contextKey) === true)
  );
}

export interface IAgentProfileRegistry {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<AgentProfileRegistryChange>;

  entries(): readonly AgentProfileRegistration[];
  register(registration: AgentProfileRegistration): IDisposable;
}

export const IAgentProfileRegistry: ServiceIdentifier<IAgentProfileRegistry> =
  createDecorator<IAgentProfileRegistry>('agentProfileRegistry');

export function agentProfileRegistryInContext(registry: IAgentProfileRegistry, contextKey: string): IAgentProfileRegistry {
  return {
    _serviceBrand: undefined,
    onDidChange: registry.onDidChange,
    entries: () => registry.entries(),
    register: (registration) => registry.register({ ...registration, contextKey }),
  };
}
