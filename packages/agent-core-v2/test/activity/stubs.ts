/**
 * `activity` test stubs — shared `ISessionActivityKernel` stubs for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path. The default stub admits every
 * turn (`active` lane), mirroring the PR1 placeholder Session kernel so
 * Agent-scope unit tests can construct the real `AgentActivityService` without
 * a Session scope tree.
 */

import type { IDisposable } from '#/_base/di/lifecycle';
import type {
  ActivityLease,
  ISessionActivityKernel,
  SessionCommand,
  SessionLane,
  SessionQuiesceLease,
} from '#/activity/activity';

export function stubSessionActivityKernel(
  lane: SessionLane = 'active',
): ISessionActivityKernel {
  let currentLane: SessionLane = lane;
  const leases = new Set<ActivityLease>();
  return {
    _serviceBrand: undefined,
    lane: () => currentLane,
    canAccept: (_command: SessionCommand) => currentLane === 'active',
    admitTurn(_agentId: string, lease: ActivityLease): IDisposable {
      leases.add(lease);
      return { dispose: () => leases.delete(lease) };
    },
    quiesce: (reason: string): Promise<SessionQuiesceLease> =>
      Promise.resolve({ reason, dispose: () => undefined }),
    beginClosing: () => {
      currentLane = 'closing';
    },
    settled: () => Promise.resolve(),
    markActive: () => {
      if (currentLane === 'restoring') currentLane = 'active';
    },
  };
}
