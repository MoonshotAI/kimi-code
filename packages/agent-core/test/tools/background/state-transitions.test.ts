/**
 * `awaiting_approval` state transitions.
 *
 * BPM has 6 states:
 *   running ↔ awaiting_approval → {completed, failed, killed, lost}
 *
 * Semantics:
 *   - mark / clear are no-ops unless the target task exists and is not
 *     terminal
 *   - UI reads the BPM state directly (ApprovalRuntime remains the
 *     policy layer); BPM is the single source of truth for "is this
 *     task actively running or gated"
 *   - `stop()` applied to an awaiting_approval task transitions
 *     straight to `killed` with the approvalReason cleared
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentBackgroundTask, BackgroundManager } from '../../../src/agent/background';

function pendingProcess(): { proc: KaosProcess; resolve: (code: number) => void } {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 42_042,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      if (currentExitCode === null) {
        currentExitCode = 143;
        resolveWait(143);
      }
    }) as unknown as KaosProcess['kill'],
  };
  return {
    proc,
    resolve: (code) => {
      if (currentExitCode === null) {
        currentExitCode = code;
        resolveWait(code);
      }
    },
  };
}

describe('BackgroundManager — awaiting_approval state', () => {
  const manager = new BackgroundManager();

  afterEach(() => {
    manager._reset();
  });

  it('markAwaitingApproval flips running → awaiting_approval and stores reason', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'sleep 999', 'approval test');

    manager.markAwaitingApproval(taskId, 'Write to /etc/hosts');
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('awaiting_approval');
    expect(info?.approvalReason).toBe('Write to /etc/hosts');
  });

  it('clearAwaitingApproval flips awaiting_approval → running and drops reason', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'do thing');

    manager.clearAwaitingApproval(taskId);
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('running');
    expect(info?.approvalReason).toBeUndefined();
  });

  it('markAwaitingApproval is a no-op on terminal tasks', async () => {
    const { proc, resolve } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    resolve(0);
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');

    manager.markAwaitingApproval(taskId, 'too late');
    // Status and approvalReason unchanged.
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.approvalReason).toBeUndefined();
  });

  it('stop on an awaiting_approval task flips to killed and clears reason', async () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'waiting…');

    const stopped = await manager.stop(taskId);
    expect(stopped?.status).toBe('killed');
    expect(stopped?.approvalReason).toBeUndefined();
  });

  it('list(true) includes awaiting_approval (non-terminal is active)', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'waiting…');

    const active = manager.list(true);
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe('awaiting_approval');
  });

  it('clearAwaitingApproval on a non-awaiting task is a no-op', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    // Task is still `running` — nothing to clear.
    manager.clearAwaitingApproval(taskId);
    expect(manager.getTask(taskId)?.status).toBe('running');
  });

  // _mark_task_running is a no-op if the task is already in a terminal
  // state. Prevents a late approval-resolve from clobbering `killed`
  // or `completed`.
  it('a state transition does not overwrite a terminal status', async () => {
    const { proc, resolve } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    resolve(0);
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');

    // Try to flip to awaiting_approval and back — both must be no-ops.
    manager.markAwaitingApproval(taskId, 'too late');
    manager.clearAwaitingApproval(taskId);
    expect(manager.getTask(taskId)?.status).toBe('completed');
  });

  // State transitions out of awaiting_approval must clear failure_reason
  // (which carried the approval prompt). Both transitions back to
  // running AND straight to completed must clear it.
  it('leaving awaiting_approval clears the carried approval reason', async () => {
    const { proc, resolve } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'pending approval prompt');
    expect(manager.getTask(taskId)?.approvalReason).toBe('pending approval prompt');

    // Path 1: awaiting → running clears reason.
    manager.clearAwaitingApproval(taskId);
    expect(manager.getTask(taskId)?.approvalReason).toBeUndefined();

    // Path 2: awaiting → completed must ALSO clear approval reason.
    manager.markAwaitingApproval(taskId, 'second prompt');
    resolve(0);
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    const finalInfo = manager.getTask(taskId);
    expect(finalInfo?.status).toBe('completed');
    expect(finalInfo?.approvalReason).toBeUndefined();
  });

  // RunCancelled propagating from the background runner marks the task
  // as `killed` (not `failed`) — Ctrl+C is cancel, not failure. The TS
  // agent code today maps internal rejections to `failed`; this is the
  // py contract that diverges at the agent-runner layer.
  it('RunCancelled in an agent run marks the task as killed (not failed)', async () => {
    class RunCancelled extends Error {
      constructor() {
        super('run cancelled');
        this.name = 'RunCancelled';
      }
    }
    const taskId = manager.registerTask(new AgentBackgroundTask(
      Promise.reject(new RunCancelled()),
      'run cancelled bg',
    ));
    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('killed');
  });
});
