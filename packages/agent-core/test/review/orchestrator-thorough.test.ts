import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  ReviewOrchestrator,
  SessionReviewRuntime,
  THOROUGH_REVIEW_PERSPECTIVES,
  type ReviewAgentFacade,
  type ReviewAssignment,
  type ReviewWorkerLauncher,
} from '../../src/review';
import type {
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from '../../src/session/subagent-host';
import { testKaos } from '../fixtures/test-kaos';

const execFileAsync = promisify(execFile);

describe('ReviewOrchestrator thorough review', () => {
  it('runs focused reviewers and reconciles their candidate comments', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const spawned: ReviewAssignment[] = [];
      const launcher = createLauncher({
        onSpawn: (review) => {
          const assignment = review.getAssignment();
          spawned.push(assignment);
          markPatchRead(review);

          if (assignment.role === 'reviewer') {
            review.addComment({
              severity: 'important',
              path: 'src/a.ts',
              line: 2,
              title: `${assignment.perspective ?? 'Focused'} issue`,
              body: 'The changed line needs attention.',
            });
            review.updateProgress({ status: 'complete', summary: 'One candidate.' });
            return;
          }

          const sources = review.getComments({ state: 'candidate' });
          review.mergeComments({
            sourceCommentIds: sources.map((comment) => comment.id),
            severity: 'important',
            path: 'src/a.ts',
            line: 2,
            title: 'Merged finding',
            body: 'Multiple reviewers found the same changed-line issue.',
          });
          review.updateProgress({ status: 'complete', summary: 'Merged candidates.' });
        },
      });

      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'thorough',
      });

      const reviewers = spawned.filter((assignment) => assignment.role === 'reviewer');
      const reconciliators = spawned.filter((assignment) => assignment.role === 'reconciliator');
      expect(reviewers).toHaveLength(THOROUGH_REVIEW_PERSPECTIVES.length);
      expect(reviewers.map((assignment) => assignment.perspective)).toEqual([
        ...THOROUGH_REVIEW_PERSPECTIVES,
      ]);
      expect(reviewers.every((assignment) => assignment.assignedFiles.includes('src/a.ts'))).toBe(true);
      expect(reconciliators).toHaveLength(1);
      expect(reconciliators[0]).toMatchObject({
        role: 'reconciliator',
        sourceCommentIds: ['review-comment-1', 'review-comment-2', 'review-comment-3'],
      });
      expect(result).toMatchObject({
        intensity: 'thorough',
        status: 'complete',
        comments: [
          {
            id: 'review-merged-comment-1',
            sourceCommentIds: ['review-comment-1', 'review-comment-2', 'review-comment-3'],
            title: 'Merged finding',
          },
        ],
      });
    });
  });

  it('continues the reconciliator until every source comment is resolved', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createLauncher({
        onSpawn: (review) => {
          const assignment = review.getAssignment();
          markPatchRead(review);

          if (assignment.role === 'reviewer') {
            review.addComment({
              severity: 'important',
              path: 'src/a.ts',
              line: 2,
              title: `${assignment.perspective ?? 'Focused'} issue`,
              body: 'The changed line needs attention.',
            });
            review.updateProgress({ status: 'complete', summary: 'One candidate.' });
          }
        },
        onResume: (review) => {
          const sources = review.getComments({ state: 'candidate' });
          review.mergeComments({
            sourceCommentIds: sources.map((comment) => comment.id),
            severity: 'important',
            path: 'src/a.ts',
            line: 2,
            title: 'Merged finding',
            body: 'The unresolved source comments are now reconciled.',
          });
          review.updateProgress({ status: 'complete', summary: 'Merged after retry.' });
        },
      });

      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'thorough',
      });

      expect(result.status).toBe('complete');
      expect(result.comments).toHaveLength(1);
      expect(launcher.resume).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          prompt: expect.stringContaining('Unreconciled source comments: review-comment-'),
        }),
      );
    });
  });
});

function createOrchestrator(
  repo: string,
  runtime: SessionReviewRuntime,
  launcher: ReviewWorkerLauncher,
): ReviewOrchestrator {
  const kaos = testKaos.withCwd(repo);
  return new ReviewOrchestrator({
    kaos,
    runtime,
    launcher,
    loadRepoInstructions: async () => 'Review repo instructions.',
  });
}

function createRuntime(): SessionReviewRuntime {
  const counters = new Map<string, number>();
  return new SessionReviewRuntime({
    idGenerator: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-${String(next)}`;
    },
  });
}

function createLauncher(input: {
  readonly onSpawn?: (review: ReviewAgentFacade, options: SpawnSubagentOptions) => void;
  readonly onResume?: (review: ReviewAgentFacade, options: RunSubagentOptions) => void;
}): ReviewWorkerLauncher & {
  readonly spawn: ReturnType<typeof vi.fn<ReviewWorkerLauncher['spawn']>>;
  readonly resume: ReturnType<typeof vi.fn<ReviewWorkerLauncher['resume']>>;
} {
  const reviews = new Map<string, ReviewAgentFacade>();
  let nextAgent = 0;
  return {
    spawn: vi.fn(async (options: SpawnSubagentOptions) => {
      if (options.review === undefined) throw new Error('missing review facade');
      nextAgent += 1;
      const agentId = `agent-${String(nextAgent)}`;
      reviews.set(agentId, options.review);
      input.onSpawn?.(options.review, options);
      return handle(agentId, options.profileName);
    }),
    resume: vi.fn(async (agentId: string, options: RunSubagentOptions) => {
      const review = reviews.get(agentId);
      if (review === undefined) throw new Error(`missing review facade for ${agentId}`);
      input.onResume?.(review, options);
      return handle(agentId, 'reconciliator');
    }),
  };
}

function handle(agentId: string, profileName: string): SubagentHandle {
  return {
    agentId,
    profileName,
    resumed: false,
    completion: Promise.resolve({ result: 'done' }),
  };
}

function markPatchRead(review: ReviewAgentFacade): void {
  for (const file of review.getChangedFiles()) {
    review.recordPatchRead({ path: file.path, ranges: [{ start: 1, end: 10 }] });
  }
}

async function withModifiedRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'kimi-review-thorough-'));
  try {
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'review@example.test');
    await git(repo, 'config', 'user.name', 'Review Test');
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src/a.ts'), 'base\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');
    await writeFile(join(repo, 'src/a.ts'), 'base\nchanged\n');
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function git(repo: string, ...args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd: repo });
}
