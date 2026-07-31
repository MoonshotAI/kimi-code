/**
 * `workspaceToolPolicy` domain (L2) — os-level tool enable/disable contract.
 *
 * Defines the `IWorkspaceToolPolicy`, the Workspace-scope owner of the
 * tool-veto set that outranks every Agent-side policy layer (profile ×
 * `[tools]` config × session denylist): a tool the workspace disables never
 * activates and can never execute, no matter what the upper layers allow.
 * The set derives from the handler's runtime capabilities — the
 * `IWorkspaceContext.osBackendId` keying pair records which os backend the
 * handler binds; a runtime whose backend lacks a capability (e.g. no PTY)
 * contributes the dependent tool names here. The set reaches every session
 * of the handler through the `ISessionToolPolicyGate` seed
 * (`sessionGate()`), a live read view over this service. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';

export interface IWorkspaceToolPolicy {
  readonly _serviceBrand: undefined;

  disabledTools(): readonly string[];
  readonly onDidChange: Event<void>;

  sessionGate(): ISessionToolPolicyGate;
}

export const IWorkspaceToolPolicy: ServiceIdentifier<IWorkspaceToolPolicy> =
  createDecorator<IWorkspaceToolPolicy>('workspaceToolPolicy');
