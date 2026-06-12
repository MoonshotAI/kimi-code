import { describe, expect, it, vi } from 'vitest';

import {
  ReviewWorkerDriver,
  SessionReviewRuntime,
  type ReviewWorkerLauncher,
} from '../../src/review';
import type { RunSubagentOptions, SpawnSubagentOptions, SubagentHandle } from '../../src/session/subagent-host';

describe('ReviewWorkerDriver', () => {
  it('continues a worker with missing coverage until it completes', async () => {
    const runtime = createRuntime();
    const assignment = runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const launcher = createLauncher({
      onResume: () => {
        runtime.coverage.recordPatchRead(assignment.id, {
          path: 'src/a.ts',
          ranges: [{ start: 1, end: 2 }],
        });
        runtime.updateProgress(assignment.id, { status: 'complete', summary: 'done' });
      },
    });

    const result = await new ReviewWorkerDriver({
      runtime,
      launcher,
      assignment,
      profileName: 'reviewer',
      prompt: 'review this',
      description: 'Review changes',
      parentToolCallId: 'review',
      signal: new AbortController().signal,
    }).run();

    expect(result).toMatchObject({ agentId: 'agent-1', status: 'complete', summary: 'done' });
    expect(launcher.spawn).toHaveBeenCalledWith(expect.objectContaining({
      profileName: 'reviewer',
      review: expect.objectContaining({ assignmentId: assignment.id }),
    }));
    expect(launcher.resume).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        prompt: expect.stringContaining('Missing required coverage: src/a.ts (patch).'),
      }),
    );
  });

  it('fails after bounded non-progress continuations', async () => {
    const runtime = createRuntime();
    const assignment = runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const launcher = createLauncher({});

    await expect(
      new ReviewWorkerDriver({
        runtime,
        launcher,
        assignment,
        profileName: 'reviewer',
        prompt: 'review this',
        description: 'Review changes',
        parentToolCallId: 'review',
        signal: new AbortController().signal,
        maxNonProgressContinuations: 1,
      }).run(),
    ).rejects.toThrow('made no progress');
  });

  it('does not count sibling assignment comments as worker progress', async () => {
    const runtime = createRuntime();
    const stuckAssignment = runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const sibling = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reviewer',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );
    sibling.recordPatchRead({
      path: 'src/a.ts',
      ranges: [{ start: 1, end: 2 }],
    });
    let resumes = 0;
    const launcher = createLauncher({
      onResume: () => {
        resumes += 1;
        if (resumes === 1) {
          sibling.addComment({
            severity: 'minor',
            path: 'src/a.ts',
            line: 1,
            title: 'Sibling finding',
            body: 'This belongs to another review assignment.',
          });
          return;
        }
        runtime.coverage.recordPatchRead(stuckAssignment.id, {
          path: 'src/a.ts',
          ranges: [{ start: 1, end: 2 }],
        });
        runtime.updateProgress(stuckAssignment.id, { status: 'complete', summary: 'done' });
      },
    });

    await expect(
      new ReviewWorkerDriver({
        runtime,
        launcher,
        assignment: stuckAssignment,
        profileName: 'reviewer',
        prompt: 'review this',
        description: 'Review changes',
        parentToolCallId: 'review',
        signal: new AbortController().signal,
        maxNonProgressContinuations: 1,
      }).run(),
    ).rejects.toThrow('made no progress');
    expect(launcher.resume).toHaveBeenCalledTimes(1);
  });
});

function createRuntime(): SessionReviewRuntime {
  const counters = new Map<string, number>();
  const runtime = new SessionReviewRuntime({
    idGenerator: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-${String(next)}`;
    },
  });
  runtime.startReview(
    { target: { scope: 'working_tree' }, intensity: 'standard' },
    {
      fileCount: 1,
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
    },
  );
  return runtime;
}

function createLauncher(input: {
  readonly onSpawn?: () => void;
  readonly onResume?: () => void;
}): ReviewWorkerLauncher & {
  readonly spawn: ReturnType<typeof vi.fn<ReviewWorkerLauncher['spawn']>>;
  readonly resume: ReturnType<typeof vi.fn<ReviewWorkerLauncher['resume']>>;
} {
  const launcher = {
    spawn: vi.fn(async (_options: SpawnSubagentOptions) => {
      input.onSpawn?.();
      return handle();
    }),
    resume: vi.fn(async (_agentId: string, _options: RunSubagentOptions) => {
      input.onResume?.();
      return handle();
    }),
  };
  return launcher;
}

function handle(): SubagentHandle {
  return {
    agentId: 'agent-1',
    profileName: 'reviewer',
    resumed: false,
    completion: Promise.resolve({ result: 'done' }),
  };
}
