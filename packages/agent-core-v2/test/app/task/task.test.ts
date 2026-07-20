import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  type ITaskHandle,
  type IDeferredHandle,
  type TaskState,
  TaskCancelledError,
} from '#/app/task/task';
import { TaskService } from '#/app/task/taskService';

describe('TaskService', () => {
  let disposables: DisposableStore;
  let svc: TaskService;

  beforeEach(() => {
    disposables = new DisposableStore();
    svc = disposables.add(new TaskService());
  });
  afterEach(() => disposables.dispose());


  describe('run()', () => {
    it('transitions running → completed on success', async () => {
      const handle = svc.run(async () => 42);
      expect(handle.state).toBe('running');
      const result = await handle.result;
      expect(result).toBe(42);
      expect(handle.state).toBe('completed');
    });

    it('transitions running → failed when fn rejects', async () => {
      const handle = svc.run(async () => {
        throw new Error('boom');
      });
      expect(handle.state).toBe('running');
      await expect(handle.result).rejects.toThrow('boom');
      expect(handle.state).toBe('failed');
    });

    it('delivers output to pre-registered listeners', async () => {
      const chunks: string[] = [];
      const handle = svc.run(async (_signal, output) => {
        await Promise.resolve();
        output('line1');
        output('line2');
        return 'done';
      });
      handle.onDidOutput((data) => chunks.push(data));
      await handle.result;
      expect(chunks).toEqual(['line1', 'line2']);
    });

    it('state is running immediately after run()', () => {
      const handle = svc.run(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(handle.state).toBe('running');
      handle.cancel();
    });
  });


  describe('defer()', () => {
    it('starts in pending state', () => {
      const handle = svc.defer<number>();
      expect(handle.state).toBe('pending');
    });

    it('resolve settles to completed', async () => {
      const handle = svc.defer<string>();
      handle.resolve('ok');
      expect(handle.state).toBe('completed');
      await expect(handle.result).resolves.toBe('ok');
    });

    it('reject settles to failed', async () => {
      const handle = svc.defer<string>();
      handle.reject(new Error('fail'));
      expect(handle.state).toBe('failed');
      await expect(handle.result).rejects.toThrow('fail');
    });
  });


  describe('cancellation', () => {
    it('run() cancel aborts the signal and settles as cancelled', async () => {
      let signalAborted = false;
      const handle = svc.run(async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            signalAborted = true;
            resolve();
          });
        });
      });
      handle.cancel();
      await expect(handle.result).rejects.toThrow(TaskCancelledError);
      expect(handle.state).toBe('cancelled');
      expect(signalAborted).toBe(true);
    });

    it('defer() cancel settles to cancelled', async () => {
      const handle = svc.defer<number>();
      handle.cancel();
      expect(handle.state).toBe('cancelled');
      await expect(handle.result).rejects.toThrow(TaskCancelledError);
    });

    it('cancel on terminal handle is a no-op', async () => {
      const handle = svc.defer<number>();
      handle.resolve(1);
      expect(handle.state).toBe('completed');
      handle.cancel();
      expect(handle.state).toBe('completed');
      await expect(handle.result).resolves.toBe(1);
    });
  });


  describe('disposal', () => {
    it('dispose cancels a running task', async () => {
      const handle = svc.run(async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
        });
      });
      handle.dispose();
      expect(handle.state).toBe('cancelled');
    });

    it('dispose cancels a pending deferred', () => {
      const handle = svc.defer<number>();
      handle.dispose();
      expect(handle.state).toBe('cancelled');
    });

    it('dispose on a settled handle is safe', async () => {
      const handle = svc.defer<number>();
      handle.resolve(42);
      await handle.result;
      expect(() => handle.dispose()).not.toThrow();
      expect(handle.state).toBe('completed');
    });
  });


  describe('onDidChangeState', () => {
    it('fires on each transition for run()', async () => {
      const states: TaskState[] = [];
      const handle = svc.run(async () => 'ok');
      handle.onDidChangeState((s) => states.push(s));
      await handle.result;
      expect(states).toEqual(['completed']);
    });

    it('resolve/reject after settlement is ignored on deferred', () => {
      const states: TaskState[] = [];
      const handle = svc.defer<number>();
      handle.onDidChangeState((s) => states.push(s));
      handle.resolve(1);
      handle.reject(new Error('nope'));
      handle.resolve(2);
      expect(states).toEqual(['completed']);
      expect(handle.state).toBe('completed');
    });
  });


  describe('consumption patterns', () => {
    it('resolves the value and completes when awaiting handle.result', async () => {
      const handle = svc.run(async () => 'value');
      const result = await handle.result;
      expect(result).toBe('value');
      expect(handle.state).toBe('completed');
    });

    it('resolves the value when a handle is tracked by id and awaited later', async () => {
      const registry = new Map<string, ITaskHandle>();
      const handle = svc.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-result';
      });
      registry.set(handle.id, handle);

      const retrieved = registry.get(handle.id)!;
      const result = await retrieved.result;
      expect(result).toBe('async-result');
    });

    it('lets a detach signal win the race while the task keeps running', async () => {
      const detach = new Promise<'detach'>((r) => setTimeout(() => r('detach'), 5));
      const handle = svc.run(async (signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return 'done';
      });

      const winner = await Promise.race([
        handle.result.then((v) => ({ kind: 'done' as const, value: v })),
        detach.then(() => ({ kind: 'detach' as const })),
      ]);

      expect(winner.kind).toBe('detach');
      expect(handle.state).toBe('running');
      handle.cancel();
    });

    it('resolves a deferred handle settled from outside the awaiting turn', async () => {
      const handle = svc.defer<string>();

      setTimeout(() => handle.resolve('from-outside'), 10);

      const result = await handle.result;
      expect(result).toBe('from-outside');
      expect(handle.state).toBe('completed');
    });
  });


  describe('IDs', () => {
    it('handles have unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const h = svc.defer<void>();
        expect(ids.has(h.id)).toBe(false);
        ids.add(h.id);
        h.cancel();
      }
    });

    it('IDs follow task-N pattern', () => {
      const h1 = svc.defer<void>();
      const h2 = svc.run(async () => {});
      expect(h1.id).toMatch(/^task-\d+$/);
      expect(h2.id).toMatch(/^task-\d+$/);
      h1.cancel();
    });
  });
});
