/**
 * Fullscreen layout contract tests: the docked chrome must keep the editor's
 * full height (top border / input / bottom border) even when the transcript
 * far exceeds the screen. Regression: the dock used to participate in VStack
 * shrink distribution with no minSize, so a tall transcript crushed it and
 * the editor's bottom border row was clipped off screen.
 */
import { describe, expect, it, vi } from 'vitest';

import { Spacer, type Terminal, TuiAltScreen } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '../../../../packages/pi-tui/test/virtual-terminal';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StatusMessageComponent } from '#/tui/components/messages/status-message';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import type { AppState } from '#/tui/types';

const WIDTH = 120;
const HEIGHT = 30;

function fakeInitialAppState(): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
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
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
}

const LONG_MARKDOWN = Array.from(
  { length: 40 },
  (_, i) => `### Section ${i + 1}\n\nSome **bold** and \`code\` content in paragraph ${i + 1}.\n`,
).join('\n');

async function mountFullscreen(): Promise<{
  state: ReturnType<typeof createTUIState>;
  vt: VirtualTerminal;
}> {
  const opts: KimiTUIOptions = {
    initialAppState: fakeInitialAppState(),
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  };
  vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
  const state = createTUIState(opts);
  vi.unstubAllEnvs();
  const vt = new VirtualTerminal(WIDTH, HEIGHT);
  (state.ui as { terminal: Terminal }).terminal = vt;

  // Footer is mounted into the dock after init (mirrors mountFooter()).
  const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  footerWrap.addChild(state.footer);
  state.dockContainer?.addChild(footerWrap, { shrink: 1, minSize: 1 });
  state.editorContainer.addChild(state.editor);
  state.ui.setFocus(state.editor);
  state.ui.start();
  await vt.waitForRender();
  return { state, vt };
}

describe('fullscreen layout', () => {
  it('keeps the editor bottom border visible after a streaming grow/shrink cycle', async () => {
    const { state, vt } = await mountFullscreen();
    expect(state.ui).toBeInstanceOf(TuiAltScreen);

    const screenRows = (): string[] => {
      const rows: string[] = [];
      for (let i = 0; i < HEIGHT; i++) rows.push(stripAnsi(vt.getViewport()[i] ?? '').trimEnd());
      return rows;
    };

    // User message, then a streaming assistant message with the activity pane up.
    state.transcriptContainer.addChild(new UserMessageComponent('分析下这个项目'));
    const spinner = new MoonLoader(state.ui);
    state.activityContainer.addChild(
      new ActivityPaneComponent({ mode: 'tool', spinner, tip: 'streaming' }),
    );
    const assistant = new AssistantMessageComponent();
    state.transcriptContainer.addChild(assistant);
    assistant.updateContent(LONG_MARKDOWN, { transient: true });
    state.ui.requestRender(true);
    await vt.waitForRender();

    // Streaming ends: final highlight, spinner -> one-row placeholder, debug line.
    assistant.updateContent(LONG_MARKDOWN, { transient: false });
    state.activityContainer.clear();
    state.activityContainer.addChild(new Spacer(1));
    state.transcriptContainer.addChild(
      new StatusMessageComponent('[Debug] TTFT: 4.3s | TPS: 203 tok/s'),
    );
    state.ui.requestRender(true);
    await vt.waitForRender();

    const rows = screenRows();
    const promptRow = rows.findIndex((line) => /│\s*>/.test(line));
    expect(promptRow).toBeGreaterThan(0);
    expect(rows[promptRow + 1]).toContain('╰');

    state.ui.stop();
  });

  it('jumps between prompts with Ctrl-Shift-Up/Down (OSC 133 zones survive the chain)', async () => {
    const { state, vt } = await mountFullscreen();

    state.transcriptContainer.addChild(new UserMessageComponent('第一轮提问'));
    const first = new AssistantMessageComponent();
    state.transcriptContainer.addChild(first);
    first.updateContent(`回答一\n\n${LONG_MARKDOWN}`);
    state.transcriptContainer.addChild(new UserMessageComponent('第二轮提问'));
    const second = new AssistantMessageComponent();
    state.transcriptContainer.addChild(second);
    second.updateContent(`回答二\n\n${LONG_MARKDOWN}`);
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    expect(alt.isFollowingOutput).toBe(true);

    const topRows = (): string[] =>
      Array.from({ length: 6 }, (_, i) => stripAnsi(vt.getViewport()[i] ?? '').trimEnd());

    // Zones anchor every user/assistant message, so the nearest previous zone
    // below the fold is the current turn's assistant message, then the user
    // message that started the turn.
    vt.sendInput('\x1b[1;6A'); // ctrl+shift+up = previous prompt
    await vt.waitForRender();
    expect(topRows()[1]).toContain('回答二');

    vt.sendInput('\x1b[1;6A');
    await vt.waitForRender();
    expect(topRows()[1]).toContain('第二轮提问');

    vt.sendInput('\x1b[1;6B'); // ctrl+shift+down = next prompt
    await vt.waitForRender();
    expect(topRows()[1]).toContain('回答二');

    state.ui.stop();
  });
});
