import { onTestFinished, describe, expect, it, vi } from 'vitest';
import type { TUI } from '@moonshot-ai/pi-tui';
import type { Session, TurnEndedEvent } from '@moonshot-ai/kimi-code-sdk';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import { PromptPredictionController } from '#/tui/controllers/prompt-prediction';
import type { TUIState } from '#/tui/tui-state';

function turnEnded(turnId: number): TurnEndedEvent {
  return { type: 'turn.ended', sessionId: 'session-1', agentId: 'main', turnId, reason: 'completed' } as TurnEndedEvent;
}

describe('PromptPredictionController', () => {
  it('accepts and submits ghost text while cancelling stale requests precisely', async () => {
    setExperimentalFeatures([{ id: 'prompt_prediction', enabled: true }]);
    onTestFinished(() => setExperimentalFeatures([]));
    const editor = new CustomEditor({ requestRender: vi.fn(), terminal: { rows: 40, cols: 80 } } as unknown as TUI);
    const state = {
      editor,
      startupState: 'ready',
      appState: {
        streamingPhase: 'idle',
        isCompacting: false,
        isReplaying: false,
        planMode: false,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      activeDialog: null,
      editorReplacementMounted: false,
      tasksBrowser: undefined,
      externalEditorRunning: false,
      livePane: { pendingApproval: null, pendingQuestion: null },
      ui: { requestRender: vi.fn() },
    } as unknown as TUIState;
    let nextPrediction = () => Promise.resolve<string | null>(null);
    const session = {
      id: 'session-1',
      predictNextPrompt: vi.fn(() => nextPrediction()),
      cancelPromptPrediction: vi.fn(async () => true),
    } as unknown as Session;
    const track = vi.fn();
    const host = { state, session, aborted: false, track };
    const controller = new PromptPredictionController(host);
    editor.onChange = (text) => controller.handleEditorChange(text);
    editor.onSubmit = (text) => controller.handleSubmit(text);

    nextPrediction = () => Promise.resolve('请修复失败的测试\n并补充回归覆盖');
    controller.handleTurnEnded(turnEnded(7));
    await vi.waitFor(() => expect(editor.getPromptPrediction()).toBeDefined());
    expect(session.predictNextPrompt).toHaveBeenCalledWith({
      predictionId: expect.any(String),
      expectedTurnId: 7,
    });
    expect(controller.handlePreInput('\t')).toBe(true);
    expect(editor.getText()).toBe('请修复失败的测试\n并补充回归覆盖');
    expect(editor.getPromptPrediction()).toBeUndefined();
    expect(track.mock.calls.filter(([event]) => event === 'prediction_dismissed')).toHaveLength(0);
    editor.handleInput('\r');
    expect(track).toHaveBeenCalledWith('prediction_submitted', expect.objectContaining({ edited: false }));

    let resolveCancelled!: (value: string | null) => void;
    nextPrediction = () => new Promise<string | null>((resolve) => {
      resolveCancelled = resolve;
    });
    controller.handleTurnStarted();
    editor.setText('');
    controller.handleTurnEnded(turnEnded(8));
    await vi.waitFor(() => expect(session.predictNextPrompt).toHaveBeenCalledTimes(2));
    const cancelInput = (session.predictNextPrompt as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as {
      predictionId: string;
    };
    expect(controller.handlePreInput(String.fromCodePoint(0x1b))).toBe(true);
    expect(session.cancelPromptPrediction).toHaveBeenCalledWith(cancelInput.predictionId, 'escape');
    resolveCancelled('晚到的预测');
    await Promise.resolve();
    expect(editor.getPromptPrediction()).toBeUndefined();

    nextPrediction = () => Promise.resolve('run the focused suite');
    controller.handleTurnEnded(turnEnded(9));
    await vi.waitFor(() => expect(editor.getPromptPrediction()).toBe('run the focused suite'));
    expect(controller.handlePreInput(`${String.fromCodePoint(0x1b)}[C`)).toBe(true);
    editor.handleInput(' now');
    editor.handleInput('\r');
    expect(track).toHaveBeenCalledWith('prediction_submitted', expect.objectContaining({ edited: true }));

    nextPrediction = () => Promise.resolve('this suggestion is dismissed');
    controller.handleTurnStarted();
    editor.setText('');
    controller.handleTurnEnded(turnEnded(10));
    await vi.waitFor(() => expect(editor.getPromptPrediction()).toBeDefined());
    editor.handleInput('x');
    expect(editor.getPromptPrediction()).toBeUndefined();
    expect(track).toHaveBeenCalledWith('prediction_dismissed', expect.objectContaining({ reason: 'input' }));

    nextPrediction = () => Promise.resolve('do not show this in plan mode');
    editor.setText('');
    controller.handleTurnEnded(turnEnded(11));
    await vi.waitFor(() => expect(editor.getPromptPrediction()).toBeDefined());
    state.appState.planMode = true;
    controller.handlePlanModeChanged(true);
    expect(editor.getPromptPrediction()).toBeUndefined();
    expect(track).toHaveBeenCalledWith('prediction_dismissed', expect.objectContaining({ reason: 'plan' }));

    state.appState.planMode = false;
    nextPrediction = () => Promise.resolve('clear this accepted suggestion');
    controller.handleTurnEnded(turnEnded(12));
    await vi.waitFor(() => expect(editor.getPromptPrediction()).toBeDefined());
    expect(controller.handlePreInput('\t')).toBe(true);
    editor.setText('');
    editor.handleInput('\r');
    expect(track.mock.calls.filter(([event]) => event === 'prediction_submitted')).toHaveLength(2);
    expect(track).toHaveBeenCalledWith('prediction_dismissed', expect.objectContaining({
      reason: 'submit',
      accepted: true,
    }));

    nextPrediction = () => Promise.resolve('git push');
    editor.terminalFocused = false;
    controller.handleTurnEnded(turnEnded(13));
    await vi.waitFor(() => expect(editor.getPromptPrediction()).toBeDefined());
    expect(editor.render(80).join('\n')).toContain('git push');
    editor.terminalFocused = true;
    editor.handleInput('!');
    expect(editor.inputMode).toBe('bash');
    expect(controller.handlePreInput('\t')).toBe(false);
    expect(controller.handlePreInput(`${String.fromCodePoint(0x1b)}[C`)).toBe(false);
    expect(editor.getText()).toBe('');

    for (const [, properties] of track.mock.calls) {
      expect(properties).not.toHaveProperty('text');
      expect(properties).not.toHaveProperty('prediction');
    }
    controller.dispose();
  });
});
