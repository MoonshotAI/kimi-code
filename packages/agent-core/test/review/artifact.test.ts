import { describe, expect, it } from 'vitest';

import type { Kaos } from '@moonshot-ai/kaos';

import {
  buildReviewArtifact,
  ReviewArtifactStore,
  timestampSlug,
} from '../../src/review/artifact';
import type { ReviewFinalComment, ReviewResult } from '../../src/review/types';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

const DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  '',
].join('\n');

function comment(overrides: Partial<ReviewFinalComment> = {}): ReviewFinalComment {
  return {
    id: 'c1',
    sourceCommentIds: [],
    severity: 'critical',
    path: 'src/foo.ts',
    line: 2,
    title: 'Bad bug',
    body: 'This is wrong.',
    ...overrides,
  };
}

function result(comments: readonly ReviewFinalComment[]): ReviewResult {
  return {
    target: { scope: 'working_tree' },
    intensity: 'standard',
    status: 'complete',
    stats: { fileCount: 1, additions: 2, deletions: 1, files: [] },
    summary: 'Reviewed 1 file.',
    comments,
  };
}

function memKaos(): Kaos {
  const files = new Map<string, string>();
  return createFakeKaos({
    mkdir: async () => {},
    writeText: async (path: string, data: string) => {
      files.set(path, data);
      return data.length;
    },
    readText: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
  });
}

describe('buildReviewArtifact', () => {
  it('derives diff-space anchors from the captured patch', () => {
    const artifact = buildReviewArtifact({
      result: result([comment()]),
      createdAt: '2026-06-14T14:30:52Z',
      diff: DIFF,
    });
    const built = artifact.comments[0]!;
    expect(built.anchor).toEqual({
      path: 'src/foo.ts',
      side: 'new',
      line: 2,
      hunkHeader: '@@ -1,3 +1,4 @@',
    });
    expect(built.state).toBe('candidate');
    expect(built.dismissal).toBeNull();
    expect(artifact.diff).toBe(DIFF);
  });

  it('omits the hunk header when the line is not in the diff', () => {
    const artifact = buildReviewArtifact({
      result: result([comment({ line: 999 })]),
      createdAt: '2026-06-14T14:30:52Z',
      diff: DIFF,
    });
    expect(artifact.comments[0]!.anchor.hunkHeader).toBeUndefined();
  });
});

describe('ReviewArtifactStore', () => {
  it('assigns sequential ordinals and lists summaries', async () => {
    const store = new ReviewArtifactStore(memKaos(), '/session');
    const first = await store.save(
      buildReviewArtifact({ result: result([comment()]), createdAt: '2026-06-14T14:30:52Z', diff: DIFF }),
    );
    const second = await store.save(
      buildReviewArtifact({ result: result([]), createdAt: '2026-06-14T15:00:00Z', diff: '' }),
    );
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);

    const summaries = await store.list();
    expect(summaries.map((s) => s.id)).toEqual([1, 2]);
    expect(summaries[0]).toMatchObject({ id: 1, commentCount: 1, criticalCount: 1, rejectedCount: 0 });
  });

  it('derives a topic slug from the top finding and de-duplicates it', async () => {
    const store = new ReviewArtifactStore(memKaos(), '/session');
    const first = await store.save(
      buildReviewArtifact({
        result: result([comment({ title: 'Token refresh races on login' })]),
        createdAt: '2026-06-14T14:30:52Z',
        diff: DIFF,
      }),
    );
    const second = await store.save(
      buildReviewArtifact({
        result: result([comment({ title: 'Token refresh races on login' })]),
        createdAt: '2026-06-14T15:00:00Z',
        diff: DIFF,
      }),
    );
    expect(first.slug).toBe('token-refresh-races-on-login');
    expect(second.slug).toBe('token-refresh-races-on-login-2');
    expect((await store.list()).map((s) => s.slug)).toContain('token-refresh-races-on-login');
  });

  it('reads a saved artifact back by id', async () => {
    const store = new ReviewArtifactStore(memKaos(), '/session');
    const saved = await store.save(
      buildReviewArtifact({ result: result([comment()]), createdAt: '2026-06-14T14:30:52Z', diff: DIFF }),
    );
    const read = await store.read(saved.id);
    expect(read?.comments[0]?.title).toBe('Bad bug');
    expect(await store.read(404)).toBeUndefined();
  });

  it('rejects and restores a comment, updating both file and index', async () => {
    const store = new ReviewArtifactStore(memKaos(), '/session');
    const saved = await store.save(
      buildReviewArtifact({ result: result([comment()]), createdAt: '2026-06-14T14:30:52Z', diff: DIFF }),
    );

    const rejected = await store.rejectComment(saved.id, 'c1', 'not a real issue');
    expect(rejected?.comments[0]?.state).toBe('dismissed');
    expect(rejected?.comments[0]?.dismissal).toEqual({ reason: 'rejected_by_user', note: 'not a real issue' });
    expect((await store.list())[0]?.rejectedCount).toBe(1);

    const restored = await store.restoreComment(saved.id, 'c1');
    expect(restored?.comments[0]?.state).toBe('candidate');
    expect(restored?.comments[0]?.dismissal).toBeNull();
    expect((await store.list())[0]?.rejectedCount).toBe(0);
  });

  it('returns undefined when rejecting on a missing review', async () => {
    const store = new ReviewArtifactStore(memKaos(), '/session');
    expect(await store.rejectComment(1, 'c1')).toBeUndefined();
  });
});

describe('timestampSlug', () => {
  it('formats an ISO timestamp as a sortable slug', () => {
    expect(timestampSlug('2026-06-14T14:30:52Z')).toBe('20260614-143052');
    expect(timestampSlug('not-a-date')).toBe('review');
  });
});
