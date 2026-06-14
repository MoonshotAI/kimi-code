import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { APIProviderRateLimitError } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import {
  ReviewOrchestrator,
  SessionReviewRuntime,
  type ReviewAgentFacade,
  type ReviewWorkerLauncher,
} from '../../src/review';
import type { AgentEvent } from '../../src/rpc/events';
import type {
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from '../../src/session/subagent-host';
import { testKaos } from '../fixtures/test-kaos';

const execFileAsync = promisify(execFile);

describe('ReviewOrchestrator standard review', () => {
  it('returns a no-finding review result', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createLauncher({
        onSpawn: (review) => {
          markPatchRead(review);
          review.updateProgress({ status: 'complete', summary: 'No findings.' });
        },
      });
      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'standard',
      });

      expect(result.status).toBe('complete');
      expect(result.comments).toEqual([]);
      expect(result.summary).toContain('No review comments');
      expect(runtime.getActiveRun()).toBeNull();
    });
  });

  it('returns candidate comments as final standard comments', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createLauncher({
        onSpawn: (review) => {
          review.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 1, end: 4 }] });
          review.addComment({
            severity: 'important',
            path: 'src/a.ts',
            line: 2,
            title: 'Missing validation',
            body: 'The changed path accepts unchecked input.',
          });
          review.updateProgress({ status: 'complete', summary: 'One issue.' });
        },
      });
      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'standard',
        focus: 'input validation',
      });

      expect(result.comments).toEqual([
        expect.objectContaining({
          sourceCommentIds: ['review-comment-1'],
          severity: 'important',
          path: 'src/a.ts',
          line: 2,
          title: 'Missing validation',
        }),
      ]);
      expect(result.summary).toContain('1 review comment');
    });
  });

  it('continues the reviewer when coverage is missing', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createLauncher({
        onResume: (review) => {
          markPatchRead(review);
          review.updateProgress({ status: 'complete', summary: 'Covered after retry.' });
        },
      });
      const result = await createOrchestrator(repo, runtime, launcher).start({
        target: { scope: 'working_tree' },
        intensity: 'standard',
      });

      expect(result.status).toBe('complete');
      expect(launcher.resume).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          prompt: expect.stringContaining('Missing required coverage: src/a.ts (patch).'),
        }),
      );
    });
  });

  it('clears active runtime state when canceled', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createPendingLauncher();
      const orchestrator = createOrchestrator(repo, runtime, launcher);
      const review = orchestrator.start({
        target: { scope: 'working_tree' },
        intensity: 'standard',
      });
      await waitUntil(() => launcher.spawn.mock.calls.length > 0);

      orchestrator.cancel();

      await expect(review).rejects.toThrow('Aborted by the user');
      expect(runtime.getActiveRun()).toBeNull();
      expect(runtime.getComments()).toEqual([]);
    });
  });

  it('emits cancellation when aborted before the review run starts', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const launcher = createPendingLauncher();
      const events: AgentEvent[] = [];
      const loadRepoInstructions = deferred<string>();
      let loadStarted = false;
      const orchestrator = createOrchestrator(
        repo,
        runtime,
        launcher,
        (event) => {
          events.push(event);
        },
        async () => {
          loadStarted = true;
          return loadRepoInstructions.promise;
        },
      );
      const review = orchestrator.start({
        target: { scope: 'working_tree' },
        intensity: 'standard',
      });
      await waitUntil(() => loadStarted);

      orchestrator.cancel();
      loadRepoInstructions.resolve('Review repo instructions.');

      await expect(review).rejects.toThrow('Aborted by the user');
      expect(runtime.getActiveRun()).toBeNull();
      expect(events.map((event) => event.type)).toEqual(['review.cancelled']);
    });
  });

  it('emits a structured provider error when reviewer execution fails', async () => {
    await withModifiedRepo(async (repo) => {
      const runtime = createRuntime();
      const events: AgentEvent[] = [];
      const launcher: ReviewWorkerLauncher = {
        spawn: vi.fn(async (_options: SpawnSubagentOptions) =>
          handle(Promise.reject(new APIProviderRateLimitError('Rate limited', 'req-429'))),
        ),
        resume: vi.fn(),
      };

      await expect(
        createOrchestrator(repo, runtime, launcher, (event) => {
          events.push(event);
        }).start({
          target: { scope: 'working_tree' },
          intensity: 'standard',
        }),
      ).rejects.toThrow('Rate limited');

      expect(runtime.getActiveRun()).toBeNull();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'review.failed',
          message: 'Rate limited',
          error: expect.objectContaining({
            code: 'provider.rate_limit',
            message: 'Rate limited',
            details: expect.objectContaining({
              statusCode: 429,
              requestId: 'req-429',
            }),
            retryable: true,
          }),
        }),
      );
    });
  });
});

function createOrchestrator(
  repo: string,
  runtime: SessionReviewRuntime,
  launcher: ReviewWorkerLauncher,
  emitEvent?: (event: AgentEvent) => void,
  loadRepoInstructions?: () => Promise<string>,
): ReviewOrchestrator {
  const kaos = testKaos.withCwd(repo);
  return new ReviewOrchestrator({
    kaos,
    runtime,
    launcher,
    loadRepoInstructions: loadRepoInstructions ?? (async () => 'Review repo instructions.'),
    emitEvent,
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
  readonly onSpawn?: (review: ReviewAgentFacade) => void;
  readonly onResume?: (review: ReviewAgentFacade) => void;
}): ReviewWorkerLauncher & {
  readonly spawn: ReturnType<typeof vi.fn<ReviewWorkerLauncher['spawn']>>;
  readonly resume: ReturnType<typeof vi.fn<ReviewWorkerLauncher['resume']>>;
} {
  let review: ReviewAgentFacade | undefined;
  return {
    spawn: vi.fn(async (options: SpawnSubagentOptions) => {
      if (options.review === undefined) throw new Error('missing review facade');
      review = options.review;
      input.onSpawn?.(review);
      return handle(Promise.resolve({ result: 'done' }));
    }),
    resume: vi.fn(async (_agentId: string, _options: RunSubagentOptions) => {
      if (review === undefined) throw new Error('missing review facade');
      input.onResume?.(review);
      return handle(Promise.resolve({ result: 'done' }));
    }),
  };
}

function createPendingLauncher(): ReviewWorkerLauncher & {
  readonly spawn: ReturnType<typeof vi.fn<ReviewWorkerLauncher['spawn']>>;
  readonly resume: ReturnType<typeof vi.fn<ReviewWorkerLauncher['resume']>>;
} {
  return {
    spawn: vi.fn(async (options: SpawnSubagentOptions) => {
      const completion = new Promise<{ readonly result: string }>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
      return handle(completion);
    }),
    resume: vi.fn(async (_agentId: string, _options: RunSubagentOptions) =>
      handle(Promise.resolve({ result: 'done' })),
    ),
  };
}

function handle(completion: Promise<{ readonly result: string }>): SubagentHandle {
  return {
    agentId: 'agent-1',
    profileName: 'reviewer',
    resumed: false,
    completion,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function markPatchRead(review: ReviewAgentFacade): void {
  for (const file of review.getChangedFiles()) {
    review.recordPatchRead({ path: file.path, ranges: [{ start: 1, end: 10 }] });
  }
}

async function withModifiedRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'kimi-review-standard-'));
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
