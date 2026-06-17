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
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from '../../src/session/subagent-host';
import { testKaos } from '../fixtures/test-kaos';

const execFileAsync = promisify(execFile);

describe('ReviewOrchestrator deep review', () => {
  it('previews the deep reviewer plan', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createLauncher({});

      const plan = await createOrchestrator(repo, runtime, launcher).previewPlan({
        target: { scope: 'working_tree' },
        intensity: 'deep',
      });

      expect(plan).toMatchObject({
        intensity: 'deep',
        reviewerCount: 8,
        perspectives: [...DEEP_REVIEW_PERSPECTIVES],
        reconciliationGroups: [...DEEP_REVIEW_PERSPECTIVES],
      });
      expect(plan.fileGroups).toHaveLength(2);
      expect(plan.fileGroups?.[0]).toMatchObject({
        label: 'Files 1-4',
        perspectives: [...DEEP_REVIEW_PERSPECTIVES],
      });
    });
  });

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
      expect(launcher.runQueued).toHaveBeenCalled();
      const queuedTasks = launcher.runQueued.mock.calls[0]?.[0] ?? [];
      expect(queuedTasks).toHaveLength(8);
      expect(queuedTasks.map((task) => task.profileName)).toEqual(
        queuedTasks.map(() => 'reviewer'),
      );
      expect(queuedTasks.map((task) => task.parentToolCallId)).toEqual(
        queuedTasks.map(() => 'review:deep-agent-swarm'),
      );
      expect(queuedTasks.map((task) => task.swarmIndex)).toEqual(
        Array.from({ length: queuedTasks.length }, (_item, index) => index + 1),
      );
      expect(queuedTasks.every((task) => task.review !== undefined)).toBe(true);
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
  readonly runQueued: ReturnType<typeof vi.fn<
    <T>(tasks: readonly QueuedSubagentTask<T>[]) => Promise<Array<QueuedSubagentRunResult<T>>>
  >>;
} {
  const reviews = new Map<string, ReviewAgentFacade>();
  let nextAgent = 0;
  const launcher = {
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
    runQueued: vi.fn(async <T,>(tasks: readonly QueuedSubagentTask<T>[]) => {
      const results: Array<QueuedSubagentRunResult<T>> = [];
      for (const task of tasks) {
        if (task.kind === 'resume') {
          const handle = await launcher.resume(task.resumeAgentId, {
            parentToolCallId: task.parentToolCallId,
            parentToolCallUuid: task.parentToolCallUuid,
            prompt: task.prompt,
            description: task.description,
            swarmIndex: task.swarmIndex,
            runInBackground: task.runInBackground,
            signal: task.signal ?? new AbortController().signal,
          });
          await handle.completion;
          results.push({ task, agentId: handle.agentId, status: 'completed', result: 'done' });
          continue;
        }
        const handle = await launcher.spawn({
          profileName: task.profileName,
          parentToolCallId: task.parentToolCallId,
          parentToolCallUuid: task.parentToolCallUuid,
          prompt: task.prompt,
          description: task.description,
          swarmIndex: task.swarmIndex,
          runInBackground: task.runInBackground,
          signal: task.signal ?? new AbortController().signal,
          review: task.review,
          swarmItem: task.swarmItem,
        });
        await handle.completion;
        results.push({ task, agentId: handle.agentId, status: 'completed', result: 'done' });
      }
      return results;
    }),
  };
  return launcher;
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
      changedVersion: true,
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
