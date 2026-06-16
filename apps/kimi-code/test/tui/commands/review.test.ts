import type {
  ReviewBaseRef,
  ReviewCommit,
  ReviewIntensity,
  ReviewResult,
  ReviewScopeSummary,
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
    summary: 'Review completed with 1 review comment.',
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

const defaultScopeSummary = {
  workingTree: {
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
  },
  head: {
    sha: '3980a555807687914079243f9476fef93cbfd081',
    shortSha: '3980a55',
    subject: 'feat: run deep review through AgentSwarm',
  },
  upstream: null,
} satisfies ReviewScopeSummary;

function makeHost(input: {
  readonly refs?: readonly ReviewBaseRef[];
  readonly commits?: readonly ReviewCommit[];
  readonly scopeSummary?: ReviewScopeSummary | Error;
} = {}) {
  const workingTreePreview = preview({ scope: 'working_tree' });
  const session = {
    getReviewScopeSummary: vi.fn(async () => {
      if (input.scopeSummary instanceof Error) throw input.scopeSummary;
      return input.scopeSummary ?? defaultScopeSummary;
    }),
    listReviewBaseRefs: vi.fn(async () => input.refs ?? [{ name: 'main', kind: 'branch' }]),
    listReviewCommits: vi.fn(async () => input.commits ?? [{ sha: 'abc123', title: 'change' }]),
    previewReviewTarget: vi.fn(async (target) => preview(target)),
    runPilotedReview: vi.fn(async (reviewInput) => result(reviewInput.target, reviewInput.intensity)),
  };
  const spinnerStop = vi.fn();
  const transientStatusClear = vi.fn();
  const mountEditorReplacement = vi.fn();
  const restoreEditor = vi.fn(() => {
    const panel = mountEditorReplacement.mock.calls.at(-1)?.[0] as { dispose?: () => void } | undefined;
    panel?.dispose?.();
  });
  const host = {
    state: {
      appState: {
        model: 'kimi-model',
      },
      reviewActive: false,
      reviewResultPending: false,
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
    setReviewActive: vi.fn((active: boolean) => {
      host.state.reviewActive = active;
    }),
    mountEditorReplacement,
    restoreEditor,
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
    const { host, session, workingTreePreview } = makeHost();
    const task = handleReviewCommand(host, 'focus on security');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(session.previewReviewTarget).toHaveBeenCalledWith({ scope: 'working_tree' });
    expect(session.runPilotedReview).toHaveBeenCalledWith({
      target: workingTreePreview.target,
      intensity: 'standard',
      focus: 'focus on security',
    });
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'review-summary',
        reviewSummaryData: expect.objectContaining({
          comments: expect.arrayContaining([
            expect.objectContaining({ title: expect.stringContaining('Missing validation') }),
          ]),
        }),
      }),
    );
  });

  it('marks the command review result as pending while the review is running', async () => {
    const { host, session } = makeHost();
    let pendingDuringStart: boolean | undefined;
    session.runPilotedReview.mockImplementationOnce(async (reviewInput) => {
      pendingDuringStart = host.state.reviewResultPending;
      return result(reviewInput.target, reviewInput.intensity);
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(pendingDuringStart).toBe(true);
    expect(host.state.reviewResultPending).toBe(false);
    expect(host.appendTranscriptEntry).toHaveBeenCalledTimes(1);
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
    expect(session.runPilotedReview).not.toHaveBeenCalled();
  });

  it('does not show a duplicate command error after a review failure event', async () => {
    const { host, session } = makeHost();
    session.runPilotedReview.mockImplementationOnce(async () => {
      host.state.reviewActive = false;
      throw new Error('Rate limited');
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('uses relaxed spacing for the primary review selectors', async () => {
    const { host } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    const scopeLines = strippedPickerLines(host, 0);
    const workingTreeDescription = scopeLines.indexOf('    No uncommitted changes detected.');
    expect(scopeLines[workingTreeDescription + 1]).toBe('');
    expect(scopeLines[workingTreeDescription + 2]).toBe('    Current branch');

    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    const intensityLines = strippedPickerLines(host, 1);
    const standardDescription = intensityLines.indexOf('    Single reviewer for everyday changes.');
    expect(intensityLines[standardDescription + 1]).toBe('');
    expect(intensityLines[standardDescription + 2]).toBe('    Thorough');
    expect(intensityLines).toContain('    Deep Review');
    expect(intensityLines).toContain('    Uses AgentSwarm for risky or large changes.');

    mountedPicker(host, 1).handleInput(ESC);
    await task;
  });

  it('marks only Deep Review with the wave label animation', async () => {
    const { host } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    const options = ((mountedPicker(host, 1) as any).opts.options ?? []) as Array<{
      value: string;
      labelAnimation?: string;
    }>;

    expect(options.find((option) => option.value === 'deep')?.labelAnimation).toBe('wave');
    expect(options.filter((option) => option.value !== 'deep').map((option) => option.labelAnimation)).toEqual([
      undefined,
      undefined,
    ]);

    mountedPicker(host, 1).handleInput(ESC);
    await task;
  });

  it('keeps animated selector render requests bound to the TUI object', async () => {
    vi.useFakeTimers();
    try {
      const scheduleRender = vi.fn();
      const { host } = makeHost();
      const uiWithReceiverSensitiveRender = {
        scheduleRender,
        requestRender(this: { scheduleRender: () => void }) {
          this.scheduleRender();
        },
      };
      (host.state as { ui: unknown }).ui = uiWithReceiverSensitiveRender;
      const task = handleReviewCommand(host, '');

      await waitForPicker(host, 1);
      mountedPicker(host, 0).handleInput(ENTER);
      await waitForPicker(host, 2);

      expect(() => vi.advanceTimersByTime(120)).not.toThrow();
      expect(scheduleRender).toHaveBeenCalled();

      mountedPicker(host, 1).handleInput(ESC);
      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows review scope metadata in the first selector', async () => {
    const { host } = makeHost({
      scopeSummary: {
        workingTree: {
          stagedCount: 1,
          unstagedCount: 2,
          untrackedCount: 3,
          conflictedCount: 0,
        },
        head: {
          sha: '3980a555807687914079243f9476fef93cbfd081',
          shortSha: '3980a55',
          subject: 'feat: run deep review through AgentSwarm',
        },
        upstream: {
          upstreamRef: 'origin/main',
          upstreamCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headCommit: '3980a555807687914079243f9476fef93cbfd081',
          aheadCount: 5,
          behindCount: 0,
        },
      },
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    const lines = strippedPickerLines(host, 0).join('\n');
    mountedPicker(host, 0).handleInput(ESC);
    await task;

    expect(lines).toContain('1 staged · 2 unstaged · 3 untracked');
    expect(lines).toContain('HEAD 3980a55 · feat: run deep review through AgentSwarm');
    expect(lines).toContain('Ahead of upstream');
    expect(lines).toContain('origin/main · 5 commits ahead');
  });

  it('falls back to static scope descriptions when scope metadata fails', async () => {
    const { host } = makeHost({ scopeSummary: new Error('git failed') });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    const lines = strippedPickerLines(host, 0).join('\n');
    mountedPicker(host, 0).handleInput(ESC);
    await task;

    expect(lines).toContain('Review uncommitted tracked and untracked changes.');
    expect(lines).toContain('Review the current HEAD against a selected branch, tag, or commit.');
    expect(lines).not.toContain('Ahead of upstream');
  });

  it('omits the upstream shortcut when the branch has no ahead commits', async () => {
    const { host } = makeHost({
      scopeSummary: {
        ...defaultScopeSummary,
        upstream: {
          upstreamRef: 'origin/main',
          upstreamCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headCommit: '3980a555807687914079243f9476fef93cbfd081',
          aheadCount: 0,
          behindCount: 0,
        },
      },
    });
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    const lines = strippedPickerLines(host, 0).join('\n');
    mountedPicker(host, 0).handleInput(ESC);
    await task;

    expect(lines).not.toContain('Ahead of upstream');
    expect(lines).not.toContain('0 commits ahead');
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
    expect(session.runPilotedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'current_branch', baseRef: 'main' }),
        intensity: 'standard',
      }),
    );
  });

  it('selects the upstream-ahead review target without a base selector', async () => {
    const { host, session } = makeHost({
      scopeSummary: {
        ...defaultScopeSummary,
        upstream: {
          upstreamRef: 'origin/main',
          upstreamCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headCommit: '3980a555807687914079243f9476fef93cbfd081',
          aheadCount: 2,
          behindCount: 0,
        },
      },
    });
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
      baseRef: 'origin/main',
    });
    expect(session.runPilotedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'current_branch', baseRef: 'origin/main' }),
        intensity: 'standard',
      }),
    );
  });

  it('starts a Thorough review straight after the intensity selection', async () => {
    const { host, session, workingTreePreview } = makeHost();
    const task = handleReviewCommand(host, '');

    await waitForPicker(host, 1);
    mountedPicker(host, 0).handleInput(ENTER);
    await waitForPicker(host, 2);
    mountedPicker(host, 1).handleInput(DOWN);
    mountedPicker(host, 1).handleInput(ENTER);
    await task;

    expect(host.showNotice).not.toHaveBeenCalled();
    expect(session.runPilotedReview).toHaveBeenCalledWith({
      target: workingTreePreview.target,
      intensity: 'thorough',
      focus: undefined,
    });
  });

  it('selects a single commit and starts a Deep Review without the duplicate command spinner', async () => {
    const { host, session, spinnerStop } = makeHost({
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
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(session.runPilotedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'single_commit', commit: 'abc123def456' }),
        intensity: 'deep',
      }),
    );
    expect(host.showProgressSpinner).not.toHaveBeenCalled();
    expect(spinnerStop).not.toHaveBeenCalled();
  });
});
