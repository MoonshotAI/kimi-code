import { describe, expect, it, vi } from 'vitest';

import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
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
      'Review started',
      'Review finding added',
      'Review completed',
    ]);
    expect(appendedEntries(host)[0]!.reviewData!.detail).toContain('1 file: +2 -1');
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
    handler.resetRuntimeState();
    expect(host.state.reviewActive).toBe(false);
  });

  it('starts AgentSwarm progress for Deep review reviewer phase', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent({
      ...reviewStartedEvent(),
      intensity: 'deep',
      agentSwarm: {
        toolCallId: 'review:deep-agent-swarm',
        args: {
          description: 'Deep review reviewers',
          subagent_type: 'reviewer',
          prompt_template: 'Run this review assignment:\n{{item}}',
          items: ['Correctness / src/a.ts', 'Tests / src/a.ts'],
        },
      },
    } as any, vi.fn());

    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledWith(
      expect.any(AgentSwarmProgressComponent),
    );
    expect(handler.hasActiveAgentSwarmToolCall()).toBe(true);
  });
});
