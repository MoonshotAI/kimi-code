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
  const leases = new Set<ActivityLease>();
  return {
    _serviceBrand: undefined,
    lane: () => lane,
    markActive: () => undefined,
    canAccept: (_command: SessionCommand) => lane === 'active',
    admitTurn(_agentId: string, lease: ActivityLease): IDisposable {
      leases.add(lease);
      return { dispose: () => leases.delete(lease) };
    },
    quiesce: (reason: string): Promise<SessionQuiesceLease> =>
      Promise.resolve({ reason, dispose: () => undefined }),
    beginClosing: () => undefined,
    settled: () => Promise.resolve(),
  };
}
