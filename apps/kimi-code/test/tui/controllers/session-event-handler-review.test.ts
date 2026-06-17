import { describe, expect, it, vi } from 'vitest';

import { ReviewSwarmProgressComponent } from '#/tui/components/messages/review-swarm-progress';
import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';
import type { TranscriptEntry } from '#/tui/types';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
      },
      reviewActive: false,
      reviewResultPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: {},
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
    },
    requireSession: vi.fn(() => ({})),
    setAppState: vi.fn(),
    setReviewActive: vi.fn((active: boolean) => {
      host.state.reviewActive = active;
    }),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    updateActivityPane: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: { repaint: vi.fn() },
  };
  return host as any;
}

function reviewStartedEvent() {
  return {
    type: 'review.started',
    sessionId: 's1',
    agentId: 'main',
    target: { scope: 'working_tree' },
    intensity: 'standard',
    stats: {
      fileCount: 1,
      additions: 2,
      deletions: 1,
      files: [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
    },
  } as const;
}

function reviewCommentEvent() {
  return {
    type: 'review.comment.added',
    sessionId: 's1',
    agentId: 'main',
    comment: {
      id: 'review-comment-1',
      assignmentId: 'assignment-1',
      state: 'candidate',
      severity: 'important',
      path: 'src/a.ts',
      line: 2,
      title: 'Missing validation',
      body: 'Validate input.',
    },
  } as const;
}

function reviewCompletedEvent() {
  return {
    type: 'review.completed',
    sessionId: 's1',
    agentId: 'main',
    status: 'complete',
    summary: 'Review completed.',
    comments: [],
  } as const;
}

function reviewFailedEvent() {
  return {
    type: 'review.failed',
    sessionId: 's1',
    agentId: 'main',
    message: 'worker failed',
  } as const;
}

function appendedEntries(host: ReturnType<typeof makeHost>): TranscriptEntry[] {
  return host.appendTranscriptEntry.mock.calls.map(
    ([entry]: [TranscriptEntry]) => entry,
  );
}

describe('SessionEventHandler review events', () => {
  it('renders review progress and clears active state on completion', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(reviewStartedEvent(), vi.fn());
    handler.handleEvent(reviewCommentEvent(), vi.fn());
    handler.handleEvent(reviewCompletedEvent(), vi.fn());

    expect(host.state.reviewActive).toBe(false);
    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Sub-agent reviewer started',
      'One review comment was added',
      'Review completed',
    ]);
    expect(appendedEntries(host)[0]!.reviewData!.detail).toContain('1 file: +2 -1');
  });

  it('aggregates multiple added comments into one pluralized line', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(reviewStartedEvent(), vi.fn());
    handler.handleEvent(reviewCommentEvent(), vi.fn());
    handler.handleEvent(reviewCommentEvent(), vi.fn());
    handler.handleEvent(reviewCommentEvent(), vi.fn());
    handler.handleEvent(reviewCompletedEvent(), vi.fn());

    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Sub-agent reviewer started',
      'Three review comments were added',
      'Review completed',
    ]);
  });

  it('skips the completion progress row while the slash command owns final review rendering', () => {
    const host = makeHost();
    host.state.reviewActive = true;
    host.state.reviewResultPending = true;
    const handler = new SessionEventHandler(host);

    handler.handleEvent(reviewCompletedEvent(), vi.fn());

    expect(host.state.reviewActive).toBe(false);
    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([]);
  });

  it('clears active review state on failure and reset', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(reviewStartedEvent(), vi.fn());
    expect(host.state.reviewActive).toBe(true);
    handler.handleEvent(reviewFailedEvent(), vi.fn());

    expect(host.state.reviewActive).toBe(false);
    expect(appendedEntries(host).at(-1)?.reviewData).toMatchObject({
      title: 'Review failed',
      detail: 'worker failed',
    });

    host.state.reviewActive = true;
    host.state.reviewResultPending = true;
    handler.resetRuntimeState();
    expect(host.state.reviewActive).toBe(false);
    expect(host.state.reviewResultPending).toBe(false);
  });

  it('renders provider review failures as a stopped review', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(reviewStartedEvent(), vi.fn());
    handler.handleEvent({
      ...reviewFailedEvent(),
      message: 'Rate limited',
      error: {
        code: 'provider.rate_limit',
        message: 'Rate limited',
        name: 'APIProviderRateLimitError',
        details: { statusCode: 429, requestId: 'req-429' },
        retryable: true,
      },
    } as any, vi.fn());

    expect(host.state.reviewActive).toBe(false);
    expect(appendedEntries(host).at(-1)?.reviewData).toMatchObject({
      title: 'Review stopped',
      detail: expect.stringContaining('rate-limit error'),
    });
    expect(appendedEntries(host).at(-1)?.reviewData?.detail).toContain('[provider.rate_limit]');
  });

  it('renders Thorough reviewer assignments as one parallel summary', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'thorough',
    }, vi.fn());
    for (const [index, perspective] of [
      'Correctness and regressions',
      'Security and data safety',
      'Maintainability and tests',
    ].entries()) {
      handler.handleEvent({
        type: 'review.assignment.started',
        sessionId: 's1',
        agentId: 'main',
        assignment: {
          id: `review-assignment-${String(index + 1)}`,
          role: 'reviewer',
          perspective,
          assignedFiles: ['src/a.ts'],
          requiredCoverage: 'patch',
          group: 'thorough',
        },
      } as any, vi.fn());
    }

    const reviewData = appendedEntries(host).map((entry) => entry.reviewData);
    expect(reviewData.map((entry) => entry?.title)).toEqual([
      'Code review started',
      'Sub-agent reviewers started',
    ]);
    expect(reviewData[1]?.detail).toContain('3 reviewer agents running in parallel');
    expect(reviewData[1]?.detail).toContain('Correctness and regressions');
    expect(reviewData[1]?.detail).toContain('1 file: +2 -1');
  });

  it('suppresses intermediate candidate finding rows during Thorough review', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'thorough',
    }, vi.fn());
    handler.handleEvent(reviewCommentEvent(), vi.fn());

    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Sub-agent reviewers started',
    ]);
  });

  it('labels Thorough reconciliation separately from reviewer progress', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'thorough',
    }, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.started',
      sessionId: 's1',
      agentId: 'main',
      assignment: {
        id: 'review-assignment-reconcile',
        role: 'reconciliator',
        perspective: 'Thorough review',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
        sourceCommentIds: ['review-comment-1'],
        group: 'thorough',
      },
    } as any, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.progress',
      sessionId: 's1',
      agentId: 'main',
      progress: {
        assignmentId: 'review-assignment-reconcile',
        status: 'complete',
        summary: 'Reconciled candidates.',
      },
    } as any, vi.fn());

    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Sub-agent reviewers started',
      'Reconciliation running',
      'Reconciliator complete',
    ]);
  });

  it('renders reordered Thorough reconciliator progress after the role arrives', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'thorough',
    }, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.progress',
      sessionId: 's1',
      agentId: 'main',
      progress: {
        assignmentId: 'review-assignment-reconcile',
        status: 'complete',
        summary: 'Reconciled candidates.',
      },
    } as any, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.started',
      sessionId: 's1',
      agentId: 'main',
      assignment: {
        id: 'review-assignment-reconcile',
        role: 'reconciliator',
        perspective: 'Thorough review',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
        sourceCommentIds: ['review-comment-1'],
        group: 'thorough',
      },
    } as any, vi.fn());

    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Sub-agent reviewers started',
      'Reconciliation running',
      'Reconciliator complete',
    ]);
  });

  it('starts review swarm progress for Deep Review reviewer phase', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'deep',
      agentSwarm: {
        toolCallId: 'review:deep-agent-swarm',
        args: {
          description: 'Deep Review reviewers',
          subagent_type: 'reviewer',
          prompt_template: 'Run this review assignment:\n{{item}}',
          items: ['Correctness / src/a.ts', 'Tests / src/a.ts'],
          review_swarm: {
            perspectives: ['Correctness and regressions', 'Security and data safety'],
            fileGroups: [{ id: 'group-1', name: 'Files 1-1', files: ['src/a.ts'] }],
            items: [
              {
                index: 1,
                perspective: 'Correctness and regressions',
                fileGroupId: 'group-1',
                fileGroupName: 'Files 1-1',
                assignedFiles: ['src/a.ts'],
              },
              {
                index: 2,
                perspective: 'Security and data safety',
                fileGroupId: 'group-1',
                fileGroupName: 'Files 1-1',
                assignedFiles: ['src/a.ts'],
              },
            ],
          },
        },
      },
    } as any, vi.fn());

    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledWith(
      expect.any(ReviewSwarmProgressComponent),
    );
    expect(handler.hasActiveAgentSwarmToolCall()).toBe(true);
  });

  it('updates Deep Review swarm cells from review assignment comments and progress', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'deep',
      agentSwarm: {
        toolCallId: 'review:deep-agent-swarm',
        args: {
          description: 'Deep Review reviewers',
          subagent_type: 'reviewer',
          prompt_template: 'Run this review assignment:\n{{item}}',
          items: ['Correctness / src/a.ts', 'Security / src/a.ts'],
          review_swarm: {
            perspectives: ['Correctness and regressions', 'Security and data safety'],
            fileGroups: [{ id: 'group-1', name: 'Files 1-1', files: ['src/a.ts'] }],
            items: [
              {
                index: 1,
                perspective: 'Correctness and regressions',
                fileGroupId: 'group-1',
                fileGroupName: 'Files 1-1',
                assignedFiles: ['src/a.ts'],
              },
              {
                index: 2,
                perspective: 'Security and data safety',
                fileGroupId: 'group-1',
                fileGroupName: 'Files 1-1',
                assignedFiles: ['src/a.ts'],
              },
            ],
          },
        },
      },
    } as any, vi.fn());
    const progress = host.state.transcriptContainer.addChild.mock.calls[0]?.[0] as ReviewSwarmProgressComponent;

    handler.handleEvent({
      type: 'review.assignment.started',
      sessionId: 's1',
      agentId: 'main',
      assignment: {
        id: 'review-assignment-1',
        role: 'reviewer',
        perspective: 'Correctness and regressions',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'full_file',
        group: 'group-1',
      },
    } as any, vi.fn());
    handler.handleEvent({
      type: 'review.comment.added',
      sessionId: 's1',
      agentId: 'main',
      comment: {
        id: 'review-comment-1',
        assignmentId: 'review-assignment-1',
        state: 'candidate',
        severity: 'important',
        path: 'src/a.ts',
        line: 7,
        title: 'Validate request',
        body: 'Validate request data.',
      },
    } as any, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.progress',
      sessionId: 's1',
      agentId: 'main',
      progress: {
        assignmentId: 'review-assignment-1',
        status: 'complete',
        summary: 'Correctness reviewed.',
      },
    } as any, vi.fn());

    const output = progress.render(112).join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');

    expect(output).toContain('A-01');
    expect(output).toContain('1 comment: important: src/a.ts:7 Vali');
    expect(output).toContain('Reviewing...');
    expect(output).toContain('0/1 files reviewed');
    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Swarm reviewers started',
    ]);
  });

  it('suppresses Deep Review reviewer assignment rows while AgentSwarm is active', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'deep',
      agentSwarm: {
        toolCallId: 'review:deep-agent-swarm',
        args: {
          description: 'Deep Review reviewers',
          subagent_type: 'reviewer',
          prompt_template: 'Run this review assignment:\n{{item}}',
          items: ['Correctness / src/a.ts', 'Tests / src/a.ts'],
        },
      },
    } as any, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.started',
      sessionId: 's1',
      agentId: 'main',
      assignment: {
        id: 'review-assignment-1',
        role: 'reviewer',
        perspective: 'Correctness and regressions',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'full_file',
        group: 'group-1',
      },
    } as any, vi.fn());
    handler.handleEvent({
      type: 'review.assignment.progress',
      sessionId: 's1',
      agentId: 'main',
      progress: {
        assignmentId: 'review-assignment-1',
        status: 'complete',
        summary: 'Done.',
      },
    } as any, vi.fn());

    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Swarm reviewers started',
    ]);
  });

  it('suppresses intermediate candidate finding rows during Deep Review', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'deep',
    }, vi.fn());
    handler.handleEvent(reviewCommentEvent(), vi.fn());

    expect(appendedEntries(host).map((entry) => entry.reviewData?.title)).toEqual([
      'Code review started',
      'Swarm reviewers started',
    ]);
  });
});
