/**
 * Fullscreen layout contract tests: the docked chrome must keep the editor's
 * full height (top border / input / bottom border) even when the transcript
 * far exceeds the screen. Regression: the dock used to participate in VStack
 * shrink distribution with no minSize, so a tall transcript crushed it and
 * the editor's bottom border row was clipped off screen.
 */
import { describe, expect, it } from 'vitest';

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
import type { AppState, TranscriptEntry } from '#/tui/types';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';

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

async function mountFullscreen(): Promise<{
  state: ReturnType<typeof createTUIState>;
  vt: VirtualTerminal;
}> {
  const opts: KimiTUIOptions = {
    initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  };
  const state = createTUIState(opts);
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

  it('pins the scrolled-past user message above the transcript and keeps it pinned on click jump', async () => {
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
    // The first frame's layout pass is what pulls the follow-end scroll to the
    // bottom; the sticky judgment reads it on the next frame.
    state.ui.requestRender();
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

    // Top of the transcript: no candidate, no pill, no slot row.
    alt.scrollToTop();
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(0);
    expect(topRow()).not.toContain('❯ 第一轮问题');

    // scrollTop lands on the message's first content line: the message itself
    // sits at the top of the screen — no pill, no blank slot row above it.
    alt.scrollBy(1);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(1);
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
    // Invisible landing: the jump targets one line past the message's first
    // content line, so the pill stays pinned with the same text.
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
    state.ui.requestRender();
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    const topRow = () => stripAnsi(vt.getViewport()[0] ?? '').trim();

    // Following at the bottom: the whole message scrolled out — full merge.
    expect(topRow()).toBe('❯ 第一行 第二行 第三行');

    alt.scrollToTop();
    await vt.waitForRender();
    expect(topRow()).not.toContain('❯');

    alt.scrollBy(2); // the first content line is out
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行');

    alt.scrollBy(1); // the second line joins the pill
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行 第二行');

    alt.scrollBy(1); // the third line joins — the whole message is merged
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行 第二行 第三行');

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
    state.ui.requestRender();
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

    alt.scrollBy(2); // only the spacer and the two leading blank lines are out
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(2);
    expect(topRow()).not.toContain('第一行');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1); // the message's own first text line sits at the top: still no pill
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(3);
    expect(topRow()).toContain('第一行');
    expect(topRow()).not.toContain('❯');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1); // the first text line is out: the pill takes over
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(4);
    expect(topRow()).toBe('❯ 第一行');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1); // the second line joins the pill
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(5);
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
    // First layout pass establishes the follow-end scroll position; the sticky
    // judgment reads it on the next frame.
    state.ui.requestRender();
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
    expect(topRow()).not.toContain('❯');
    expect(countRows('第一轮问题')).toBe(1);

    state.ui.stop();
  });
});
