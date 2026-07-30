/**
 * `workspaceToolPolicy` domain (L2) — `IWorkspaceToolPolicy` implementation.
 *
 * Computes the os-level disabled-tool set from the runtime capabilities the
 * handler binds (`IWorkspaceContext.osBackendId`). The local runtime carries
 * the full node os backend (fs / process / PTY / watch), so it vetoes
 * nothing; runtimes with a reduced os backend land their own capability
 * mapping (or seed their own `IWorkspaceToolPolicy`) when they arrive. A
 * workspace-level tools config does not exist yet — when one does, it joins
 * the capability set here and fires `onDidChange`. Bound at Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import {
  IWorkspaceContext,
  LOCAL_OS_BACKEND_ID,
} from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceToolPolicy } from './workspaceToolPolicy';

/**
 * The os-level veto set for one os backend. Pure so the capability mapping is
 * unit-testable without a scope. The local backend has every capability, so
 * it disables nothing.
 *
 * An UNKNOWN backend also disables nothing — that fail-open is a deliberate
 * choice: the veto is a safety override, and guessing restrictions for a
 * backend nobody has mapped would break tools on a runtime that may be fully
 * capable. The cost is the opposite silence: a NEW runtime that forgets to
 * extend this mapping ships with no os-level veto. When a new os backend
 * lands, extend this mapping (or seed its own `IWorkspaceToolPolicy`) as
 * part of the runtime bring-up.
 */
export function computeCapabilityDisabledTools(osBackendId: string): readonly string[] {
  if (osBackendId === LOCAL_OS_BACKEND_ID) return [];
  return [];
}

export class WorkspaceToolPolicyService extends Disposable implements IWorkspaceToolPolicy {
  declare readonly _serviceBrand: undefined;

  private readonly disabled: readonly string[];
  readonly onDidChange = Event.None as Event<void>;

  constructor(@IWorkspaceContext workspace: IWorkspaceContext) {
    super();
    this.disabled = computeCapabilityDisabledTools(workspace.osBackendId);
  }

  disabledTools(): readonly string[] {
    return this.disabled;
  }

  sessionGate(): ISessionToolPolicyGate {
    const current = (): readonly string[] => this.disabledTools();
    return {
      _serviceBrand: undefined,
      onDidChange: this.onDidChange,
      get disabledTools() {
        return current();
      },
    };
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceToolPolicy,
  WorkspaceToolPolicyService,
  ScopeActivation.OnScopeCreated,
  'workspaceToolPolicy',
);
