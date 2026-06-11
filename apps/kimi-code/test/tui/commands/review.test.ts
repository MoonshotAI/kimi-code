import type {
  ReviewBaseRef,
  ReviewCommit,
  ReviewIntensity,
  ReviewPlanPreview,
  ReviewResult,
  ReviewTargetPreview,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { handleReviewCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const DOWN = '\u001B[B';
const ESC = '\u001B';
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

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

function plan(intensity: ReviewIntensity): ReviewPlanPreview {
  if (intensity === 'deep') {
    return {
      intensity,
      reviewerCount: 4,
      perspectives: [
        'Correctness and regressions',
        'Security and data safety',
        'Reliability and edge cases',
        'Maintainability and tests',
      ],
      fileGroups: [
        {
          label: 'Files 1-1',
          files: ['src/a.ts'],
          perspectives: [
            'Correctness and regressions',
            'Security and data safety',
            'Reliability and edge cases',
            'Maintainability and tests',
          ],
        },
      ],
      reconciliationGroups: [
        'Correctness and regressions',
        'Security and data safety',
        'Reliability and edge cases',
        'Maintainability and tests',
      ],
    };
  }
  return {
    intensity,
    reviewerCount: intensity === 'thorough' ? 3 : 1,
    perspectives: intensity === 'thorough'
      ? [
        'Correctness and regressions',
        'Security and data safety',
        'Maintainability and tests',
      ]
      : ['standard'],
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
    previewReviewPlan: vi.fn(async (reviewInput) => plan(reviewInput.intensity)),
    startReview: vi.fn(async (reviewInput) => result(reviewInput.target, reviewInput.intensity)),
  };
  const spinnerStop = vi.fn();
  const transientStatusClear = vi.fn();
  const host = {
    state: {
      appState: {
        model: 'kimi-model',
      },
      reviewActive: false,
      theme: currentTheme,
      ui: { requestRender: vi.fn() },
    },
    session,
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    showTransientStatus: vi.fn(() => ({ clear: transientStatusClear })),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showProgressSpinner: vi.fn(() => ({ stop: spinnerStop })),
  } as unknown as SlashCommandHost;
  return { host, session, spinnerStop, transientStatusClear, workingTreePreview };
}

function mountedPicker(host: SlashCommandHost, index: number): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[index]?.[0] as TestPicker;
}

function strippedPickerLines(host: SlashCommandHost, index: number): string[] {
  return mountedPicker(host, index).render(120).map((line) => line.replaceAll(ANSI_SGR, ''));
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

  it('removes the preview status when intensity selection is cancelled', async () => {
    const { host, session, transientStatusClear } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ESC);
    await task;

    expect(host.showTransientStatus).toHaveBeenCalledWith('Reviewing 1 file: +2 -1.');
    expect(transientStatusClear).toHaveBeenCalledTimes(1);
    expect(session.startReview).not.toHaveBeenCalled();
  });

  it('does not show a duplicate command error after a review failure event', async () => {
    const { host, session, spinnerStop } = makeHost();
    session.startReview.mockImplementationOnce(async () => {
      host.state.reviewActive = false;
      throw new Error('Rate limited');
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(spinnerStop).toHaveBeenCalledWith({ ok: false, label: 'Review stopped.' });
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('uses relaxed spacing for the primary review selectors', async () => {
    const { host } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    const scopeLines = strippedPickerLines(host, 0);
    const workingTreeDescription = scopeLines.indexOf('    Review uncommitted tracked and untracked changes.');
    expect(scopeLines[workingTreeDescription + 1]).toBe('');
    expect(scopeLines[workingTreeDescription + 2]).toBe('    Current branch');

    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    const intensityLines = strippedPickerLines(host, 1);
    const standardDescription = intensityLines.indexOf('    Single reviewer for everyday changes.');
    expect(intensityLines[standardDescription + 1]).toBe('');
    expect(intensityLines[standardDescription + 2]).toBe('    Thorough');

    mountedPicker(host, 1).handleInput(ESC);
    await task;
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

  it('selects the upstream-ahead review target without a base selector', async () => {
    const { host, session } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);

    const secondPickerLines = strippedPickerLines(host, 1).join('\n');
    if (!secondPickerLines.includes('Review intensity')) {
      mountedPicker(host, 1).handleInput(ESC);
      await task;
    } else {
      mountedPicker(host, 1).handleInput(ENTER);
      await task;
    }

    expect(session.listReviewBaseRefs).not.toHaveBeenCalled();
    expect(session.listReviewCommits).not.toHaveBeenCalled();
    expect(session.previewReviewTarget).toHaveBeenCalledWith({
      scope: 'current_branch',
      baseRef: '@{upstream}',
    });
    expect(session.startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'current_branch', baseRef: '@{upstream}' }),
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
    await waitForPicker(host, 3);
    const confirmationLines = strippedPickerLines(host, 2);
    expect(confirmationLines.join('\n')).toContain('Correctness and regressions');
    expect(confirmationLines.join('\n')).toContain('3 reviewer agents');
    mountedPicker(host, 2).handleInput(ENTER);
    await task;

    expect(host.showNotice).not.toHaveBeenCalled();
    expect(session.previewReviewPlan).toHaveBeenCalledWith({
      target: workingTreePreview.target,
      intensity: 'thorough',
      focus: undefined,
    });
    expect(session.startReview).toHaveBeenCalledWith({
      target: workingTreePreview.target,
      intensity: 'thorough',
      focus: undefined,
    });
  });

  it('cancels at the perspective confirmation before starting review', async () => {
    const { host, session, transientStatusClear } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(DOWN);
    mountedPicker(host, 1).handleInput(ENTER);
    await waitForPicker(host, 3);
    mountedPicker(host, 2).handleInput(ESC);
    await task;

    expect(session.previewReviewPlan).toHaveBeenCalled();
    expect(session.startReview).not.toHaveBeenCalled();
    expect(transientStatusClear).toHaveBeenCalledTimes(1);
  });

  it('selects a single commit and starts a Deep review', async () => {
    const { host, session } = makeHost({
      commits: [{ sha: 'abc123def456', title: 'change commit' }],
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(DOWN);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await waitForPicker(host, 3);
    mountedPicker(host, 2).handleInput(DOWN);
    mountedPicker(host, 2).handleInput(DOWN);
    mountedPicker(host, 2).handleInput(ENTER);
    await waitForPicker(host, 4);
    const confirmationLines = strippedPickerLines(host, 3);
    expect(confirmationLines.join('\n')).toContain('Reliability and edge cases');
    expect(confirmationLines.join('\n')).toContain('4 reviewer agents');
    mountedPicker(host, 3).handleInput(ENTER);
    await task;

    expect(session.listReviewCommits).toHaveBeenCalled();
    expect(session.previewReviewTarget).toHaveBeenCalledWith({
      scope: 'single_commit',
      commit: 'abc123def456',
    });
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(session.previewReviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'single_commit', commit: 'abc123def456' }),
        intensity: 'deep',
      }),
    );
    expect(session.startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'single_commit', commit: 'abc123def456' }),
        intensity: 'deep',
      }),
    );
  });
});
