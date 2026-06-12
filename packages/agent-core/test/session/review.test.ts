import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const session = new Session({
      id: 'test-review-session',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_CODE_REVIEW: '1',
      }),
    });
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
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-core-session-review-'));
  tempDirs.push(dir);
  return dir;
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
