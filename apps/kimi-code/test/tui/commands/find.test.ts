import { Text, TuiAltScreen, type Terminal } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import { mountFooter } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';

function fakeInitialAppState(tuiMode: 'regular' | 'fullscreen'): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
    tuiMode,
  };
}

async function mountHost(
  tuiMode: 'regular' | 'fullscreen',
  options: {
    transcript?: string;
    streamingPhase?: AppState['streamingPhase'];
    isCompacting?: boolean;
    skillCommandMap?: Map<string, string>;
  } = {},
) {
  const opts: KimiTUIOptions = {
    initialAppState: {
      ...fakeInitialAppState(tuiMode),
      streamingPhase: options.streamingPhase ?? 'idle',
      isCompacting: options.isCompacting ?? false,
    },
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  };
  const state = createTUIState(opts);
  const vt = new VirtualTerminal(100, 12);
  (state.ui as { terminal: Terminal }).terminal = vt;
  if (options.transcript !== undefined) {
    state.transcriptContainer.addChild(new Text(options.transcript, 0, 0));
  }
  mountFooter(state);
  state.editorContainer.addChild(state.editor);
  if (!(state.ui instanceof TuiAltScreen)) {
    state.ui.addChild(state.transcriptContainer);
    state.ui.addChild(state.editorContainer);
  }
  state.ui.setFocus(state.editor);
  state.ui.start();
  await vt.waitForRender();

  const host = {
    state,
    session: undefined,
    skillCommandMap: options.skillCommandMap ?? new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    ensureSession: vi.fn(async () => undefined),
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendInlineSkillUserInput: vi.fn(async () => {}),
    restoreInputText: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    ensureSession: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    sendInlineSkillUserInput: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };

  return { host, state, vt };
}

describe('/find slash command dispatch', () => {
  it('opens and focuses an empty search box in fullscreen mode without requiring a session', async () => {
    const { host, state, vt } = await mountHost('fullscreen', {
      transcript: 'needle one\nmiddle\nneedle two',
    });
    try {
      dispatchInput(host, '/find');
      await vt.waitForRender();

      const viewport = vt.getViewport();
      expect(viewport.some((line) => line.includes('Find in transcript'))).toBe(true);
      expect(viewport.some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(true);
      expect(host.ensureSession).not.toHaveBeenCalled();
      expect(host.sendNormalUserInput).not.toHaveBeenCalled();
      expect(host.showError).not.toHaveBeenCalled();

      vt.sendInput('needle');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('needle') && line.includes('/2'))).toBe(true);
    } finally {
      state.ui.stop();
    }
  });

  it('prefills the query with cursor at the end and highlights matches immediately', async () => {
    const { host, state, vt } = await mountHost('fullscreen', {
      transcript: 'needl short\nneedle one\nmiddle\nneedle two',
    });
    try {
      dispatchInput(host, '/find   needle  ');
      await vt.waitForRender();

      const initialViewport = vt.getViewport();
      expect(initialViewport.some((line) => line.includes('needle') && line.includes('/2'))).toBe(true);
      expect(initialViewport.some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(true);

      vt.sendInput('\u007F');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('needl') && line.includes('/3'))).toBe(true);
    } finally {
      state.ui.stop();
    }
  });

  it('works while streaming and while compacting in fullscreen mode', async () => {
    const streaming = await mountHost('fullscreen', {
      transcript: 'alpha\nbeta\nalpha',
      streamingPhase: 'composing',
    });
    try {
      dispatchInput(streaming.host, '/find alpha');
      await streaming.vt.waitForRender();
      expect(streaming.vt.getViewport().some((line) => line.includes('alpha') && line.includes('/2'))).toBe(true);
      expect(streaming.host.showError).not.toHaveBeenCalled();
    } finally {
      streaming.state.ui.stop();
    }

    const compacting = await mountHost('fullscreen', {
      transcript: 'alpha\nbeta\nalpha',
      isCompacting: true,
    });
    try {
      dispatchInput(compacting.host, '/find alpha');
      await compacting.vt.waitForRender();
      expect(compacting.vt.getViewport().some((line) => line.includes('alpha') && line.includes('/2'))).toBe(true);
      expect(compacting.host.showError).not.toHaveBeenCalled();
    } finally {
      compacting.state.ui.stop();
    }
  });

  it('passes /find through as normal input or a same-named skill in regular mode', async () => {
    const regular = await mountHost('regular', {
      transcript: 'needle one',
    });
    try {
      dispatchInput(regular.host, '/find needle');
      await regular.vt.waitForRender();

      expect(regular.host.sendNormalUserInput).toHaveBeenCalledWith('/find needle', undefined, 'default');
      expect(regular.host.track).not.toHaveBeenCalledWith('input_command', { command: 'find' });
      expect(regular.vt.getViewport().some((line) => line.includes('Find in transcript'))).toBe(false);
    } finally {
      regular.state.ui.stop();
    }

    const withSkill = await mountHost('regular', {
      skillCommandMap: new Map([['skill:find', 'find']]),
    });
    try {
      dispatchInput(withSkill.host, '/find needle');
      await withSkill.vt.waitForRender();

      expect(withSkill.host.sendInlineSkillUserInput).toHaveBeenCalledWith(
        '/find needle',
        [{ skillName: 'find', path: undefined, start: 0, args: 'needle' }],
        undefined,
        'default',
      );
      expect(withSkill.host.sendNormalUserInput).not.toHaveBeenCalled();
    } finally {
      withSkill.state.ui.stop();
    }
  });
});
