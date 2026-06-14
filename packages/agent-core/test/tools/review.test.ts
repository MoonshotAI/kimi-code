import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SessionReviewRuntime, type ReviewAgentFacade } from '../../src/review';
import { AddCommentInputSchema, AddCommentTool } from '../../src/tools/builtin/review/add-comment';
import { DismissCommentTool } from '../../src/tools/builtin/review/dismiss-comment';
import { GetAssignmentTool } from '../../src/tools/builtin/review/get-assignment';
import { GetChangedFilesTool } from '../../src/tools/builtin/review/get-changed-files';
import { GetCommentEvidenceTool } from '../../src/tools/builtin/review/get-comment-evidence';
import { GetCommentsTool } from '../../src/tools/builtin/review/get-comments';
import { MergeCommentsTool } from '../../src/tools/builtin/review/merge-comments';
import { ReadDiffTool } from '../../src/tools/builtin/review/read-diff';
import { ReadFileVersionTool } from '../../src/tools/builtin/review/read-file-version';
import { UpdateProgressTool } from '../../src/tools/builtin/review/update-progress';
import type { ToolExecution } from '../../src/loop';
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

  it('exposes readable display metadata for review tool calls', () => {
    const review = createReviewer({
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const kaos = createFakeKaos();

    expect(displayOf(new GetAssignmentTool(review).resolveExecution())).toEqual({
      kind: 'generic',
      summary: 'review assignment',
    });
    expect(displayOf(new GetChangedFilesTool(review).resolveExecution({
      include: 'all',
      statuses: ['modified', 'added'],
    }))).toEqual({
      kind: 'generic',
      summary: 'changed files',
      detail: 'all files · statuses: modified, added',
    });
    expect(displayOf(new ReadDiffTool(kaos, review).resolveExecution({
      paths: ['src/a.ts'],
      section_id: 'section-2',
      context_lines: 5,
    }))).toEqual({
      kind: 'generic',
      summary: 'changed section',
      detail: 'src/a.ts · section 2 · 5 nearby lines',
    });
    expect(displayOf(new ReadFileVersionTool(kaos, review).resolveExecution({
      path: 'src/a.ts',
      version: 'base',
      line_offset: 10,
      n_lines: 3,
    }))).toEqual({
      kind: 'generic',
      summary: 'file version: src/a.ts',
      detail: 'base · lines 10-12',
    });
    expect(displayOf(new ReadFileVersionTool(kaos, review).resolveExecution({
      path: 'src/a.ts',
      ref: '3980a555807687914079243f9476fef93cbfd081',
      line_offset: 1,
    }))).toEqual({
      kind: 'generic',
      summary: 'file version: src/a.ts',
      detail: 'ref 3980a55 · from line 1',
    });
    expect(displayOf(new ReadFileVersionTool(kaos, review).resolveExecution({
      path: 'src/a.ts',
      ref: 'origin/main',
      line_offset: 1,
    }))).toEqual({
      kind: 'generic',
      summary: 'file version: src/a.ts',
      detail: 'ref origin/main · from line 1',
    });
    expect(displayOf(new UpdateProgressTool(review).resolveExecution({
      status: 'blocked',
      blocker: 'needs generated sources',
    }))).toEqual({
      kind: 'generic',
      summary: 'review progress update: blocked',
      detail: 'blocker: needs generated sources',
    });
    expect(displayOf(new AddCommentTool(review).resolveExecution({
      severity: 'important',
      path: 'src/a.ts',
      line: 7,
      title: 'Missing auth',
      body: 'The endpoint has no authorization check.',
    }))).toEqual({
      kind: 'generic',
      summary: 'review comment: src/a.ts:7',
      detail: 'important · Missing auth',
    });
    expect(displayOf(new GetCommentsTool(review).resolveExecution({
      status: 'merged',
      scope: 'assigned',
      paths: ['src/a.ts'],
      include_sources: true,
    }))).toEqual({
      kind: 'generic',
      summary: 'review comments',
      detail: 'merged · assigned scope · src/a.ts · include sources',
    });
    expect(displayOf(new GetCommentEvidenceTool(review).resolveExecution({
      comment_id: 'comment-1',
    }))).toEqual({
      kind: 'generic',
      summary: 'comment evidence: comment-1',
    });
    expect(displayOf(new MergeCommentsTool(review).resolveExecution({
      source_comment_ids: ['comment-1', 'comment-2'],
      severity: 'critical',
      path: 'src/a.ts',
      line: 7,
      title: 'Missing auth',
      body: 'Add an authorization check.',
    }))).toEqual({
      kind: 'generic',
      summary: 'comment merge: src/a.ts:7',
      detail: '2 source comments · critical · Missing auth',
    });
    expect(displayOf(new DismissCommentTool(review).resolveExecution({
      comment_id: 'comment-3',
      reason: 'duplicate',
      summary: 'Covered by the merged auth comment.',
      merged_comment_id: 'merged-1',
    }))).toEqual({
      kind: 'generic',
      summary: 'comment dismissal: comment-3',
      detail: 'duplicate · Covered by the merged auth comment. · merged into merged-1',
    });
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

  it('reads an untracked diff and records diff coverage', async () => {
    const review = createReviewer({
      assignedFiles: ['src/new.ts'],
      requiredCoverage: 'patch',
      files: [{ path: 'src/new.ts', status: 'untracked', additions: 2, deletions: 0 }],
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      readText: vi.fn().mockResolvedValue('first\nsecond\n'),
    });

    const diffResult = await executeTool(new ReadDiffTool(kaos, review), context({
      paths: ['src/new.ts'],
    }));
    expect(diffResult.isError).toBeFalsy();
    const diffOutput = text(diffResult);
    expect(diffOutput).toContain('Review diff for 1 file');
    expect(diffOutput).toContain('--- file: src/new.ts');
    expect(diffOutput).toContain('section: section-1');
    expect(diffOutput).toContain('+second');

    const commentResult = await executeTool(new AddCommentTool(review), context({
      severity: 'important',
      path: 'src/new.ts',
      line: 2,
      title: 'Check new path',
      body: 'Line 2 was covered by ReadDiff.',
    }));
    expect(commentResult.isError).toBeFalsy();
    expect(json(commentResult)).toMatchObject({ path: 'src/new.ts', line: 2 });
  });

  it('requires all diff sections before section-filtered ReadDiff satisfies diff coverage', async () => {
    const review = createReviewer({
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      exec: vi.fn(async () => processWithOutput(twoHunkPatch())),
    });

    const firstSection = await executeTool(new ReadDiffTool(kaos, review), context({
      paths: ['src/a.ts'],
      section_id: 'section-1',
    }));
    expect(firstSection.isError).toBeFalsy();

    const incomplete = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'only one section read',
    }));
    expect(incomplete.isError).toBe(true);
    expect(json(incomplete).error).toContain('src/a.ts (patch)');

    const secondSection = await executeTool(new ReadDiffTool(kaos, review), context({
      paths: ['src/a.ts'],
      section_id: 'section-2',
    }));
    expect(secondSection.isError).toBeFalsy();

    const complete = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'all sections read',
    }));
    expect(complete.isError).toBeFalsy();
    expect(json(complete)).toMatchObject({ status: 'complete' });
  });

  it('paginates multi-file ReadDiff output while preserving coverage across pages', async () => {
    const review = createReviewer({
      assignedFiles: ['src/a.ts', 'src/b.ts'],
      requiredCoverage: 'patch',
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
        { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 },
      ],
    });
    const exec = vi.fn(async (...args: string[]) => {
      const path = args.at(-1);
      return processWithOutput(path === 'src/a.ts' ? oneHunkPatch('src/a.ts', 'a') : oneHunkPatch('src/b.ts', 'b'));
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      exec,
    });

    const firstPage = await executeTool(new ReadDiffTool(kaos, review), context({
      max_bytes: 1_000,
    }));
    expect(firstPage.isError).toBeFalsy();
    const firstOutput = text(firstPage);
    expect(firstOutput).toContain('--- file: src/a.ts');
    expect(firstOutput).toContain('[next_cursor: ');
    const cursor = /\[next_cursor: ([^\]]+)\]/.exec(firstOutput)?.[1];
    expect(cursor).toBeDefined();

    const incomplete = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'only first page read',
    }));
    expect(incomplete.isError).toBe(true);

    const secondPage = await executeTool(new ReadDiffTool(kaos, review), context({
      cursor,
      max_bytes: 1_000,
    }));
    expect(secondPage.isError).toBeFalsy();
    expect(text(secondPage)).toContain('--- file: src/b.ts');

    const complete = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'all pages read',
    }));
    expect(complete.isError).toBeFalsy();
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

  it('does not count base file reads as full-file coverage for modified files', async () => {
    const review = createReviewer({
      assignedFiles: ['src/full.ts'],
      requiredCoverage: 'full_file',
      files: [{ path: 'src/full.ts', status: 'modified', additions: 1, deletions: 0 }],
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      readText: vi.fn().mockResolvedValue('base\nchanged\n'),
      exec: vi.fn().mockResolvedValue(processWithOutput('base\nold\n')),
    });

    const baseRead = await executeTool(new ReadFileVersionTool(kaos, review), context({
      path: 'src/full.ts',
      version: 'base',
      n_lines: 2,
    }));
    expect(baseRead.isError).toBeFalsy();

    const incompleteProgress = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'base file read',
    }));
    expect(incompleteProgress.isError).toBe(true);
    expect(json(incompleteProgress).error).toContain('src/full.ts (full_file)');

    const currentRead = await executeTool(new ReadFileVersionTool(kaos, review), context({
      path: 'src/full.ts',
      version: 'current',
      n_lines: 2,
    }));
    expect(currentRead.isError).toBeFalsy();

    const progress = await executeTool(new UpdateProgressTool(review), context({
      status: 'complete',
      summary: 'changed file read',
    }));
    expect(progress.isError).toBeFalsy();
    expect(json(progress)).toMatchObject({ status: 'complete' });
  });

  it('reads current-branch base file versions from the merge base', async () => {
    const runtime = createRuntime();
    runtime.startReview(
      {
        target: {
          scope: 'current_branch',
          baseRef: 'base-tip',
          headRef: 'head-tip',
        },
        intensity: 'standard',
      },
      statsFor([{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }]),
    );
    const review = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reviewer',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );
    const exec = vi.fn(async (...args: string[]) => {
      const gitArgs = args.slice(3);
      if (gitArgs[0] === 'merge-base') return processWithOutput('merge-base-sha\n');
      if (gitArgs[0] === 'show') return processWithOutput('base at merge\n');
      throw new Error(`unexpected git command: ${gitArgs.join(' ')}`);
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      exec,
    });

    const readResult = await executeTool(new ReadFileVersionTool(kaos, review), context({
      path: 'src/a.ts',
      version: 'base',
    }));

    expect(readResult.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledWith(
      'git',
      '-C',
      '/workspace',
      'merge-base',
      '--end-of-options',
      'base-tip',
      'head-tip',
    );
    expect(exec).toHaveBeenCalledWith(
      'git',
      '-C',
      '/workspace',
      'show',
      '--end-of-options',
      'merge-base-sha:src/a.ts',
    );
  });

  it('separates explicit file-version refs from git options', async () => {
    const review = createReviewer({
      assignedFiles: ['src/full.ts'],
      requiredCoverage: 'patch',
    });
    const exec = vi.fn(async (...args: string[]) => {
      const gitArgs = args.slice(3);
      if (gitArgs[0] === 'show') return processWithOutput('safe ref content\n');
      throw new Error(`unexpected git command: ${gitArgs.join(' ')}`);
    });
    const kaos = createFakeKaos({
      getcwd: () => '/workspace',
      exec,
    });

    const readResult = await executeTool(new ReadFileVersionTool(kaos, review), context({
      path: 'src/full.ts',
      ref: '--upload-pack=malicious',
    }));

    expect(readResult.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledWith(
      'git',
      '-C',
      '/workspace',
      'show',
      '--end-of-options',
      '--upload-pack=malicious:src/full.ts',
    );
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

  it('filters dismissed comments by assigned scope', async () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'thorough' },
      statsFor([
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
        { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0 },
      ]),
    );
    const reviewer = reviewerFacade(runtime, ['src/a.ts', 'src/b.ts']);
    reviewer.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 1, end: 3 }] });
    reviewer.recordPatchRead({ path: 'src/b.ts', ranges: [{ start: 1, end: 3 }] });
    const assigned = reviewer.addComment({
      severity: 'important',
      path: 'src/a.ts',
      line: 1,
      title: 'Assigned path',
      body: 'This comment belongs to the reconciliator path.',
    });
    const unassigned = reviewer.addComment({
      severity: 'minor',
      path: 'src/b.ts',
      line: 1,
      title: 'Unassigned path',
      body: 'This comment is outside the reconciliator path.',
    });
    const reconciliator = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reconciliator',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
        sourceCommentIds: [assigned.id, unassigned.id],
      }).id,
    );
    reconciliator.dismissComment({
      commentId: unassigned.id,
      reason: 'out_of_scope',
      summary: 'Outside this reconciliation batch.',
    });

    const commentsResult = await executeTool(new GetCommentsTool(reconciliator), context({
      status: 'dismissed',
      scope: 'assigned',
    }));

    expect(json(commentsResult)).toMatchObject({
      dismissed_comments: [],
    });
  });
});

function context<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_review', args, signal };
}

function json(result: { readonly output: unknown }): any {
  return JSON.parse(text(result));
}

function text(result: { readonly output: unknown }): string {
  if (typeof result.output !== 'string') throw new Error('expected string output');
  return result.output;
}

function displayOf(execution: ToolExecution) {
  if (!('execute' in execution)) throw new Error('expected runnable tool execution');
  return execution.display;
}

function processWithOutput(stdout: string) {
  return {
    stdin: new PassThrough(),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([]),
    pid: 1,
    exitCode: null,
    wait: vi.fn(async () => 0),
    kill: vi.fn(async () => {}),
  };
}

function twoHunkPatch(): string {
  return [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' context',
    '@@ -10,2 +10,2 @@',
    '-old again',
    '+new again',
    ' context again',
    '',
  ].join('\n');
}

function oneHunkPatch(path: string, marker: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    `-${marker.repeat(1_200)}`,
    `+${marker.repeat(1_200)} changed`,
    '',
  ].join('\n');
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
