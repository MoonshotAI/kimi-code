import { describe, expect, it, vi } from 'vitest';

import { SessionReviewRuntime, type ReviewAgentFacade } from '../../src/review';
import { AddCommentInputSchema, AddCommentTool } from '../../src/tools/builtin/review/add-comment';
import { DismissCommentTool } from '../../src/tools/builtin/review/dismiss-comment';
import { GetCommentsTool } from '../../src/tools/builtin/review/get-comments';
import { MergeCommentsTool } from '../../src/tools/builtin/review/merge-comments';
import { ReadFileVersionTool } from '../../src/tools/builtin/review/read-file-version';
import { ReadPatchTool } from '../../src/tools/builtin/review/read-patch';
import { UpdateProgressTool } from '../../src/tools/builtin/review/update-progress';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { testAgent } from '../agent/harness/agent';

const signal = new AbortController().signal;

describe('review tools', () => {
  it('exposes schemas and stays hidden without a review facade', () => {
    expect(
      AddCommentInputSchema.safeParse({
        severity: 'important',
        path: 'src/a.ts',
        line: 3,
        title: 'Problem',
        body: 'Explain the problem.',
      }).success,
    ).toBe(true);

    const ctx = testAgent();
    ctx.configure();

    expect(ctx.agent.tools.data().map((tool) => tool.name)).not.toContain('GetAssignment');
  });

  it('rejects comments for lines the reviewer has not read', async () => {
    const review = createReviewer({
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const result = await executeTool(new AddCommentTool(review), context({
      severity: 'important',
      path: 'src/a.ts',
      line: 3,
      title: 'Unread',
      body: 'This should be rejected.',
    }));

    expect(result).toMatchObject({ isError: true });
    expect(json(result).error).toContain('must cite a line that the worker read');
  });

  it('reads an untracked patch and records patch coverage', async () => {
    const review = createReviewer({
      assignedFiles: ['src/new.ts'],
      requiredCoverage: 'patch',
      files: [{ path: 'src/new.ts', status: 'untracked', additions: 2, deletions: 0 }],
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      readText: vi.fn().mockResolvedValue('first\nsecond\n'),
    });

    const patchResult = await executeTool(new ReadPatchTool(kaos, review), context({
      path: 'src/new.ts',
    }));
    expect(patchResult.isError).toBeFalsy();
    expect(json(patchResult)).toMatchObject({
      path: 'src/new.ts',
      hunks: [{ id: 'hunk-1', new_start: 1, new_count: 2 }],
    });

    const commentResult = await executeTool(new AddCommentTool(review), context({
      severity: 'important',
      path: 'src/new.ts',
      line: 2,
      title: 'Check new path',
      body: 'Line 2 was covered by ReadPatch.',
    }));
    expect(commentResult.isError).toBeFalsy();
    expect(json(commentResult)).toMatchObject({ path: 'src/new.ts', line: 2 });
  });

  it('reads file versions and allows full-file completion after coverage is complete', async () => {
    const review = createReviewer({
      assignedFiles: ['src/full.ts'],
      requiredCoverage: 'full_file',
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      readText: vi.fn().mockResolvedValue('one\ntwo\nthree\n'),
    });

    const readResult = await executeTool(new ReadFileVersionTool(kaos, review), context({
      path: 'src/full.ts',
      n_lines: 3,
    }));
    expect(readResult.isError).toBeFalsy();
    expect(json(readResult)).toMatchObject({
      path: 'src/full.ts',
      line_offset: 1,
      n_lines: 3,
      total_lines: 3,
    });

    const progress = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'full file read',
    }));
    expect(progress.isError).toBeFalsy();
    expect(json(progress)).toMatchObject({ status: 'complete' });
  });

  it('merges comments with provenance and dismisses duplicates', async () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'thorough' },
      statsFor([{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }]),
    );
    const first = reviewerFacade(runtime, ['src/a.ts']);
    const second = reviewerFacade(runtime, ['src/a.ts']);
    const reconciliator = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reconciliator',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );

    first.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 4, end: 6 }] });
    second.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 4, end: 6 }] });
    const firstComment = first.addComment({
      severity: 'critical',
      path: 'src/a.ts',
      line: 5,
      title: 'Missing auth',
      body: 'The endpoint lacks authorization.',
      evidence: 'line 5',
    });
    const secondComment = second.addComment({
      severity: 'important',
      path: 'src/a.ts',
      line: 5,
      title: 'No authorization',
      body: 'The same path appears open.',
    });

    const mergeResult = await executeTool(new MergeCommentsTool(reconciliator), context({
      source_comment_ids: [firstComment.id, secondComment.id],
      severity: 'critical',
      path: 'src/a.ts',
      line: 5,
      title: 'Missing auth',
      body: 'Add authorization before using this endpoint.',
    }));
    expect(mergeResult.isError).toBeFalsy();
    const merged = json(mergeResult);
    expect(merged.sourceCommentIds).toEqual([firstComment.id, secondComment.id]);

    const duplicate = first.addComment({
      severity: 'minor',
      path: 'src/a.ts',
      line: 6,
      title: 'Duplicate',
      body: 'This repeats the merged comment.',
    });
    const dismissResult = await executeTool(new DismissCommentTool(reconciliator), context({
      comment_id: duplicate.id,
      reason: 'duplicate',
      summary: 'Covered by merged auth comment.',
      merged_comment_id: merged.id,
    }));

    expect(dismissResult.isError).toBeFalsy();
    expect(json(dismissResult)).toMatchObject({
      commentId: duplicate.id,
      reason: 'duplicate',
      mergedCommentId: merged.id,
    });

    const commentsResult = await executeTool(new GetCommentsTool(reconciliator), context({
      include_sources: true,
    }));
    expect(json(commentsResult)).toMatchObject({
      merged_comments: [{ id: merged.id, sourceCommentIds: [firstComment.id, secondComment.id] }],
      dismissed_comments: [{ commentId: duplicate.id, reason: 'duplicate' }],
      source_comments: [
        expect.objectContaining({ id: firstComment.id }),
        expect.objectContaining({ id: secondComment.id }),
      ],
    });
  });
});

function context<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_review', args, signal };
}

function json(result: { readonly output: unknown }): any {
  if (typeof result.output !== 'string') throw new Error('expected string output');
  return JSON.parse(result.output);
}

function createReviewer(input: {
  readonly assignedFiles: readonly string[];
  readonly requiredCoverage: 'patch' | 'full_file';
  readonly files?: readonly {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    readonly additions: number;
    readonly deletions: number;
  }[];
}): ReviewAgentFacade {
  const runtime = createRuntime();
  runtime.startReview(
    { target: { scope: 'working_tree' }, intensity: 'standard' },
    statsFor(input.files ?? input.assignedFiles.map((path) => ({
      path,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }))),
  );
  return runtime.createAgentFacade(
    runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: input.assignedFiles,
      requiredCoverage: input.requiredCoverage,
    }).id,
  );
}

function reviewerFacade(runtime: SessionReviewRuntime, assignedFiles: readonly string[]) {
  return runtime.createAgentFacade(
    runtime.createAssignment({
      role: 'reviewer',
      assignedFiles,
      requiredCoverage: 'patch',
    }).id,
  );
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

function statsFor(
  files: readonly {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
    readonly additions: number;
    readonly deletions: number;
  }[],
) {
  return {
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
  };
}
