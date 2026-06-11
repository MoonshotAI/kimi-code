import type {
  ReviewBaseRef,
  ReviewCommit,
  ReviewIntensity,
  ReviewResult,
  ReviewTargetPreview,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { handleReviewCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const DOWN = '\u001B[B';

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function preview(target: ReviewTargetPreview['target']): ReviewTargetPreview {
  return {
    target,
    stats: {
      fileCount: 1,
      additions: 2,
      deletions: 1,
      files: [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
    },
  };
}

function result(
  target: ReviewResult['target'],
  intensity: ReviewIntensity = 'standard',
): ReviewResult {
  return {
    target,
    intensity,
    status: 'complete',
    stats: preview(target).stats,
    summary: 'Review completed with 1 finding.',
    comments: [
      {
        id: 'review-comment-1',
        sourceCommentIds: ['review-comment-1'],
        severity: 'important',
        path: 'src/a.ts',
        line: 2,
        title: 'Missing validation',
        body: 'The changed code does not validate input.',
      },
    ],
  };
}

function makeHost(input: {
  readonly refs?: readonly ReviewBaseRef[];
  readonly commits?: readonly ReviewCommit[];
} = {}) {
  const workingTreePreview = preview({ scope: 'working_tree' });
  const session = {
    listReviewBaseRefs: vi.fn(async () => input.refs ?? [{ name: 'main', kind: 'branch' }]),
    listReviewCommits: vi.fn(async () => input.commits ?? [{ sha: 'abc123', title: 'change' }]),
    previewReviewTarget: vi.fn(async (target) => preview(target)),
    startReview: vi.fn(async (reviewInput) => result(reviewInput.target, reviewInput.intensity)),
  };
  const spinnerStop = vi.fn();
  const host = {
    state: {
      appState: {
        model: 'kimi-model',
      },
      theme: currentTheme,
      ui: { requestRender: vi.fn() },
    },
    session,
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showProgressSpinner: vi.fn(() => ({ stop: spinnerStop })),
  } as unknown as SlashCommandHost;
  return { host, session, spinnerStop, workingTreePreview };
}

function mountedPicker(host: SlashCommandHost, index: number): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[index]?.[0] as TestPicker;
}

async function waitForPicker(host: SlashCommandHost, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(count);
  });
}

describe('handleReviewCommand', () => {
  it('starts a Standard working-tree review with focus text', async () => {
    const { host, session, spinnerStop, workingTreePreview } = makeHost();
    const task = handleReviewCommand(host, 'focus on security');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(session.previewReviewTarget).toHaveBeenCalledWith({ scope: 'working_tree' });
    expect(session.startReview).toHaveBeenCalledWith({
      target: workingTreePreview.target,
      intensity: 'standard',
      focus: 'focus on security',
    });
    expect(spinnerStop).toHaveBeenCalledWith({ ok: true, label: 'Review completed.' });
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'assistant',
        renderMode: 'markdown',
        content: expect.stringContaining('Missing validation'),
      }),
    );
  });

  it('selects a base ref for current-branch review', async () => {
    const { host, session } = makeHost({
      refs: [{ name: 'main', kind: 'branch', description: 'base branch' }],
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await waitForPicker(host, 3);
    mountedPicker(host, 2).handleInput(ENTER);
    await task;

    expect(session.listReviewBaseRefs).toHaveBeenCalled();
    expect(session.previewReviewTarget).toHaveBeenCalledWith({
      scope: 'current_branch',
      baseRef: 'main',
    });
    expect(session.startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'current_branch', baseRef: 'main' }),
        intensity: 'standard',
      }),
    );
  });

  it('starts a Thorough review after showing the focused reviewers', async () => {
    const { host, session, workingTreePreview } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(DOWN);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(host.showNotice).toHaveBeenCalledWith(
      'Thorough review',
      expect.stringContaining('Correctness and regressions'),
    );
    expect(session.startReview).toHaveBeenCalledWith({
      target: workingTreePreview.target,
      intensity: 'thorough',
      focus: undefined,
    });
  });

  it('selects a single commit and starts a Deep review', async () => {
    const { host, session } = makeHost({
      commits: [{ sha: 'abc123def456', title: 'change commit' }],
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await waitForPicker(host, 3);
    mountedPicker(host, 2).handleInput(DOWN);
    mountedPicker(host, 2).handleInput(DOWN);
    mountedPicker(host, 2).handleInput(ENTER);
    await task;

    expect(session.listReviewCommits).toHaveBeenCalled();
    expect(session.previewReviewTarget).toHaveBeenCalledWith({
      scope: 'single_commit',
      commit: 'abc123def456',
    });
    expect(host.showNotice).toHaveBeenCalledWith(
      'Deep review',
      expect.stringContaining('overlapping focused reviewers'),
    );
    expect(session.startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'single_commit', commit: 'abc123def456' }),
        intensity: 'deep',
      }),
    );
  });
});
