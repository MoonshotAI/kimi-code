import type { TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  StagingLeaseTracker,
  type StagingLeaseEffects,
  type StagingLeaseOrigin,
} from '#/tui/controllers/staging-leases';

function turnStarted(turnId: number | string, kind: string, promptId?: string): TurnStartedEvent {
  return { type: 'turn.started', agentId: 'main', turnId, origin: { kind }, promptId } as TurnStartedEvent;
}

function turnEnded(turnId: number | string): TurnEndedEvent {
  return { type: 'turn.ended', agentId: 'main', turnId, reason: 'completed' } as TurnEndedEvent;
}

function makeEffects(): {
  effects: StagingLeaseEffects;
  takeFileIds: ReturnType<typeof vi.fn<(ids: readonly number[]) => readonly string[]>>;
  releaseRetains: ReturnType<typeof vi.fn<(ids: readonly number[]) => void>>;
  deleteFiles: ReturnType<
    typeof vi.fn<(fileIds: readonly string[], paths: readonly string[]) => Promise<void>>
  >;
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  deleted: { fileIds: string[]; paths: string[] };
} {
  const deleted = { fileIds: [] as string[], paths: [] as string[] };
  const takeFileIds = vi.fn((ids: readonly number[]) => ids.map((id) => `file-${id}`));
  const releaseRetains = vi.fn((ids: readonly number[]) => void ids);
  const deleteFiles = vi.fn((fileIds: readonly string[], paths: readonly string[]) => {
    deleted.fileIds.push(...fileIds);
    deleted.paths.push(...paths);
    return Promise.resolve();
  });
  const warn = vi.fn((message: string) => void message);
  return {
    effects: { takeFileIds, releaseRetains, deleteFiles, warn },
    takeFileIds,
    releaseRetains,
    deleteFiles,
    warn,
    deleted,
  };
}

function makeTracker(): ReturnType<typeof makeEffects> & { tracker: StagingLeaseTracker } {
  const mocks = makeEffects();
  return { ...mocks, tracker: new StagingLeaseTracker(mocks.effects) };
}

describe('StagingLeaseTracker', () => {
  describe('create', () => {
    it('returns undefined when nothing is staged', () => {
      const { tracker } = makeTracker();
      expect(tracker.create([], [], 'user')).toBeUndefined();
    });
  });

  describe('turn claiming', () => {
    it('claims the earliest unbound lease of the matching origin', () => {
      const { tracker } = makeTracker();
      const first = tracker.create([], ['/cache/a'], 'user');
      const second = tracker.create([], ['/cache/b'], 'user');

      tracker.handleTurnStarted(turnStarted(1, 'user'));
      expect(first?.turnId).toBe('1');
      expect(second?.turnId).toBeUndefined();

      tracker.handleTurnStarted(turnStarted(2, 'user'));
      expect(second?.turnId).toBe('2');
    });

    it('warns when several unclaimed same-origin leases make the heuristic claim ambiguous', () => {
      const { tracker, warn } = makeTracker();
      tracker.create([], ['/cache/a'], 'user');
      tracker.create([], ['/cache/b'], 'user');

      tracker.handleTurnStarted(turnStarted(1, 'user'));

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("'user'");
      expect(warn.mock.calls[0]![0]).toContain('1');
    });

    it('stays silent while at most one same-origin lease is unclaimed', () => {
      const { tracker, warn } = makeTracker();
      tracker.create([], ['/cache/a'], 'user');

      tracker.handleTurnStarted(turnStarted(1, 'user'));
      tracker.handleTurnStarted(turnStarted(2, 'user'));

      expect(warn).not.toHaveBeenCalled();
    });

    it('binds the exact lease when turn.started echoes its submission id', () => {
      const { tracker, warn } = makeTracker();
      const earlier = tracker.create([], ['/cache/a'], 'user');
      const exact = tracker.create([], ['/cache/b'], 'user', 'sub-2');

      // The exact id wins over the earlier unclaimed same-origin lease, and
      // the ambiguity warning stays silent.
      tracker.handleTurnStarted(turnStarted(1, 'user', 'sub-2'));

      expect(exact?.turnId).toBe('1');
      expect(earlier?.turnId).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to the origin heuristic when the promptId is unknown', () => {
      const { tracker, warn } = makeTracker();
      const first = tracker.create([], ['/cache/a'], 'user', 'sub-1');
      const second = tracker.create([], ['/cache/b'], 'user');

      tracker.handleTurnStarted(turnStarted(1, 'user', 'sub-unknown'));

      expect(first?.turnId).toBe('1');
      expect(second?.turnId).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    });

    it('does not exact-bind a released lease whose submission id is echoed again', () => {
      const { tracker } = makeTracker();
      const released = tracker.create([], ['/cache/a'], 'user', 'sub-1');
      tracker.release(released);
      const fallback = tracker.create([], ['/cache/b'], 'user');

      tracker.handleTurnStarted(turnStarted(1, 'user', 'sub-1'));

      expect(released?.turnId).toBeUndefined();
      expect(fallback?.turnId).toBe('1');
    });

    it('ignores turns of other or unknown origins', () => {
      const { tracker } = makeTracker();
      const lease = tracker.create([], ['/cache/a'], 'skill_activation');

      tracker.handleTurnStarted(turnStarted(1, 'user'));
      tracker.handleTurnStarted(turnStarted(2, 'plugin_command'));
      tracker.handleTurnStarted(turnStarted(3, 'system_trigger'));
      expect(lease?.turnId).toBeUndefined();

      tracker.handleTurnStarted(turnStarted(4, 'skill_activation'));
      expect(lease?.turnId).toBe('4');
    });

    it('does not rebind a bound or released lease', () => {
      const { tracker } = makeTracker();
      const lease = tracker.create([], ['/cache/a'], 'user');
      tracker.bindToTurn(lease, '1');
      tracker.bindToTurn(lease, '2');
      expect(lease?.turnId).toBe('1');

      tracker.release(lease);
      tracker.bindToTurn(lease, '3');
      expect(lease?.turnId).toBe('1');
    });
  });

  describe('turn-end release', () => {
    it('deletes daemon uploads but retires cache copies to session lifetime', () => {
      const { tracker, deleted } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], 'user');
      tracker.bindToTurn(lease, '1');

      tracker.handleTurnEnded(turnEnded(1));

      expect(deleted.fileIds).toEqual(['file-1']);
      expect(deleted.paths).toEqual([]);
    });

    it('deletes retired cache copies at session close', () => {
      const { tracker, deleted } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], 'user');
      tracker.bindToTurn(lease, '1');
      tracker.handleTurnEnded(turnEnded(1));
      expect(deleted.paths).toEqual([]);

      tracker.releaseAll();
      expect(deleted.paths).toEqual(['/cache/a']);
    });

    it('releases a bound lease exactly once across repeated turn.ended events', () => {
      const { tracker, deleteFiles } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], 'user');
      tracker.bindToTurn(lease, '1');

      tracker.handleTurnEnded(turnEnded(1));
      tracker.handleTurnEnded(turnEnded(1));
      tracker.release(lease);

      expect(deleteFiles).toHaveBeenCalledTimes(1);
    });

    it('ignores turn.ended for unknown turns', () => {
      const { tracker, deleteFiles } = makeTracker();
      tracker.create([1], ['/cache/a'], 'user');
      tracker.handleTurnEnded(turnEnded(99));
      expect(deleteFiles).not.toHaveBeenCalled();
    });

    it('consumes one retain per id occurrence at turn end', () => {
      const { tracker, takeFileIds } = makeTracker();
      // Multiplicity in the lease's id list is the retain count (creation
      // sites dedupe per extraction): [7, 7] means two retains, e.g. a
      // batched steer of two queued messages sharing the image.
      tracker.create([7, 7], [], 'user', 'sub-dup');
      tracker.handleTurnStarted(turnStarted(1, 'user', 'sub-dup'));

      tracker.handleTurnEnded(turnEnded(1));

      expect(takeFileIds.mock.calls).toEqual([[[7]], [[7]]]);
    });
  });

  describe('abandonment', () => {
    // Every abandonment entry point deletes daemon uploads and cache copies
    // immediately, whether or not a turn ever consumed the lease.
    it.each([
      [
        'release',
        (tracker: StagingLeaseTracker) => {
          tracker.release(tracker.create([1], ['/cache/a'], 'user'));
          tracker.release(tracker.create([2], ['/cache/b'], 'user'));
        },
      ],
      [
        'releaseMedia and releaseQueued',
        (tracker: StagingLeaseTracker) => {
          tracker.releaseMedia([1], ['/cache/a']);
          tracker.releaseQueued([
            { text: 'q', agentId: 'main', imageAttachmentIds: [2], stagingPaths: ['/cache/b'] },
          ]);
        },
      ],
      [
        'releaseAll',
        (tracker: StagingLeaseTracker) => {
          tracker.create([1], ['/cache/a'], 'user');
          tracker.bindToTurn(tracker.create([2], ['/cache/b'], 'user'), '1');
          tracker.releaseAll();
        },
      ],
    ] as const)('%s deletes daemon uploads and cache copies immediately', (_name, abandon) => {
      const { tracker, deleted } = makeTracker();

      abandon(tracker);

      expect(deleted.fileIds).toEqual(['file-1', 'file-2']);
      expect(deleted.paths).toEqual(['/cache/a', '/cache/b']);
    });
  });

  describe('queue recall', () => {
    it('consumes only the retain and retires cache copies instead of deleting', () => {
      const { tracker, releaseRetains, deleted } = makeTracker();

      // A recall restores the draft into the editor — not a discard: the
      // daemon upload stays staged (only the retain is consumed) and the
      // cache copy retires to session lifetime.
      tracker.releaseRecalled({
        imageAttachmentIds: [2],
        stagingPaths: ['/cache/b'],
      });

      expect(releaseRetains).toHaveBeenCalledWith([2]);
      expect(deleted.fileIds).toEqual([]);
      expect(deleted.paths).toEqual([]);

      tracker.releaseAll();
      expect(deleted.fileIds).toEqual([]);
      expect(deleted.paths).toEqual(['/cache/b']);
    });
  });

  describe('defer', () => {
    it('unbinds the lease without consuming retains or deleting files', () => {
      const { tracker, takeFileIds, releaseRetains, deleted } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], 'user', 'sub-1');

      tracker.defer(lease);

      expect(lease?.released).toBe(true);
      expect(takeFileIds).not.toHaveBeenCalled();
      expect(releaseRetains).not.toHaveBeenCalled();
      expect(deleted).toEqual({ fileIds: [], paths: [] });

      // A deferred lease is gone for good: turn events cannot claim it and
      // releaseAll does not sweep its media.
      tracker.handleTurnStarted(turnStarted(1, 'user', 'sub-1'));
      expect(lease?.turnId).toBeUndefined();
      tracker.releaseAll();
      expect(deleted).toEqual({ fileIds: [], paths: [] });
    });
  });

  describe('trackDispatch', () => {
    const origin: StagingLeaseOrigin = 'user';

    it('keeps the lease when the dispatch resolves', async () => {
      const { tracker, deleteFiles } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], origin);
      const onError = vi.fn();

      tracker.trackDispatch(lease, Promise.resolve(), onError);
      await tracker.drain();

      expect(onError).not.toHaveBeenCalled();
      expect(deleteFiles).not.toHaveBeenCalled();
      expect(lease?.released).toBe(false);
    });

    it('releases an unclaimed lease exactly once when the dispatch rejects', async () => {
      const { tracker, deleted } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], origin);
      const onError = vi.fn();

      tracker.trackDispatch(lease, Promise.reject(new Error('boom')), onError);
      await tracker.drain();

      expect(onError).toHaveBeenCalledOnce();
      expect(deleted.fileIds).toEqual(['file-1']);
      expect(deleted.paths).toEqual(['/cache/a']);
      // A later turn end must not delete again.
      tracker.handleTurnEnded(turnEnded(1));
      tracker.releaseAll();
      expect(deleted.fileIds).toEqual(['file-1']);
    });

    it('does not release a lease a turn already claimed when the dispatch rejects', async () => {
      const { tracker, deleted } = makeTracker();
      const lease = tracker.create([1], ['/cache/a'], origin);
      tracker.bindToTurn(lease, '7');

      tracker.trackDispatch(lease, Promise.reject(new Error('boom')), vi.fn());
      await tracker.drain();
      expect(deleted.fileIds).toEqual([]);

      // The owning turn still releases it at turn end (uploads deleted, copies retired).
      tracker.handleTurnEnded(turnEnded(7));
      expect(deleted.fileIds).toEqual(['file-1']);
      expect(deleted.paths).toEqual([]);
    });
  });

  describe('track/drain', () => {
    it('drain awaits in-flight cleanups and track swallows rejections', async () => {
      const { tracker } = makeTracker();
      let settled = false;
      tracker.track(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 10);
        }),
      );
      tracker.track(Promise.reject(new Error('ignored')));

      await tracker.drain();
      expect(settled).toBe(true);
    });
  });
});
