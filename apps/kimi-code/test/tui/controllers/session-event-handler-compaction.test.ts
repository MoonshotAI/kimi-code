import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        isCompacting: true,
        model: 'kimi-model',
        permissionMode: 'auto',
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      beginCompaction: vi.fn(),
      endCompaction: vi.fn(),
      cancelCompaction: vi.fn(),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as any };
}

const compactionCompleted = {
  type: 'compaction.completed',
  sessionId: 's1',
  agentId: 'main',
  result: { summary: 'summary', tokensBefore: 100, tokensAfter: 10, compactedCount: 1 },
} as const;

const compactionCancelled = {
  type: 'compaction.cancelled',
  sessionId: 's1',
  agentId: 'main',
} as const;

describe('SessionEventHandler compaction cache bookkeeping', () => {
  it('records activity and resets the cache-break baseline after a completed compaction', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(compactionCompleted, vi.fn());
    expect(host.recordSessionActivity).toHaveBeenCalledOnce();
    expect(host.noteCompactionFinished).toHaveBeenCalledOnce();
  });

  it('keeps both baselines after a cancelled compaction (context was not cut)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(compactionCancelled, vi.fn());
    expect(host.noteCompactionFinished).not.toHaveBeenCalled();
    expect(host.recordSessionActivity).not.toHaveBeenCalled();
  });
});
