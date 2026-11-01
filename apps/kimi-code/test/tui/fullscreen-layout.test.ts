import {
  Spacer,
  Text,
  VStack,
  ScrollView,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type Terminal,
  TuiAltScreen,
} from '@moonshot-ai/pi-tui';
/**
 * Fullscreen layout contract tests: the docked chrome must keep the editor's
 * full height (top border / input / bottom border) even when the transcript
 * far exceeds the screen. Regression: the dock used to participate in VStack
 * shrink distribution with no minSize, so a tall transcript crushed it and
 * the editor's bottom border row was clipped off screen.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { handleGoalCommand } from '#/tui/commands/goal';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StatusMessageComponent } from '#/tui/components/messages/status-message';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import * as userMessages from '#/tui/components/messages/user-message';
import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { createTUIState, KimiTUI, type KimiTUIOptions } from '#/tui/kimi-tui';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { GoalStartPermissionPromptComponent } from '#/tui/components/dialogs/goal-start-permission-prompt';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { NotifyController } from '#/tui/controllers/notify';
import {
  editorSlotComponent,
  isBlockingPromptPending,
  mountFooter,
  setEditorSlot,
} from '#/tui/tui-state';
import { currentTheme } from '#/tui/theme';
import type { AppState, TranscriptEntry } from '#/tui/types';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';
import {
  installTerminalFocusTracking,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/utils/terminal-focus';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';

import { VirtualTerminal } from '../../../../packages/pi-tui/test/virtual-terminal';

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
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replaceAll(/\u001B\[[0-9;?]*[a-zA-Z]|\u001B\][^\u0007]*\u0007/g, '');
}

const LONG_MARKDOWN = Array.from(
  { length: 40 },
  (_, i) => `### Section ${i + 1}\n\nSome **bold** and \`code\` content in paragraph ${i + 1}.\n`,
).join('\n');

async function mountFullscreen(height = HEIGHT): Promise<{
  state: ReturnType<typeof createTUIState>;
  vt: VirtualTerminal;
}> {
  const opts: KimiTUIOptions = {
    initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  };
  const state = createTUIState(opts);
  const vt = new VirtualTerminal(WIDTH, height);
  (state.ui as { terminal: Terminal }).terminal = vt;

  mountFooter(state);
  state.editorContainer.addChild(state.editor);
  state.ui.setFocus(state.editor);
  state.ui.start();
  await vt.waitForRender();
  return { state, vt };
}

function screenRows(vt: VirtualTerminal): string[] {
  return vt.getViewport().map((row) => stripAnsi(row).trimEnd());
}

function updateQueueDisplay(state: ReturnType<typeof createTUIState>): void {
  const host = {
    state,
    deferUserMessages: false,
    isSteeringQueuedMessages: () => false,
  } as unknown as KimiTUI;
  KimiTUI.prototype.updateQueueDisplay.call(host);
}

function pendingApproval(): NonNullable<ReturnType<typeof createTUIState>['livePane']['pendingApproval']> {
  return {
    data: {
      id: 'call-1',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      action: 'run',
      description: '',
      display: [],
      choices: [{ label: 'Approve once', response: 'approved' }],
    },
  };
}

function pillLines(state: ReturnType<typeof createTUIState>): string[] {
  const root = (state.ui as TuiAltScreen).getLayoutRoot() as VStack;
  const transcript = root.children[0] as VStack;
  return transcript.children[0]!.render(state.ui.terminal.columns);
}

describe('fullscreen layout', () => {
  it('summarizes only the current message, jumps to its start, and searches the original text', async () => {
    const { state, vt } = await mountFullscreen();
    for (const [index, content] of ['one', 'two', 'three', 'four\nfive\nsix'].entries()) {
      const entry: TranscriptEntry = {
        id: `user-${index}`,
        kind: 'user',
        turnId: 'turn',
        content,
        renderMode: 'plain',
      };
      const message = new UserMessageComponent(content);
      markTranscriptComponent(message, entry);
      state.transcriptContainer.addChild(message);
    }
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    const alt = state.ui as TuiAltScreen;
    const topRow = () => stripAnsi(vt.getViewport()[0] ?? '').trim();
    alt.renderNow();
    await vt.flush();
    expect(topRow()).toBe('❯ four five six');

    alt.scrollToTop();
    alt.scrollBy(7);
    await vt.waitForRender();
    expect(topRow()).toBe('❯ three');
    expect(stripAnsi(vt.getViewport()[1]!)).toContain('❯ four');

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(8);
    expect(pillLines(state)).toEqual([]);
    expect(topRow()).toContain('❯ four');

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(topRow()).toBe('❯ four five');
    expect(stripAnsi(vt.getViewport()[1]!)).toContain('six');

    vt.sendInput('\u001B[<0;5;1M');
    vt.sendInput('\u001B[<0;5;1m');
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(8);
    expect(pillLines(state)).toEqual([]);
    expect(topRow()).toContain('❯ four');

    alt.scrollToBottom();
    await vt.waitForRender();
    const write = vi.spyOn(vt, 'write');
    vt.sendInput('\u001B[102;6u');
    vt.sendInput('four');
    await vt.waitForRender();
    expect(vt.getViewport().some((line) => line.includes('1/1'))).toBe(true);
    expect(pillLines(state)).toEqual([]);
    expect(vt.getViewport().some((line) => stripAnsi(line).includes('❯ four'))).toBe(true);
    expect(write.mock.calls.some(([data]) => data.includes('\u001B[1;7mfour\u001B[22;27m'))).toBe(
      true,
    );
    alt.scrollToTop();
    alt.scrollBy(8);
    await vt.waitForRender();
    expect(pillLines(state)).toEqual([]);
    expect(topRow()).toContain('❯ four');
    alt.stop();
  });

  it('keeps copied text unchanged when a scroll toggles the pill after selection', async () => {
    const { state, vt } = await mountFullscreen();
    const entry: TranscriptEntry = {
      id: 'user',
      kind: 'user',
      content: 'user first\nuser second',
      renderMode: 'plain',
    };
    const message = new UserMessageComponent(entry.content);
    markTranscriptComponent(message, entry);
    state.transcriptContainer.addChild(message);
    state.transcriptContainer.addChild(
      new Text('alpha\nbeta\ngamma\n' + 'body\n'.repeat(40), 0, 0),
    );
    const alt = state.ui as TuiAltScreen;
    alt.setCopyOnSelect(false);
    alt.renderNow();
    alt.scrollToTop();
    alt.scrollBy(2);
    await vt.waitForRender();
    expect(vt.getViewport()[2]).toContain('alpha');
    vt.sendInput(`\u001B[<0;${CHROME_GUTTER + 1};3M`);
    vt.sendInput(`\u001B[<32;${CHROME_GUTTER + 5};3M`);
    vt.sendInput(`\u001B[<0;${CHROME_GUTTER + 5};3m`);
    await vt.waitForRender();
    const write = vi.spyOn(vt, 'write');
    const copiedAlpha = `\u001B]52;c;${Buffer.from('alpha').toString('base64')}\u0007`;
    await alt.copyActiveSelectionToClipboard();
    expect(write).toHaveBeenCalledWith(copiedAlpha);
    write.mockClear();
    alt.scrollBy(1);
    await vt.waitForRender();
    expect(pillLines(state)).toHaveLength(1);
    await alt.copyActiveSelectionToClipboard();
    expect(write).toHaveBeenCalledWith(copiedAlpha);
    write.mockClear();
    alt.scrollBy(-1);
    await vt.waitForRender();
    expect(pillLines(state)).toEqual([]);
    await alt.copyActiveSelectionToClipboard();
    expect(write).toHaveBeenCalledWith(copiedAlpha);
    alt.stop();
  });

  it('searches only the transcript and highlights the original first line where the pill would appear', async () => {
    const { state, vt } = await mountFullscreen();
    const entry: TranscriptEntry = {
      id: 'user',
      kind: 'user',
      content: 'needle question',
      renderMode: 'plain',
    };
    const message = new UserMessageComponent(entry.content);
    markTranscriptComponent(message, entry);
    state.transcriptContainer.addChild(message);
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    const write = vi.spyOn(vt, 'write');
    vt.sendInput('\u001B[102;6u');
    vt.sendInput('needle');
    await vt.waitForRender();
    expect(vt.getViewport().some((line) => line.includes('1/1'))).toBe(true);
    expect(pillLines(state)).toEqual([]);
    expect(write.mock.calls.some(([data]) => data.includes('\u001B[1;7mneedle\u001B[22;27m'))).toBe(
      true,
    );

    alt.scrollToTop();
    alt.scrollBy(2);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(2);
    expect(pillLines(state)).toEqual([]);
    expect(vt.getViewport()[0]).toContain('needle question');

    write.mockClear();
    alt.scrollToBottom();
    await vt.waitForRender();
    expect(pillLines(state)).toHaveLength(1);
    expect(vt.getViewport()[0]).toContain('needle question');
    expect(vt.getViewport().some((line) => line.includes('1/1'))).toBe(true);
    expect(
      write.mock.calls.every(([data]) => !data.includes('\u001B[1;7mneedle\u001B[22;27m')),
    ).toBe(true);
    alt.stop();
  });

  it('updates the candidate position and wrapping after a width change', async () => {
    const { state, vt } = await mountFullscreen();
    for (const [id, content] of [
      ['first', 'wide text '.repeat(35)],
      ['latest', 'latest question'],
    ]) {
      const entry: TranscriptEntry = {
        id: id!,
        kind: 'user',
        content: content!,
        renderMode: 'plain',
      };
      const message = new UserMessageComponent(entry.content);
      markTranscriptComponent(message, entry);
      state.transcriptContainer.addChild(message);
    }
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    const measure = vi.spyOn(userMessages, 'userMessageLineHeights');
    try {
      vt.resize(60, HEIGHT);
      await vt.waitForRender();
      expect(measure).toHaveBeenCalledTimes(1);
      expect(measure).toHaveBeenCalledWith('latest question', 60 - CHROME_GUTTER * 2, undefined);
      vt.sendInput('\u001B[<0;5;1M');
      vt.sendInput('\u001B[<0;5;1m');
      await vt.waitForRender();
      expect(alt.viewportTop).toBeGreaterThan(2);
      expect(pillLines(state)).toEqual([]);
      expect(vt.getViewport()[0]).toContain('latest question');
    } finally {
      measure.mockRestore();
      alt.stop();
    }
  });

  it('leaves a temporary fullscreen viewer alone and resumes the transcript when restored', async () => {
    const { state, vt } = await mountFullscreen();
    const alt = state.ui as TuiAltScreen;
    const takeover = beginScreenTakeover(alt, new Text('temporary viewer', 0, 0));
    const render = vi.spyOn(state.transcriptContainer, 'render');
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    alt.renderNow();
    await vt.flush();
    expect(vt.getViewport()[0]).toContain('temporary viewer');
    expect(render).not.toHaveBeenCalled();
    endScreenTakeover(alt, takeover);
    alt.renderNow();
    await vt.flush();
    expect(render).toHaveBeenCalled();
    expect(vt.getViewport().some((line) => line.includes('temporary viewer'))).toBe(false);
    alt.stop();
  });

  it('commits the resumed pill in one frame without moving the follow position during correction', async () => {
    const { state, vt } = await mountFullscreen();
    const entry: TranscriptEntry = {
      id: 'user',
      kind: 'user',
      content: 'resumed message',
      renderMode: 'plain',
    };
    const message = new UserMessageComponent(entry.content);
    markTranscriptComponent(message, entry);
    state.transcriptContainer.addChild(message);
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 40 }, (_, i) => `body ${i}`).join('\n'), 0, 0),
    );
    const alt = state.ui as TuiAltScreen;
    const view = (alt.getLayoutRoot() as VStack).children[0] as VStack;
    const scroll = view.children[1] as ScrollView;
    const passes: { top: number; height: number }[] = [];
    const dispose = alt.addLayoutEffect(() =>
      passes.push({ top: scroll.scrollTop, height: scroll.viewportHeight }),
    );
    const write = vi.spyOn(vt, 'write');
    alt.renderNow();
    await vt.flush();
    expect(write.mock.calls.filter(([data]) => data.includes('\u001B[?2026h'))).toHaveLength(1);
    expect(stripAnsi(vt.getViewport()[0]!)).toContain('❯ resumed message');
    expect(passes).toHaveLength(2);
    expect(passes[0]!.top).toBe(passes[1]!.top);
    expect(passes[0]!.height).toBe(passes[1]!.height + 1);
    dispose();
    alt.stop();
  });

  it('keeps exact scroll positions while crossing the pin threshold in either direction', async () => {
    const { state, vt } = await mountFullscreen();
    const entry: TranscriptEntry = {
      id: 'user',
      kind: 'user',
      content: 'first\nsecond\nthird',
      renderMode: 'plain',
    };
    const message = new UserMessageComponent(entry.content);
    markTranscriptComponent(message, entry);
    state.transcriptContainer.addChild(message);
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    alt.scrollToTop();
    alt.scrollBy(2);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(2);
    expect(pillLines(state)).toEqual([]);
    expect(stripAnsi(vt.getViewport()[1]!)).toContain('second');
    alt.scrollBy(1);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(3);
    expect(pillLines(state).map(stripAnsi).join('')).toContain('first second');
    expect(stripAnsi(vt.getViewport()[1]!)).toContain('third');
    alt.scrollBy(-1);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(2);
    expect(pillLines(state)).toEqual([]);
    expect(stripAnsi(vt.getViewport()[1]!)).toContain('second');
    alt.stop();
  });

  it('maps transcript clicks correctly with and without content padding', async () => {
    const { state, vt } = await mountFullscreen();
    const entry: TranscriptEntry = {
      id: 'user',
      kind: 'user',
      content: 'question',
      renderMode: 'plain',
    };
    const message = new UserMessageComponent(entry.content);
    markTranscriptComponent(message, entry);
    state.transcriptContainer.addChild(message);
    const clicks: TuiMouseEvent[] = [];
    const body: Component = {
      render: () => Array.from({ length: 40 }, (_, i) => `body ${i}`),
      invalidate() {},
      handleMouse: (event) => {
        clicks.push(event);
        return { handled: true };
      },
    };
    state.transcriptContainer.addChild(body);
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    await vt.flush();
    vt.sendInput('\u001B[<0;5;2M');
    vt.sendInput('\u001B[<0;5;2m');
    await vt.waitForRender();
    expect(clicks.at(-1)?.y).toBe(alt.viewportTop - 2);
    alt.scrollToTop();
    await vt.waitForRender();
    vt.sendInput('\u001B[<0;5;4M');
    vt.sendInput('\u001B[<0;5;4m');
    await vt.waitForRender();
    expect(clicks.at(-1)?.y).toBe(0);
    expect(clicks.at(-1)?.width).toBe(WIDTH - CHROME_GUTTER * 2);
    alt.stop();
  });

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
    vt.sendInput('\u001B[1;6A'); // ctrl+shift+up = previous prompt
    await vt.waitForRender();
    expect(topRows()[1]).toContain('回答二');

    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRows()[1]).toContain('第二轮提问');

    vt.sendInput('\u001B[1;6B'); // ctrl+shift+down = next prompt
    await vt.waitForRender();
    expect(topRows()[1]).toContain('回答二');

    state.ui.stop();
  });

  it('pins the scrolled-past user message and reveals its original first line on click', async () => {
    const { state, vt } = await mountFullscreen();

    const userEntry: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      renderMode: 'plain',
      content: '第一轮问题',
    };
    const userComponent = new UserMessageComponent(userEntry.content);
    markTranscriptComponent(userComponent, userEntry);
    state.transcriptContainer.addChild(userComponent);
    const assistant = new AssistantMessageComponent();
    state.transcriptContainer.addChild(assistant);
    assistant.updateContent(LONG_MARKDOWN, { transient: false });
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    const topRow = () => stripAnsi(vt.getViewport()[0] ?? '').trimEnd();
    const messageRowCount = () =>
      Array.from({ length: HEIGHT }, (_, i) => stripAnsi(vt.getViewport()[i] ?? '')).filter(
        (line) => line.includes('第一轮问题'),
      ).length;

    // Following at the bottom: the latest message's first line has scrolled
    // out, so it is pinned.
    expect(alt.isFollowingOutput).toBe(true);
    expect(alt.viewportTop).toBeGreaterThan(1);
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(messageRowCount()).toBe(1);

    // The hidden pill gives its row back to padding inside the scroll content.
    alt.scrollToTop();
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(0);
    expect(topRow()).not.toContain('❯ 第一轮问题');

    // scrollTop lands on the message's first content line: the message itself
    // sits at the top of the screen — no pill, no blank slot row above it.
    alt.scrollBy(2);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(2);
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(messageRowCount()).toBe(1);

    alt.scrollBy(10);
    await vt.waitForRender();
    const scrolledTop = alt.viewportTop;
    expect(scrolledTop).toBeGreaterThan(1);
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(messageRowCount()).toBe(1);

    vt.sendInput('\u001B[<65;5;1M'); // wheel down over the pill row
    await vt.waitForRender();
    expect(alt.viewportTop).toBeGreaterThan(scrolledTop);

    vt.sendInput('\u001B[<0;5;1M'); // press + release = click on the pill row
    vt.sendInput('\u001B[<0;5;1m');
    await vt.waitForRender();
    // The pill disappears and the original first line occupies the same row.
    expect(alt.viewportTop).toBe(2);
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(messageRowCount()).toBe(1);

    state.ui.stop();
  });

  it('grows the pill summary as more lines of a multi-line message scroll out', async () => {
    const { state, vt } = await mountFullscreen();

    const userEntry: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      renderMode: 'plain',
      content: '第一行\n第二行\n第三行',
    };
    const userComponent = new UserMessageComponent(userEntry.content);
    markTranscriptComponent(userComponent, userEntry);
    state.transcriptContainer.addChild(userComponent);
    const assistant = new AssistantMessageComponent();
    state.transcriptContainer.addChild(assistant);
    assistant.updateContent(LONG_MARKDOWN, { transient: false });
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    const topRow = () => stripAnsi(vt.getViewport()[0] ?? '').trim();

    expect(topRow()).toBe('❯ 第一行 第二行 第三行');

    alt.scrollToTop();
    await vt.waitForRender();
    expect(topRow()).not.toContain('❯');

    alt.scrollBy(2); // the original first content line occupies the top row
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一行');

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行 第二行');

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行 第二行 第三行');

    vt.sendInput('\u001B[<0;5;1M'); // press + release = click on the pill row
    vt.sendInput('\u001B[<0;5;1m');
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(2);
    expect(topRow()).toContain('❯ 第一行');
    expect(stripAnsi(vt.getViewport()[1] ?? '')).toContain('第二行');

    state.ui.stop();
  });

  it('anchors the pill to the first visible text line of a message with leading blank lines', async () => {
    const { state, vt } = await mountFullscreen();

    const userEntry: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      renderMode: 'plain',
      content: '\n\n第一行\n第二行',
    };
    const userComponent = new UserMessageComponent(userEntry.content);
    markTranscriptComponent(userComponent, userEntry);
    state.transcriptContainer.addChild(userComponent);
    const assistant = new AssistantMessageComponent();
    state.transcriptContainer.addChild(assistant);
    assistant.updateContent(LONG_MARKDOWN, { transient: false });
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    const topRow = () => stripAnsi(vt.getViewport()[0] ?? '').trim();
    const countRows = (text: string) =>
      Array.from({ length: HEIGHT }, (_, i) => stripAnsi(vt.getViewport()[i] ?? '')).filter(
        (line) => line.includes(text),
      ).length;

    alt.scrollToTop();
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(0);

    alt.scrollBy(3); // padding, spacer and one leading blank line are out
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(3);
    expect(topRow()).not.toContain('第一行');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1); // the message's own first text line sits at the top: still no pill
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(4);
    expect(topRow()).toContain('第一行');
    expect(topRow()).not.toContain('❯');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1); // the first text line is out: the pill takes over
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(5);
    expect(countRows('第一行')).toBe(1);
    expect(topRow()).toBe('❯ 第一行 第二行');

    state.ui.stop();
  });

  it('pins the previous message after navigating onto a later message head', async () => {
    const { state, vt } = await mountFullscreen();

    const addUser = (id: string, text: string) => {
      const entry: TranscriptEntry = { id, kind: 'user', renderMode: 'plain', content: text };
      const component = new UserMessageComponent(entry.content);
      markTranscriptComponent(component, entry);
      state.transcriptContainer.addChild(component);
    };
    const addAssistant = () => {
      const component = new AssistantMessageComponent();
      state.transcriptContainer.addChild(component);
      component.updateContent(LONG_MARKDOWN, { transient: false });
    };
    addUser('u1', '第一轮问题');
    addAssistant();
    addUser('u2', '第二轮问题');
    addAssistant();
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    const topRow = () => stripAnsi(vt.getViewport()[0] ?? '').trimEnd();
    const countRows = (text: string) =>
      Array.from({ length: HEIGHT }, (_, i) => stripAnsi(vt.getViewport()[i] ?? '')).filter(
        (line) => line.includes(text),
      ).length;

    expect(topRow()).toContain('❯ 第二轮问题');

    vt.sendInput('\u001B[1;6A'); // lands on the second assistant's zone; 第二轮问题 first line out
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第二轮问题');
    expect(countRows('第二轮问题')).toBe(1);

    // Lands on 第二轮问题's own head (its spacer line): 第二轮's first content
    // line is still visible below the top, so the pill switches to 第一轮问题 —
    // CSS-sticky semantics, not a duplicate.
    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(countRows('第二轮问题')).toBe(1);
    expect(countRows('第一轮问题')).toBe(1);

    vt.sendInput('\u001B[1;6A'); // lands on the first assistant's zone; 第一轮问题 stays pinned
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(countRows('第一轮问题')).toBe(1);

    vt.sendInput('\u001B[1;6A'); // lands on 第一轮问题's head: no candidate above -> no pill
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(pillLines(state)).toEqual([]);
    expect(countRows('第一轮问题')).toBe(1);

    state.ui.stop();
  });

  it('stays unpinned when the message first line lands exactly at the follow position', async () => {
    const { state, vt } = await mountFullscreen();

    const userEntry: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      renderMode: 'plain',
      content: '边界消息',
    };
    const userComponent = new UserMessageComponent(userEntry.content);
    markTranscriptComponent(userComponent, userEntry);
    state.transcriptContainer.addChild(userComponent);
    // The dock takes 5 rows (activity 1 + editor 3 + footer 1), leaving a
    // 25-row scroll viewport. Padding + 2 message rows + 24 filler rows
    // puts the follow position at scrollTop 2, exactly the first text line.
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 24 }, (_, i) => `填充行 ${i + 1}`).join('\n'), 0, 0),
    );
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    expect(alt.isFollowingOutput).toBe(true);
    // The original first line sits at the top, with no external header row.
    expect(alt.viewportTop).toBe(2);
    expect(pillLines(state)).toEqual([]);
    expect(stripAnsi(vt.getViewport()[0] ?? '')).toContain('边界消息');

    state.ui.stop();
  });

  it.each([4, 5])('preserves the editor on a %i-row terminal without a pill', async (height) => {
    const { state, vt } = await mountFullscreen(height);
    state.editor.setText('draft input');

    const userEntry: TranscriptEntry = {
      id: 'u1',
      kind: 'user',
      renderMode: 'plain',
      content: '压缩场景',
    };
    const userComponent = new UserMessageComponent(userEntry.content);
    markTranscriptComponent(userComponent, userEntry);
    state.transcriptContainer.addChild(userComponent);
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 30 }, (_, i) => `长文 ${i + 1}`).join('\n'), 0, 0),
    );
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    expect(alt.isFollowingOutput).toBe(true);
    expect(pillLines(state)).toEqual([]);
    const rows = vt.getViewport();
    expect(rows[0]).toContain('长文 30');
    expect(rows[1]).toContain('╭');
    expect(rows[2]).toContain('draft input');
    expect(rows[3]).toContain('╰');
    if (height === 5) expect(rows[4]).toContain('test-model');

    state.ui.stop();
  });

  it('hides and restores the pill when resizing or dock growth leaves only one transcript row', async () => {
    const { state, vt } = await mountFullscreen(7);
    const entry: TranscriptEntry = {
      id: 'user',
      kind: 'user',
      renderMode: 'plain',
      content: 'question',
    };
    const message = new UserMessageComponent(entry.content);
    markTranscriptComponent(message, entry);
    state.transcriptContainer.addChild(message);
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 30 }, (_, i) => `body ${i + 1}`).join('\n'), 0, 0),
    );
    state.ui.requestRender();
    await vt.waitForRender();
    expect(pillLines(state)).toHaveLength(1);

    vt.resize(WIDTH, 4);
    await vt.waitForRender();
    expect(pillLines(state)).toEqual([]);
    expect(vt.getViewport()[0]).toContain('body 30');

    vt.resize(WIDTH, 7);
    await vt.waitForRender();
    expect(pillLines(state)).toHaveLength(1);
    expect(vt.getViewport()[1]).toContain('body 30');

    state.activityContainer.addChild(new Text('activity', 0, 0));
    state.ui.requestRender();
    await vt.waitForRender();
    expect(pillLines(state)).toEqual([]);
    expect(vt.getViewport()[0]).toContain('body 30');

    state.activityContainer.clear();
    state.ui.requestRender();
    await vt.waitForRender();
    expect(pillLines(state)).toHaveLength(1);
    expect(vt.getViewport()[1]).toContain('body 30');

    state.ui.stop();
  });

  it('shows three queued messages, scrolls and resets them, and gives way to an approval', async () => {
    const { state, vt } = await mountFullscreen(24);
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 40 }, (_, i) => `transcript ${String(i + 1)}`).join('\n'), 0, 0),
    );
    state.queuedMessages = Array.from({ length: 5 }, (_, i) => ({
      text: `queued ${String(i + 1)}`,
    }));
    updateQueueDisplay(state);
    state.ui.requestRender();
    await vt.waitForRender();

    let rows = screenRows(vt);
    const first = rows.findIndex((row) => row.includes('❯ queued 1'));
    expect(rows.slice(first, first + 4).map((row) => row.replace(/[┃│]$/, '').trim())).toEqual([
      '❯ queued 1',
      '❯ queued 2',
      '❯ queued 3',
      '5 queued · ↑ to edit · ctrl-s to steer immediately',
    ]);
    expect(rows[first]!.at(-1)).toBe('┃');
    expect(rows.join('\n')).toContain('test-model');

    const transcriptTop = (state.ui as TuiAltScreen).viewportTop;
    expect(transcriptTop).toBeGreaterThan(0);
    vt.sendInput(`\u001B[<64;5;${String(first + 1)}M`);
    await vt.waitForRender();
    expect(screenRows(vt)[first]).toContain('❯ queued 1');
    expect((state.ui as TuiAltScreen).viewportTop).toBe(transcriptTop);

    vt.sendInput(`\u001B[<65;5;${String(first + 1)}M`);
    vt.sendInput(`\u001B[<65;5;${String(first + 1)}M`);
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[first]).toContain('❯ queued 3');
    expect(rows[first + 2]).toContain('❯ queued 5');

    state.queuedMessages = [];
    updateQueueDisplay(state);
    state.queuedMessages = Array.from({ length: 5 }, (_, i) => ({
      text: `queued ${String(i + 1)}`,
    }));
    updateQueueDisplay(state);
    state.ui.requestRender();
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[first]).toContain('❯ queued 1');
    expect(rows[first + 2]).toContain('❯ queued 3');

    state.livePane.pendingApproval = pendingApproval();
    state.ui.requestRender();
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows.join('\n')).not.toContain('queued');
    expect(rows.join('\n')).not.toContain('test-model');

    state.ui.stop();
  });

  it('caps and scrolls Updates, resets on a new page, and folds during an approval', async () => {
    const { state, vt } = await mountFullscreen(24);
    state.notifyPanel.upsert({
      id: 'n1',
      agentId: 'main',
      time: 0,
      title: 'Running the test suite',
      text: Array.from({ length: 9 }, (_, i) => `- body ${String(i + 1)}`).join('\n'),
    });
    state.notifyPanelContainer.addChild(state.notifyPanel);
    state.ui.requestRender();
    await vt.waitForRender();

    let rows = screenRows(vt);
    const head = rows.findIndex((row) => row.includes('main · ctrl+n to browse'));
    expect(rows[head]).toContain('ctrl+n to browse');
    expect(rows[head + 1]).toContain('Running the test suite');
    expect(rows[head + 6]).toContain('body 5');
    expect(rows[head + 7]).not.toContain('body 6');
    expect(rows[head + 1]!.at(-1)).toBe('┃');

    vt.sendInput(`\u001B[<65;5;${String(head + 3)}M`);
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[head + 1]).toContain('body 1');
    expect(rows[head + 6]).toContain('body 6');

    state.ui.setFocus(state.notifyPanel);
    vt.sendInput('\u001B[B');
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[head + 1]).toContain('body 2');
    expect(rows[head + 6]).toContain('body 7');
    expect(state.notifyPanel.focused).toBe(true);
    state.ui.setFocus(state.editor);

    state.notifyPanel.upsert({
      id: 'n2',
      agentId: 'main',
      time: 1,
      title: 'Next update',
      text: Array.from({ length: 9 }, (_, i) => `- next body ${String(i + 1)}`).join('\n'),
    });
    state.ui.requestRender();
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[head]).toContain('main < 2/2 >');
    expect(rows[head + 1]).toContain('Next update');
    expect(rows[head + 2]).toContain('next body 1');

    state.livePane.pendingApproval = pendingApproval();
    state.notifyPanel.setPrompt(true);
    state.ui.requestRender();
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows.filter((row) => row.includes('Next update'))).toEqual([
      '  ▸ main · 2 updates · Next update · ctrl+n to expand',
    ]);
    expect(rows.join('\n')).not.toContain('next body 1');

    const collapsedHead = rows.findIndex((row) => row.includes('2 updates'));
    const expandColumn = rows[collapsedHead]!.indexOf('2 updates') + 1;
    vt.sendInput(`\u001B[<0;${String(expandColumn)};${String(collapsedHead + 1)}M`);
    vt.sendInput(`\u001B[<0;${String(expandColumn)};${String(collapsedHead + 1)}m`);
    await vt.waitForRender();
    rows = screenRows(vt);
    const expandedHead = rows.findIndex((row) => row.includes('main < 2/2 >'));
    expect(rows[expandedHead + 1]).toContain('Next update');
    expect(rows[expandedHead + 2]).toContain('next body 1');
    expect(state.notifyPanel.focused).toBe(true);
    expect(state.editor.focused).toBe(false);

    state.ui.setFocus(state.editor);
    state.ui.requestRender();
    await vt.waitForRender();
    expect(screenRows(vt).filter((row) => row.includes('Next update'))).toHaveLength(1);

    state.ui.stop();
  });

  it('keeps a long approval\'s choices on screen and scrolls its request with Shift+↓', async () => {
    const { state, vt } = await mountFullscreen(24);
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 40 }, (_, i) => `transcript ${String(i + 1)}`).join('\n'), 0, 0),
    );
    const pending = pendingApproval();
    pending.data.display = [
      {
        type: 'shell',
        language: 'bash',
        command: Array.from({ length: 30 }, (_, i) => `echo step ${String(i + 1)}`).join('\n'),
      },
    ];
    pending.data.choices = [
      { label: 'Approve once', response: 'approved' },
      { label: 'Reject', response: 'rejected' },
    ];
    const panel = new ApprovalPanelComponent(pending, () => {}, undefined, undefined, {
      layout: { maxBodyRows: 6 },
    });
    state.livePane.pendingApproval = pending;
    setEditorSlot(state, panel);
    state.ui.setFocus(panel);
    state.ui.requestRender();
    await vt.waitForRender();

    let rows = screenRows(vt);
    const title = rows.findIndex((row) => row.includes('Run this command?'));
    expect(rows.slice(title + 2, title + 8).map((row) => row.replace(/[┃│]$/, '').trim())).toEqual([
      '$ echo step 1',
      '· echo step 2',
      '· echo step 3',
      '· echo step 4',
      '· echo step 5',
      '· echo step 6',
    ]);
    expect(rows.slice(-5).map((row) => row.trim())).toEqual([
      '▶ 1. Approve once',
      '2. Reject',
      '',
      '↑/↓ select · 1/2 choose · ↵ confirm · shift+↑/↓ scroll',
      '─'.repeat(WIDTH - CHROME_GUTTER * 2),
    ]);

    const transcriptTop = (state.ui as TuiAltScreen).viewportTop;
    expect(transcriptTop).toBeGreaterThan(0);
    vt.sendInput(`\u001B[<64;5;${String(title + 3)}M`);
    await vt.waitForRender();
    expect(screenRows(vt)[title + 2]).toContain('$ echo step 1');
    expect((state.ui as TuiAltScreen).viewportTop).toBe(transcriptTop);

    vt.sendInput('\u001B[1;2B');
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[title + 2]).toContain('· echo step 2');

    setEditorSlot(state, state.editor);
    state.livePane.pendingApproval = null;
    state.ui.setFocus(state.editor);
    state.ui.requestRender();
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows.join('\n')).not.toContain('Run this command?');
    expect(rows.join('\n')).toContain('test-model');

    state.ui.stop();
  });

  it('docks the local goal start prompt and keeps its choices and hint visible', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    currentTheme.setTerminalBackground('#282C34');
    onTestFinished(() => {
      currentTheme.setTerminalBackground(undefined);
      vi.useRealTimers();
    });
    const { state, vt } = await mountFullscreen(24);
    vt.resize(80, 24);
    const onSelect = vi.fn();
    const panel = new GoalStartPermissionPromptComponent({
      mode: 'manual',
      onSelect,
      onCancel: vi.fn(),
      layout: { maxBodyRows: 6 },
    });
    setEditorSlot(state, panel);
    state.ui.setFocus(panel);
    state.ui.requestRender();
    await vt.waitForRender();

    let rows = screenRows(vt);
    const secondChoice = rows.findIndex((row) => row.includes('Switch to Ask When Needed and start'));
    expect(secondChoice).toBeGreaterThan(0);
    expect(rows.join('\n')).toContain('Start in Always Ask');
    expect(rows.join('\n')).toContain('Do not start');
    expect(rows.join('\n')).toContain('↑↓ navigate · Enter select · Esc cancel');
    expect(rows.join('\n')).toContain('Best if you want Kimi Code to keep working while you are away');
    expect(rows.join('\n')).not.toContain('Tools are approved automatically. Kimi Code may still ask you questions.');

    vt.sendInput(`\u001B[<35;5;${String(secondChoice + 1)}M`);
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows.findIndex((row) => row.includes('Switch to Ask When Needed and start'))).toBe(secondChoice);
    expect(rows[secondChoice - 1]).toContain('❯ Switch to Never Ask and start');
    expect(rows.join('\n')).toContain('Tools are approved automatically. Kimi Code may still ask you questions.');
    expect(rows.join('\n')).not.toContain('Best if you want Kimi Code to keep working while you are away');

    vt.sendInput(`\u001B[<0;5;${String(secondChoice + 1)}M`);
    vt.sendInput(`\u001B[<0;5;${String(secondChoice + 1)}m`);
    await vt.waitForRender();
    expect(onSelect).not.toHaveBeenCalled();

    vi.setSystemTime(10_300);
    vt.sendInput(`\u001B[<0;5;${String(secondChoice + 1)}M`);
    vt.sendInput(`\u001B[<0;5;${String(secondChoice + 1)}m`);
    await vt.waitForRender();
    expect(onSelect).toHaveBeenCalledWith('yolo');

    state.ui.stop();
  });

  it('treats the local goal prompt as blocking and restores Updates on cancel', async () => {
    const { state, vt } = await mountFullscreen(24);
    onTestFinished(() => state.ui.stop());
    const notifications = new NotifyController(state);
    notifications.setEnabled(true);
    state.notifyPanel.upsert({
      id: 'n1',
      agentId: 'main',
      time: 0,
      title: 'Reading updates',
      text: 'detailed update body',
    });
    state.notifyPanelContainer.addChild(state.notifyPanel);
    expect(notifications.focusPanel()).toBe(true);
    state.notifyPanel.setEnded(true);
    state.ui.setFocus(state.editor);
    state.ui.requestRender();
    await vt.waitForRender();
    expect(screenRows(vt).join('\n')).toContain('detailed update body');

    const host = {
      state,
      session: {},
      surveyController: { notifyDisplaced: () => {} },
      disposeEditorReplacement() {},
      modelMigration: { retry: () => {} },
      showError: vi.fn(),
      showStatus: vi.fn(),
      showNotice: vi.fn(),
      track: vi.fn(),
      sendNormalUserInput: vi.fn(),
      mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void) {
        KimiTUI.prototype.mountEditorReplacement.call(host, panel, onDisplaced);
      },
      restoreEditor() {
        KimiTUI.prototype.restoreEditor.call(host);
      },
      restoreInputText() {
        KimiTUI.prototype.restoreEditor.call(host);
      },
    } as unknown as SlashCommandHost;
    await handleGoalCommand(host, 'Ship feature X');
    await vt.waitForRender();

    let rows = screenRows(vt).join('\n');
    expect(rows).toContain('Do not start');
    expect(rows).toContain('ctrl+n to expand');
    expect(rows).not.toContain('detailed update body');
    expect(rows).not.toContain('test-model');
    expect(isBlockingPromptPending(state)).toBe(true);

    editorSlotComponent(state)?.handleInput?.('\u001B');
    await vt.waitForRender();
    rows = screenRows(vt).join('\n');
    expect(isBlockingPromptPending(state)).toBe(false);
    expect(rows).toContain('detailed update body');
    expect(rows).toContain('test-model');
  });

  it('keeps Settings usable with pointer selection, wheel paging, and focus loss at 24 rows', async () => {
    const { state, vt } = await mountFullscreen(24);
    vt.resize(80, 24);
    const picker = new SettingsSelectorComponent({ onSelect: vi.fn(), onCancel: vi.fn() });
    setEditorSlot(state, picker);
    state.ui.setFocus(picker);
    state.ui.requestRender();
    await vt.waitForRender();

    let rows = screenRows(vt);
    expect(rows.join('\n')).toContain('Settings');
    expect(rows.join('\n')).toContain('Page 1/2');
    const permissionRow = rows.findIndex((row) => row.includes('Permission'));
    expect(permissionRow).toBeGreaterThan(0);

    vt.sendInput(`\u001B[<35;5;${String(permissionRow + 1)}M`);
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows[permissionRow]).toContain('❯ Permission');

    vt.sendInput(`\u001B[<65;5;${String(permissionRow + 1)}M`);
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows.join('\n')).toContain('Page 2/2');
    expect(rows.join('\n')).toContain('❯ Usage');

    state.ui.setFocus(state.notifyPanel);
    state.ui.requestRender();
    await vt.waitForRender();
    expect(picker.focused).toBe(false);

    state.ui.stop();
  });

  it('does not let a terminal-refocus click change or submit a ChoicePicker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const { state, vt } = await mountFullscreen(24);
    const disposeFocusTracking = installTerminalFocusTracking(state);
    onTestFinished(() => {
      disposeFocusTracking();
      state.ui.stop();
      vi.useRealTimers();
    });
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      currentValue: 'a',
      onSelect,
      onCancel: vi.fn(),
    });
    const host = {
      state,
      surveyController: { notifyDisplaced: () => {} },
      disposeEditorReplacement() {},
    } as unknown as KimiTUI;
    KimiTUI.prototype.mountEditorReplacement.call(host, picker);
    await vt.waitForRender();

    vi.setSystemTime(10_300);
    vt.sendInput(TERMINAL_FOCUS_OUT);
    vt.sendInput(TERMINAL_FOCUS_IN);
    await vt.waitForRender();
    const betaRow = screenRows(vt).findIndex((row) => row.includes('Beta'));
    expect(betaRow).toBeGreaterThan(0);
    vt.sendInput(`\u001B[<35;5;${String(betaRow + 1)}M`);
    vt.sendInput(`\u001B[<0;5;${String(betaRow + 1)}M`);
    vt.sendInput(`\u001B[<0;5;${String(betaRow + 1)}m`);
    await vt.waitForRender();

    expect(onSelect).not.toHaveBeenCalled();
    const rows = screenRows(vt).join('\n');
    expect(rows).toContain('❯ Alpha');
    expect(rows).not.toContain('❯ Beta');
  });

  it('keeps Updates expanded when Ctrl+N is followed by an editor click', async () => {
    const { state, vt } = await mountFullscreen(24);
    const notifications = new NotifyController(state);
    notifications.setEnabled(true);
    state.notifyPanel.upsert({ id: 'n1', agentId: 'main', time: 0, text: 'main update' });
    state.notifyPanel.upsert({ id: 'n2', agentId: 'agent-1', agentName: 'explore', time: 1, text: 'explore update' });
    expect(state.notifyPanel.prevChannel()).toBe(true);
    state.notifyPanelContainer.addChild(state.notifyPanel);
    state.notifyPanel.setEnded(true);
    state.ui.requestRender();
    await vt.waitForRender();

    let rows = screenRows(vt);
    expect(rows.findIndex((row) => row.includes('2 updates'))).toBeGreaterThanOrEqual(0);

    expect(notifications.focusPanel()).toBe(true);
    await vt.waitForRender();
    expect(state.editor.focused).toBe(false);
    expect(state.notifyPanel.focused).toBe(true);

    rows = screenRows(vt);
    expect(rows.findIndex((row) => row.includes('esc close'))).toBeGreaterThanOrEqual(0);
    const prompt = rows.findIndex((row) => /│\s*>/.test(row));
    vt.sendInput(`\u001B[<0;10;${String(prompt + 1)}M`);
    vt.sendInput(`\u001B[<0;10;${String(prompt + 1)}m`);
    await vt.waitForRender();
    expect(state.editor.focused).toBe(true);
    expect(state.notifyPanel.focused).toBe(false);
    rows = screenRows(vt);
    const expandedHead = rows.findIndex((row) => row.includes('ctrl+n to browse'));
    expect(expandedHead).toBeGreaterThanOrEqual(0);
    expect(rows[expandedHead + 1]).toContain('main update');

    state.ui.stop();
  });

  it('lets an approval wait faded while Updates is read, and hands the keyboard over and back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { state, vt } = await mountFullscreen(40);
    const host = {
      state,
      surveyController: { notifyDisplaced: () => {} },
      disposeEditorReplacement() {},
      modelMigration: { retry: () => {} },
    } as unknown as KimiTUI;
    const notifications = new NotifyController(state);
    notifications.setEnabled(true);
    state.notifyPanel.upsert({ id: 'n1', agentId: 'main', time: 0, title: 'Running the tests', text: 'main body' });
    state.notifyPanel.upsert({ id: 'n2', agentId: 'agent-1', agentName: 'coder', time: 1, text: 'coder body' });
    expect(state.notifyPanel.prevChannel()).toBe(true);
    state.notifyPanelContainer.addChild(state.notifyPanel);
    expect(notifications.focusPanel()).toBe(true);
    await vt.waitForRender();

    const responses: unknown[] = [];
    const pending = pendingApproval();
    pending.data.choices = [
      { label: 'Approve once', response: 'approved' },
      { label: 'Reject', response: 'rejected' },
    ];
    const panel = new ApprovalPanelComponent(pending, (response) => responses.push(response), undefined, undefined, {
      layout: { maxBodyRows: 6 },
      onFocusUpdates: () => notifications.focusPanel(),
    });
    state.livePane.pendingApproval = pending;
    notifications.setPrompt(true);
    KimiTUI.prototype.mountEditorReplacement.call(host, panel);
    await vt.waitForRender();

    let rows = screenRows(vt);
    expect(state.notifyPanel.focused).toBe(true);
    expect(rows.join('\n')).toContain('main body');
    expect(rows.join('\n')).toContain('esc back to approval');
    vt.sendInput('1');
    vt.sendInput('\r');
    await vt.waitForRender();
    expect(responses).toEqual([]);
    expect(panel.focused).toBe(true);

    vt.sendInput('\u000E');
    await vt.waitForRender();
    expect(state.notifyPanel.focused).toBe(true);
    rows = screenRows(vt);
    const choice = rows.findIndex((row) => row.includes('2. Reject'));
    const click = (): void => {
      vt.sendInput(`\u001B[<0;8;${String(choice + 1)}M`);
      vt.sendInput(`\u001B[<0;8;${String(choice + 1)}m`);
    };
    vi.setSystemTime(11_000);
    click();
    await vt.waitForRender();
    expect(panel.focused).toBe(true);
    expect(responses).toEqual([]);
    expect(screenRows(vt).join('\n')).toContain('↑/↓ select');

    vt.resize(WIDTH, 24);
    await vt.waitForRender();
    rows = screenRows(vt);
    expect(rows.filter((row) => row.includes('Running the tests'))).toEqual([
      '  ▸ main · coder · 2 updates · Running the tests · ctrl+n to expand',
    ]);
    vt.sendInput('\u000E');
    await vt.waitForRender();
    expect(screenRows(vt).join('\n')).toContain('main body');
    vt.sendInput('\u001B');
    await vt.waitForRender();
    expect(panel.focused).toBe(true);
    expect(screenRows(vt).join('\n')).not.toContain('main body');

    const rejectRow = screenRows(vt).findIndex((row) => row.includes('2. Reject'));
    vt.sendInput(`\u001B[<0;8;${String(rejectRow + 1)}M`);
    vt.sendInput(`\u001B[<0;8;${String(rejectRow + 1)}m`);
    await vt.waitForRender();
    expect(responses).toEqual([{ response: 'rejected', feedback: undefined, selected_label: undefined }]);

    state.ui.stop();
  });
});
