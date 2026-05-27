/**
 * BackgroundProcessManager — onLifecycle hook.
 *
 * Covers the three lifecycle events emitted to subscribers:
 *   - 'started' on register / registerAgentTask
 *   - 'updated' on awaiting_approval enter / leave
 *   - 'terminated' on natural exit / failure / stop / reconcile-as-lost
 *
 * Subscribers must receive each phase exactly once per task, in order,
 * with the current `BackgroundTaskInfo` snapshot.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundProcessManager,
  type BackgroundTaskInfo,
} from '../../../src/tools/background/manager';

type LifecycleEvent = 'started' | 'updated' | 'terminated';

interface CallRecord {
  event: LifecycleEvent;
  info: BackgroundTaskInfo;
}

function makeRecorder(): {
  records: CallRecord[];
  callback: (event: LifecycleEvent, info: BackgroundTaskInfo) => void;
} {
  const records: CallRecord[] = [];
  return {
    records,
    callback: (event, info) => {
      records.push({ event, info });
    },
  };
}

function immediateProcess(exitCode: number): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 20000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

function pendingProcess(): KaosProcess {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 88888,
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
}

describe('BackgroundProcessManager — onLifecycle', () => {
  let manager: BackgroundProcessManager;

  beforeEach(() => {
    manager = new BackgroundProcessManager();
  });

  afterEach(() => {
    manager._reset();
  });

  it("fires 'started' immediately on register()", () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    const taskId = manager.register(pendingProcess(), 'sleep 60', 'long task');

    expect(records.length).toBe(1);
    expect(records[0]!.event).toBe('started');
    expect(records[0]!.info.taskId).toBe(taskId);
    expect(records[0]!.info.status).toBe('running');
  });

  it("fires 'started' on registerAgentTask()", () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    const taskId = manager.registerAgentTask(new Promise(() => {}), 'an agent');

    expect(records.length).toBe(1);
    expect(records[0]!.event).toBe('started');
    expect(records[0]!.info.taskId).toBe(taskId);
    expect(records[0]!.info.taskId).toMatch(/^agent-/);
  });

  it("fires 'updated' on markAwaitingApproval / clearAwaitingApproval", () => {
    const { records, callback } = makeRecorder();
    const taskId = manager.register(pendingProcess(), 'sleep', 'demo');
    manager.onLifecycle(callback);

    manager.markAwaitingApproval(taskId, 'needs permission');
    manager.clearAwaitingApproval(taskId);

    const events = records.map((r) => r.event);
    expect(events).toEqual(['updated', 'updated']);
    expect(records[0]!.info.status).toBe('awaiting_approval');
    expect(records[0]!.info.approvalReason).toBe('needs permission');
    expect(records[1]!.info.status).toBe('running');
    expect(records[1]!.info.approvalReason).toBeUndefined();
  });

  it("does not fire 'updated' for no-op markAwaitingApproval / clearAwaitingApproval", () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    // unknown task
    manager.markAwaitingApproval('bash-deadbeef', 'nope');
    manager.clearAwaitingApproval('bash-deadbeef');

    // clear when not in awaiting_approval state is a no-op
    const taskId = manager.register(pendingProcess(), 'sleep', 'demo');
    records.length = 0;
    manager.clearAwaitingApproval(taskId);

    expect(records.length).toBe(0);
  });

  it("fires 'terminated' on natural process exit (completed)", async () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    manager.register(immediateProcess(0), 'echo', 'done');
    await new Promise((r) => setTimeout(r, 20));

    const terminated = records.filter((r) => r.event === 'terminated');
    expect(terminated.length).toBe(1);
    expect(terminated[0]!.info.status).toBe('completed');
    expect(terminated[0]!.info.exitCode).toBe(0);
  });

  it("fires 'terminated' on non-zero exit (failed)", async () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    manager.register(immediateProcess(2), 'false', 'fail');
    await new Promise((r) => setTimeout(r, 20));

    const terminated = records.filter((r) => r.event === 'terminated');
    expect(terminated.length).toBe(1);
    expect(terminated[0]!.info.status).toBe('failed');
    expect(terminated[0]!.info.exitCode).toBe(2);
  });

  it("fires 'terminated' exactly once for the same task (idempotent)", async () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    manager.register(immediateProcess(0), 'echo', 'done');
    await new Promise((r) => setTimeout(r, 20));
    // Manual settle attempt — should not produce a second terminated event.
    await manager.settlePendingExits();

    const terminated = records.filter((r) => r.event === 'terminated');
    expect(terminated.length).toBe(1);
  });

  it("fires 'started' -> 'terminated' in order on full lifecycle", async () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    manager.register(immediateProcess(0), 'echo', 'done');
    await new Promise((r) => setTimeout(r, 20));

    const events = records.map((r) => r.event);
    expect(events).toEqual(['started', 'terminated']);
  });

  it("fires 'terminated' with status='killed' on stop()", async () => {
    const { records, callback } = makeRecorder();
    manager.onLifecycle(callback);

    const taskId = manager.register(pendingProcess(), 'sleep 60', 'long');
    await manager.stop(taskId, 'user requested');

    const terminated = records.filter((r) => r.event === 'terminated');
    expect(terminated.length).toBe(1);
    expect(terminated[0]!.info.status).toBe('killed');
    expect(terminated[0]!.info.stopReason).toBe('user requested');
  });

  it("fires 'terminated' for ghost reconcile (lost)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpm-lifecycle-'));
    try {
      // Seed disk with a running ghost the way persist would.
      const tasksDir = join(dir, 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      const ghost = {
        task_id: 'bash-deadbeef',
        command: 'sleep 9999',
        description: 'ghost task',
        pid: 99999,
        started_at: Date.now() - 60_000,
        ended_at: null,
        exit_code: null,
        status: 'running',
        approval_reason: undefined,
        timed_out: undefined,
        stop_reason: undefined,
      };
      writeFileSync(join(tasksDir, 'bash-deadbeef.json'), JSON.stringify(ghost));

      const { records, callback } = makeRecorder();
      manager.attachSessionDir(dir);
      await manager.loadFromDisk();
      manager.onLifecycle(callback);

      const result = await manager.reconcile();

      expect(result.lost).toEqual(['bash-deadbeef']);
      const terminated = records.filter((r) => r.event === 'terminated');
      expect(terminated.length).toBe(1);
      expect(terminated[0]!.info.status).toBe('lost');
      expect(terminated[0]!.info.taskId).toBe('bash-deadbeef');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swallows subscriber errors so main flow is unaffected', () => {
    manager.onLifecycle(() => {
      throw new Error('boom');
    });
    expect(() => manager.register(pendingProcess(), 'sleep', 'x')).not.toThrow();
  });
});
