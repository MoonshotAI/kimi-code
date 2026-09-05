import { Container } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { StreamingUIController, type StreamingUIHost } from '#/tui/controllers/streaming-ui';
import type { ToolCallBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeHarness() {
  const notifyPanel = new NotifyPanelComponent();
  const notifyPanelContainer = new Container();
  const transcriptContainer = new Container();
  const requestRender = vi.fn();
  const host = {
    state: {
      notifyPanel,
      notifyPanelContainer,
      transcriptContainer,
      toolOutputExpanded: false,
      ui: { requestRender },
      appState: { workDir: '/tmp/work', streamingPhase: 'waiting' },
    },
    session: undefined,
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    requireSession: vi.fn(),
    deferUserMessages: false,
    shiftQueuedMessage: vi.fn(() => undefined),
    pushTranscriptEntry: vi.fn(),
    mergeCurrentTurnSteps: vi.fn(),
    mergeCompletedTurnAssistants: vi.fn(),
  } as unknown as StreamingUIHost;
  const controller = new StreamingUIController(host);
  return { controller, notifyPanel, notifyPanelContainer, transcriptContainer, requestRender };
}

function notifyCall(id: string, message: string, turnId = 't1'): ToolCallBlockData {
  return { id, name: 'NotifyUser', args: { message }, turnId };
}

function panelText(panel: NotifyPanelComponent): string {
  return panel.render(100).map(strip).join('\n');
}

describe('StreamingUIController — NotifyUser update panel', () => {
  it('mounts the panel with the message and still adds the transcript card', () => {
    const { controller, notifyPanel, notifyPanelContainer, transcriptContainer } = makeHarness();
    controller.setTurnId('t1');

    controller.onToolCallStart(notifyCall('tc-1', 'Reading the parser first.'));

    expect(notifyPanelContainer.children).toEqual([notifyPanel]);
    expect(panelText(notifyPanel)).toContain('Reading the parser first.');
    expect(transcriptContainer.children).toHaveLength(1);
  });

  it('follows the message while the arguments stream, then settles on the final args', () => {
    const { controller, notifyPanel } = makeHarness();
    controller.setTurnId('t1');

    controller.accumulateToolCallDelta('tc-1', 'NotifyUser', '{"message": "Login module is cl');
    controller.flushNow();
    expect(panelText(notifyPanel)).toContain('Login module is cl');

    controller.accumulateToolCallDelta('tc-1', undefined, 'ean; the bug is in session expiry."}');
    controller.flushNow();
    expect(panelText(notifyPanel)).toContain('Login module is clean; the bug is in session expiry.');

    controller.registerToolCall(
      notifyCall('tc-1', 'Login module is clean; the bug is in session expiry.'),
    );
    expect(notifyPanel.getEntries()).toEqual([
      { id: 'tc-1', text: 'Login module is clean; the bug is in session expiry.' },
    ]);
  });

  it('ignores every other tool', () => {
    const { controller, notifyPanel, notifyPanelContainer } = makeHarness();
    controller.setTurnId('t1');

    controller.onToolCallStart({ id: 'tc-1', name: 'Bash', args: { command: 'ls' }, turnId: 't1' });

    expect(notifyPanel.isEmpty()).toBe(true);
    expect(notifyPanelContainer.children).toEqual([]);
  });

  it('replaces the panel wholesale when a call from another turn arrives', () => {
    const { controller, notifyPanel } = makeHarness();

    controller.onToolCallStart(notifyCall('tc-1', 'first turn', 'replay:1'));
    controller.onToolCallStart(notifyCall('tc-2', 'second turn', 'replay:2'));

    expect(notifyPanel.getEntries()).toEqual([{ id: 'tc-2', text: 'second turn' }]);

    // Resume finished: the replayed updates stay readable but read as ended.
    controller.cleanupAfterReplay(new Set(['tc-1', 'tc-2']));
    expect(panelText(notifyPanel)).toContain('turn ended');
  });

  it('clears on demand and dims once the turn ends', () => {
    const { controller, notifyPanel, notifyPanelContainer, requestRender } = makeHarness();
    controller.setTurnId('t1');
    controller.onToolCallStart(notifyCall('tc-1', 'phase one done'));

    controller.markNotifyPanelEnded();
    expect(panelText(notifyPanel)).toContain('turn ended');

    requestRender.mockClear();
    controller.clearNotifyPanel();
    expect(notifyPanel.isEmpty()).toBe(true);
    expect(notifyPanelContainer.children).toEqual([]);
    expect(requestRender).toHaveBeenCalled();

    requestRender.mockClear();
    controller.clearNotifyPanel();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('takes a denied or failed call back out of the panel', () => {
    const { controller, notifyPanel, notifyPanelContainer } = makeHarness();
    controller.setTurnId('t1');
    controller.registerToolCall(notifyCall('tc-1', 'kept update'));
    controller.registerToolCall(notifyCall('tc-2', 'denied update'));

    controller.completeToolResult('tc-2', {
      tool_call_id: 'tc-2',
      output: 'Permission denied',
      is_error: true,
    });
    expect(notifyPanel.getEntries().map((entry) => entry.id)).toEqual(['tc-1']);
    expect(notifyPanelContainer.children).toEqual([notifyPanel]);

    controller.completeToolResult('tc-1', {
      tool_call_id: 'tc-1',
      output: 'Permission denied',
      is_error: true,
    });
    expect(notifyPanel.isEmpty()).toBe(true);
    expect(notifyPanelContainer.children).toEqual([]);
  });

  it('keeps a successfully delivered update when its result lands', () => {
    const { controller, notifyPanel } = makeHarness();
    controller.setTurnId('t1');
    controller.registerToolCall(notifyCall('tc-1', 'kept update'));

    controller.completeToolResult('tc-1', {
      tool_call_id: 'tc-1',
      output: 'Update shown to the user.',
      is_error: false,
    });
    expect(notifyPanel.getEntries()).toEqual([{ id: 'tc-1', text: 'kept update' }]);
  });

  it('drops a half-streamed update when max_tokens truncates the call', () => {
    const { controller, notifyPanel, notifyPanelContainer } = makeHarness();
    controller.setTurnId('t1');
    controller.setStep(2);
    controller.accumulateToolCallDelta('tc-1', 'NotifyUser', '{"message": "half an upd');
    controller.flushNow();
    expect(panelText(notifyPanel)).toContain('half an upd');

    expect(controller.markStepTruncated('t1', 2)).toBe(1);
    expect(notifyPanel.isEmpty()).toBe(true);
    expect(notifyPanelContainer.children).toEqual([]);
  });

  it('drops an update whose call never got a result when the step is interrupted', () => {
    const { controller, notifyPanel, notifyPanelContainer } = makeHarness();
    controller.setTurnId('t1');
    controller.registerToolCall(notifyCall('tc-1', 'delivered update'));
    controller.completeToolResult('tc-1', {
      tool_call_id: 'tc-1',
      output: 'Update shown to the user.',
      is_error: false,
    });
    controller.registerToolCall(notifyCall('tc-2', 'interrupted update'));

    // Esc / a failed step: the tool UI resets before any result for tc-2.
    controller.resetToolUi();
    controller.markNotifyPanelEnded();

    expect(notifyPanel.getEntries()).toEqual([{ id: 'tc-1', text: 'delivered update' }]);
    expect(notifyPanelContainer.children).toEqual([notifyPanel]);
    expect(panelText(notifyPanel)).toContain('turn ended');
  });
});
