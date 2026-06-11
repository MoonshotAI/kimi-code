import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  DEEP_REVIEW_PERSPECTIVES,
  ReviewOrchestrator,
  SessionReviewRuntime,
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

describe('ReviewOrchestrator deep review', () => {
  it('runs full-file reviewer groups and perspective reconciliators', async () => {
    await withModifiedRepo(async (repo, paths) => {
      const runtime = createRuntime();
      const spawned: ReviewAssignment[] = [];
      const launcher = createLauncher({
        onSpawn: (review) => {
          const assignment = review.getAssignment();
          spawned.push(assignment);

          if (assignment.role === 'reviewer') {
            markFullFileRead(review);
            review.addComment({
              severity: 'important',
              path: assignment.assignedFiles[0]!,
              line: 1,
              title: `${assignment.perspective ?? 'Deep'} finding`,
              body: 'The full-file pass found an issue.',
            });
            review.updateProgress({ status: 'complete', summary: 'One candidate.' });
            return;
          }

          markPatchRead(review);
          const sourceIds = assignment.sourceCommentIds ?? [];
          const firstSource = review
            .getComments({ state: 'candidate' })
            .find((comment) => sourceIds.includes(comment.id));
          if (firstSource !== undefined && sourceIds.length > 0) {
            review.mergeComments({
              sourceCommentIds: sourceIds,
              severity: 'important',
              path: firstSource.path,
              line: firstSource.line,
              title: `${assignment.perspective ?? 'Deep'} merged finding`,
              body: 'Grouped Deep findings were reconciled by perspective.',
            });
          }
          review.updateProgress({ status: 'complete', summary: 'Perspective reconciled.' });
        },
      });

      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'deep',
      });

      const reviewers = spawned.filter((assignment) => assignment.role === 'reviewer');
      const reconciliators = spawned.filter((assignment) => assignment.role === 'reconciliator');
      expect(reviewers).toHaveLength(8);
      expect(reviewers.every((assignment) => assignment.requiredCoverage === 'full_file')).toBe(true);
      expect(reconciliators).toHaveLength(DEEP_REVIEW_PERSPECTIVES.length);
      expect(reconciliators.map((assignment) => assignment.perspective)).toEqual([
        ...DEEP_REVIEW_PERSPECTIVES,
      ]);

      const coverageCounts = new Map<string, number>();
      for (const assignment of reviewers) {
        for (const path of assignment.assignedFiles) {
          coverageCounts.set(path, (coverageCounts.get(path) ?? 0) + 1);
        }
      }
      expect(paths.map((path) => coverageCounts.get(path))).toEqual(
        paths.map(() => DEEP_REVIEW_PERSPECTIVES.length),
      );
      expect(reconciliators[0]?.sourceCommentIds).toEqual([
        'review-comment-1',
        'review-comment-5',
      ]);
      expect(result).toMatchObject({
        intensity: 'deep',
        status: 'complete',
      });
      expect(result.comments).toHaveLength(DEEP_REVIEW_PERSPECTIVES.length);
      expect(result.comments[0]?.sourceCommentIds).toEqual([
        'review-comment-1',
        'review-comment-5',
      ]);
    });
  });

  it('continues deep reviewers until full-file coverage is satisfied', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createLauncher({
        onSpawn: (review) => {
          const assignment = review.getAssignment();
          if (assignment.role === 'reconciliator') {
            markPatchRead(review);
            review.updateProgress({ status: 'complete', summary: 'No candidates.' });
          }
        },
        onResume: (review) => {
          markFullFileRead(review);
          review.updateProgress({ status: 'complete', summary: 'Covered after retry.' });
        },
      });

      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'deep',
      });

      expect(result.status).toBe('complete');
      expect(launcher.resume).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          prompt: expect.stringContaining('(full_file)'),
        }),
      );
    }, ['src/a.ts']);
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
      return handle(agentId, review.getAssignment().role);
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

function markFullFileRead(review: ReviewAgentFacade): void {
  for (const file of review.getChangedFiles().filter((item) =>
    review.getAssignment().assignedFiles.includes(item.path),
  )) {
    review.recordFileVersionRead({
      path: file.path,
      lineOffset: 1,
      nLines: 10,
      totalLines: 10,
    });
  }
}

function markPatchRead(review: ReviewAgentFacade): void {
  for (const path of review.getAssignment().assignedFiles) {
    review.recordPatchRead({ path, ranges: [{ start: 1, end: 10 }] });
  }
}

async function withModifiedRepo(
  run: (repo: string, paths: readonly string[]) => Promise<void>,
  paths: readonly string[] = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'kimi-review-deep-'));
  try {
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'review@example.test');
    await git(repo, 'config', 'user.name', 'Review Test');
    await mkdir(join(repo, 'src'));
    for (const path of paths) {
      await writeFile(join(repo, path), 'base\n');
    }
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');
    for (const path of paths) {
      await writeFile(join(repo, path), 'base\nchanged\n');
    }
    await run(repo, paths);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function git(repo: string, ...args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd: repo });
}
