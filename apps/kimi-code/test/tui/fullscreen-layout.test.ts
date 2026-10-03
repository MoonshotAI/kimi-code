import {
  Spacer,
  Text,
  VStack,
  ScrollView,
  type Component,
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
import { describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StatusMessageComponent } from '#/tui/components/messages/status-message';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import * as userMessages from '#/tui/components/messages/user-message';
import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import type { AppState, TranscriptEntry } from '#/tui/types';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';
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
});
