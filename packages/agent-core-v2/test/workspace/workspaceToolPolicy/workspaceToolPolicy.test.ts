/**
 * `workspaceToolPolicy` domain (L2) — verifies the capability-derived veto
 * set and the `ISessionToolPolicyGate` live read view the handler seeds into
 * every session.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceToolPolicy } from '#/workspace/workspaceToolPolicy/workspaceToolPolicy';
import {
  WorkspaceToolPolicyService,
  computeCapabilityDisabledTools,
} from '#/workspace/workspaceToolPolicy/workspaceToolPolicyService';

void WorkspaceToolPolicyService;

const WORK_DIR = '/repo';

function stubWorkspaceContext(osBackendId = 'local'): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'w',
    cwd: WORK_DIR,
    source: 'local',
    meta: { id: 'w', root: WORK_DIR, name: 'proj', createdAt: 1, lastOpenedAt: 1 },
    persistenceScope: 'sessions/w',
    osBackendId,
    persistenceBackendId: 'local',
  };
}

let host: ScopedTestHost | undefined;

afterEach(() => {
  host?.dispose();
  host = undefined;
});

function makePolicy(osBackendId = 'local'): IWorkspaceToolPolicy {
  host = createScopedTestHost();
  const workspace = host.child(LifecycleScope.Workspace, 'w1', [
    stubPair(IWorkspaceContext, stubWorkspaceContext(osBackendId)),
  ]);
  return workspace.accessor.get(IWorkspaceToolPolicy);
}

describe('computeCapabilityDisabledTools', () => {
  it('disables nothing for the local os backend', () => {
    expect(computeCapabilityDisabledTools('local')).toEqual([]);
  });
});

describe('WorkspaceToolPolicyService', () => {
  it('exposes an empty veto set on the local runtime', () => {
    expect(makePolicy().disabledTools()).toEqual([]);
  });

  it('hands sessions a live gate view over the same veto set', () => {
    const gate = makePolicy().sessionGate();
    expect(gate.disabledTools).toEqual([]);
    expect(gate.onDidChange).toBeDefined();
  });
});
