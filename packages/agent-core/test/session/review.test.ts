import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '../../src/errors';
import { FlagResolver } from '../../src/flags';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { testKaos } from '../fixtures/test-kaos';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Session review lifecycle', () => {
  it('keeps completed review state when cancelReview is called after completion', async () => {
    const sessionDir = await makeTempDir();
    const session = newReviewSession(sessionDir);
    try {
      session.review.startReview(
        { target: { scope: 'working_tree' }, intensity: 'standard' },
        {
          fileCount: 1,
          additions: 1,
          deletions: 0,
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
        },
      );
      const reviewer = session.review.createAgentFacade(
        session.review.createAssignment({
          role: 'reviewer',
          assignedFiles: ['src/a.ts'],
          requiredCoverage: 'patch',
        }).id,
      );
      reviewer.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 1, end: 1 }] });
      const comment = reviewer.addComment({
        severity: 'important',
        path: 'src/a.ts',
        line: 1,
        title: 'Preserved finding',
        body: 'Completed review comments should stay queryable.',
      });
      session.review.finishReview();

      session.cancelReview();

      expect(session.review.getActiveRun()).toBeNull();
      expect(session.review.getComments().map((item) => item.id)).toEqual([comment.id]);
    } finally {
      await session.close();
    }
  });

  it('rejects a second review while the first review is still starting', async () => {
    const sessionDir = await makeTempDir();
    const session = newReviewSession(sessionDir);
    const resumeGate = deferred<never>();
    const ensureAgentResumed = vi.fn(async () => resumeGate.promise);
    (session as any).ensureAgentResumed = ensureAgentResumed;
    const input = { target: { scope: 'working_tree' as const }, intensity: 'standard' as const };
    try {
      const first = session.startReview(input).catch((error: unknown) => error);
      await waitUntil(() => ensureAgentResumed.mock.calls.length > 0);

      const second = session.startReview(input);
      await expect(settledReviewStart(second)).resolves.toBe(ErrorCodes.TURN_AGENT_BUSY);

      resumeGate.reject(new Error('stop first review'));
      await first;
    } finally {
      await session.close();
    }
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-core-session-review-'));
  tempDirs.push(dir);
  return dir;
}

function newReviewSession(sessionDir: string): Session {
  return new Session({
    id: 'test-review-session',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc: createSessionRpc(),
    experimentalFlags: new FlagResolver({
      KIMI_CODE_EXPERIMENTAL_CODE_REVIEW: '1',
    }),
  });
}

async function settledReviewStart(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => errorCode(error),
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('pending');
      }, 10);
    }),
  ]);
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}
