import {
  Spacer,
  Text,
  VStack,
  ScrollView,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type Terminal,
  type TUI,
  TuiAltScreen,
} from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import { showSettingsSelector } from '#/tui/commands/config';
import { handleGoalCommand } from '#/tui/commands/goal';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import { PlanBoxComponent } from '#/tui/components/messages/plan-box';
import { WorktreeProgressComponent } from '#/tui/components/messages/worktree-progress';
import { UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { NoticeMessageComponent, StatusMessageComponent } from '#/tui/components/messages/status-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import * as userMessages from '#/tui/components/messages/user-message';
import { ActivityPaneComponent } from '#/tui/components/panes/activity-pane';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { createTUIState, KimiTUI, type KimiTUIOptions, type KimiTUIStartupInput } from '#/tui/kimi-tui';
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
import { darkColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { AppState, TranscriptEntry } from '#/tui/types';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';
import {
  installTerminalFocusTracking,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/utils/terminal-focus';
import { markTranscriptComponent } from '#/tui/utils/transcript-component-metadata';
import { TurnTimeline } from '#/tui/utils/turn-timeline';

import { VirtualTerminal } from '../../../../packages/pi-tui/test/virtual-terminal';

const clipboardText = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn<(text: string) => Promise<'native' | 'osc52'>>(async () => 'native'),
  readClipboardText: vi.fn<() => Promise<string>>(async () => ''),
}));
vi.mock('#/utils/clipboard/clipboard-text', () => clipboardText);
vi.mock('#/utils/clipboard/clipboard-native', () => ({ clipboard: null }));

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
    transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

function stripAnsi(s: string): string {
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
  state.transcriptContainer.setPresentationOptions({ fullscreen: true, toolCallDensity: 'compact', thinking: 'grouped' });
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

function highlightedText(line: string): string[] {
  return [...line.matchAll(/\u001B\[7m([\s\S]*?)\u001B\[27m/g)].map((match) => stripAnsi(match[1]!));
}

function editorReplacementHost(state: ReturnType<typeof createTUIState>): SlashCommandHost {
  const host = {
    state,
    surveyController: { notifyDisplaced: () => {} },
    disposeEditorReplacement() {},
    modelMigration: { retry: () => {} },
    mountEditorReplacement(panel: Component & Focusable) {
      KimiTUI.prototype.mountEditorReplacement.call(host, panel);
    },
    restoreEditor() {
      KimiTUI.prototype.restoreEditor.call(host);
    },
  } as unknown as SlashCommandHost;
  return host;
}

function updateQueueDisplay(state: ReturnType<typeof createTUIState>): void {
  const host = {
    state,
    deferUserMessages: false,
    isSteeringQueuedMessages: () => false,
    promptPredictionController: {},
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

function pillLines(state: ReturnType<typeof createTUIState>): readonly string[] {
  const root = (state.ui as TuiAltScreen).getLayoutRoot() as VStack;
  const transcript = root.children[0] as VStack;
  return transcript.children[0]!.render(state.ui.terminal.columns);
}

function groupTranscript(state: ReturnType<typeof createTUIState>): void {
  const view = state.transcriptView;
  if (view === undefined) throw new Error('transcript view missing');
  state.transcriptContainer.setPresentationOptions({ fullscreen: true, toolCallDensity: 'compact', thinking: 'grouped' });
  state.transcriptContainer.setHost({
    withScrollAnchor: (toggle) => {
      view.withAnchoredScroll(toggle);
    },
    withBottomAnchor: (toggle, removedLines) => {
      view.withBottomAnchor(toggle, removedLines);
    },
    viewportRows: () => view.viewportRows,
    track: () => {},
    foldingChanged: () => {},
  });
}

function addReadGroup(state: ReturnType<typeof createTUIState>): void {
  const thinking = new ThinkingComponent('reasoning', true, 'finalized');
  thinking.finalize({ known: true, ms: 3000 });
  state.transcriptContainer.addChild(thinking);
  for (let i = 0; i < 6; i++) {
    state.transcriptContainer.addChild(
      new ToolCallComponent(
        { id: `read-${i}`, name: 'Read', args: { path: `/work/file-${i}.ts` } },
        { tool_call_id: `read-${i}`, output: 'content', is_error: false },
        undefined,
        '/work',
      ),
    );
  }
}

interface ActivityDockDriver {
  readonly state: ReturnType<typeof createTUIState>;
  readonly sessionEventHandler: {
    handleEvent(event: Record<string, unknown>, sendQueued: () => void): void;
  };
  updateActivityPane(): void;
  beginSessionRequest(): void;
}

function mountFullscreenKimiTui(): { driver: ActivityDockDriver; vt: VirtualTerminal } {
  const input: KimiTUIStartupInput = {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      environment: undefined,
    },
    tuiConfig: {
      theme: 'dark',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
      tuiMode: 'fullscreen',
    },
    version: '0.0.0-test',
    workDir: '/tmp/kimi-test',
  };
  const driver = new KimiTUI(
    { onConfigSectionChanged: () => () => {} } as never,
    input,
  ) as unknown as ActivityDockDriver;
  const { state } = driver;
  vi.spyOn(state.terminal, 'setProgress').mockImplementation(() => {});
  const vt = new VirtualTerminal(WIDTH, HEIGHT);
  (state.ui as { terminal: Terminal }).terminal = vt;
  mountFooter(state);
  state.editorContainer.addChild(state.editor);
  state.ui.setFocus(state.editor);
  state.ui.start();
  return { driver, vt };
}

async function clickRow(vt: VirtualTerminal, row: number): Promise<void> {
  vt.sendInput(`\u001B[<0;5;${row + 1}M`);
  vt.sendInput(`\u001B[<0;5;${row + 1}m`);
  await vt.waitForRender();
}

function rightClick(vt: VirtualTerminal, column: number, row: number): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const termProgram = process.env['TERM_PROGRAM'];
  if (!platform) throw new Error('process.platform descriptor missing');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  delete process.env['TERM_PROGRAM'];
  try {
    vt.sendInput(`\u001B[<2;${column + 1};${row + 1}M`);
    vt.sendInput(`\u001B[<2;${column + 1};${row + 1}m`);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (termProgram === undefined) delete process.env['TERM_PROGRAM'];
    else process.env['TERM_PROGRAM'] = termProgram;
  }
}

async function copyComponentSelection(
  component: Component,
  width: number,
  select?: (rows: string[]) => { start: number; end: number },
  startText?: string,
): Promise<string | undefined> {
  const height = Math.max(1, component.render(width).length);
  const vt = new VirtualTerminal(width, height);
  let copied: string | undefined;
  const ui = new TuiAltScreen(vt, undefined, undefined, {
    copySelection: async (text) => {
      copied = text;
      return true;
    },
  });
  ui.addChild(component);
  ui.start();
  try {
    await vt.waitForRender();
    const rows = vt.getViewport().map((row) => stripAnsi(row));
    const range = select?.(rows) ?? {
      start: rows.findIndex((row) => row.trim().length > 0),
      end: rows.findLastIndex((row) => row.trim().length > 0),
    };
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeGreaterThanOrEqual(range.start);
    const startColumn = startText === undefined ? 0 : rows[range.start]!.indexOf(startText);
    expect(startColumn).toBeGreaterThanOrEqual(0);
    vt.sendInput(`\u001B[<0;${startColumn + 1};${range.start + 1}M`);
    vt.sendInput(`\u001B[<32;${width};${range.end + 1}M`);
    vt.sendInput(`\u001B[<0;${width};${range.end + 1}m`);
    await vt.waitForRender();
    return copied;
  } finally {
    ui.stop();
  }
}

async function copyComponentTripleClick(component: Component, width: number): Promise<string | undefined> {
  const height = Math.max(1, component.render(width).length);
  const vt = new VirtualTerminal(width, height);
  let copied: string | undefined;
  const ui = new TuiAltScreen(vt, undefined, undefined, {
    copySelection: async (text) => {
      copied = text;
      return true;
    },
  });
  ui.addChild(component);
  ui.start();
  try {
    await vt.waitForRender();
    const rows = vt.getViewport().map((row) => stripAnsi(row));
    const row = rows.findIndex((line) => line.includes('S'));
    expect(row).toBeGreaterThanOrEqual(0);
    const column = Math.max(0, rows[row]!.indexOf('S'));
    for (let click = 0; click < 3; click++) {
      vt.sendInput(`\u001B[<0;${column + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${column + 1};${row + 1}m`);
    }
    await vt.waitForRender();
    return copied;
  } finally {
    ui.stop();
  }
}

async function expectComponentCopyGestures(
  component: Component,
  width: number,
  expected: string,
  select: (rows: string[]) => { start: number; end: number } = logicalLineRange,
  startText?: string,
): Promise<void> {
  await expect(copyComponentSelection(component, width, select, startText)).resolves.toBe(expected);
  await expect(copyComponentTripleClick(component, width)).resolves.toBe(expected);
}

function logicalLineRange(rows: string[]): { start: number; end: number } {
  const range = {
    start: rows.findIndex((row) => row.includes('S')),
    end: rows.findIndex((row) => row.includes('D')),
  };
  expect(range.start).toBeGreaterThanOrEqual(0);
  expect(range.end).toBeGreaterThan(range.start);
  return range;
}

const CLIPBOARD_READ_ERROR = "Clipboard paste unavailable: use your terminal's paste shortcut";

async function startRightClickPasteAfterOsc52Copy(
  read: () => Promise<string>,
): Promise<{ state: ReturnType<typeof createTUIState>; vt: VirtualTerminal }> {
  clipboardText.copyTextToClipboard.mockImplementationOnce(async () => 'osc52');
  clipboardText.readClipboardText.mockClear();
  clipboardText.readClipboardText.mockImplementationOnce(read);
  const { state, vt } = await mountFullscreen();
  const alt = state.ui as TuiAltScreen;
  alt.setCopyOnSelect(false);
  alt.setCopyOnRightClick(true);
  try {
    state.transcriptContainer.addChild(new Text('hello world', 0, 0));
    alt.renderNow();
    await vt.flush();
    const row = screenRows(vt).findIndex((line) => line.includes('hello world'));
    const col = screenRows(vt)[row]!.indexOf('hello world');
    vt.sendInput(`\u001B[<0;${col + 1};${row + 1}M`);
    vt.sendInput(`\u001B[<32;${col + 11};${row + 1}M`);
    vt.sendInput(`\u001B[<0;${col + 11};${row + 1}m`);
    vt.sendInput(`\u001B[<2;${col + 11};${row + 1}M`);
    vt.sendInput(`\u001B[<2;${col + 11};${row + 1}m`);
    await vi.waitFor(() => {
      expect(alt.hasActiveSelection()).toBe(false);
    });
    vt.sendInput(`\u001B[<2;${col + 11};${row + 1}M`);
    vt.sendInput(`\u001B[<2;${col + 11};${row + 1}m`);
    return { state, vt };
  } catch (error) {
    state.ui.stop();
    throw error;
  }
}

describe('fullscreen layout', () => {
  it.each([
    ['a native copy', () => Promise.resolve('native' as const), 'Copied!'],
    ['an unverified OSC 52 copy', () => Promise.resolve('osc52' as const), 'Copied via terminal'],
    [
      'a failed copy',
      () => Promise.reject(new Error('Clipboard unavailable: install `xclip` or `xsel`, or check X11 access')),
      'Clipboard unavailable: install `xclip` or `xsel`',
    ],
  ])('copies a dragged selection through the app clipboard and flashes %s', async (_name, copy, flash) => {
    clipboardText.copyTextToClipboard.mockImplementationOnce(copy);
    const { state, vt } = await mountFullscreen();
    state.transcriptContainer.addChild(new Text('hello world', 0, 0));
    (state.ui as TuiAltScreen).renderNow();
    await vt.flush();
    const row = screenRows(vt).findIndex((line) => line.includes('hello world'));
    const col = screenRows(vt)[row]!.indexOf('hello world');

    vt.sendInput(`\u001B[<0;${col + 1};${row + 1}M`);
    vt.sendInput(`\u001B[<32;${col + 11};${row + 1}M`);
    vt.sendInput(`\u001B[<0;${col + 11};${row + 1}m`);

    expect((state.ui as TuiAltScreen).hasActiveSelection()).toBe(true);
    expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('hello world');
    await vi.waitFor(() => {
      expect(screenRows(vt).join('\n')).toContain(flash);
    });
    state.ui.stop();
  });

  it('pastes readable clipboard text after an OSC 52 right-click copy', async () => {
    const { state } = await startRightClickPasteAfterOsc52Copy(async () => 'clipboard text');
    try {
      await vi.waitFor(() => {
        expect(state.editor.getText()).toBe('clipboard text');
      });
      expect(clipboardText.readClipboardText).toHaveBeenCalledTimes(1);
    } finally {
      state.ui.stop();
    }
  });

  it('shows an unreadable clipboard error after an OSC 52 right-click copy', async () => {
    const { state, vt } = await startRightClickPasteAfterOsc52Copy(() =>
      Promise.reject(new Error(CLIPBOARD_READ_ERROR)),
    );
    try {
      await vi.waitFor(() => {
        expect(screenRows(vt).join('\n')).toContain(CLIPBOARD_READ_ERROR);
      });
      expect(clipboardText.readClipboardText).toHaveBeenCalledTimes(1);
      expect(state.editor.getText()).toBe('');
    } finally {
      state.ui.stop();
    }
  });

  it.each([
    ['user', 'alpha\nbeta', () => new UserMessageComponent('alpha\nbeta')],
    [
      'assistant',
      'alpha\n\nbeta',
      () => {
        const component = new AssistantMessageComponent();
        component.updateContent('alpha\n\nbeta');
        return component;
      },
    ],
  ])('omits %s message decorations when copying across visual rows', async (_name, expected, createComponent) => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      state.transcriptContainer.addChild(createComponent());
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('alpha'));
      const lastRow = rows.findIndex((row) => row.includes('beta'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      const firstColumn = rows[firstRow]!.indexOf('alpha');
      const lastColumn = rows[lastRow]!.lastIndexOf('beta') + 3;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);

      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith(expected);
      });
      expect(vt.getViewport()[firstRow]).not.toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*[●❯]/);
    } finally {
      state.ui.stop();
    }
  });

  it('shows selected transcript newlines without changing the editor focus or cursor', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      const source = 'alpha\nbeta\n\ngamma';
      state.transcriptContainer.addChild(new UserMessageComponent(source));
      state.editor.setText('bottom\ndraft');
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('alpha'));
      const secondRow = rows.findIndex((row) => row.includes('beta'));
      const emptyRow = secondRow + 1;
      const lastRow = rows.findIndex((row) => row.includes('gamma'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(secondRow).toBe(firstRow + 1);
      expect(rows[emptyRow]?.trim()).toBe('');
      expect(lastRow).toBe(emptyRow + 1);
      const firstColumn = rows[firstRow]!.indexOf('alpha');
      const lastColumn = rows[lastRow]!.indexOf('gamma') + 'gamma'.length - 1;
      const editorCursor = state.editor.getCursor();
      const terminalCursor = vt.getCursorPosition();
      expect(alt.getFocusedComponent()).toBe(state.editor);
      expect(state.editor.focused).toBe(true);

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);
      await vt.waitForRender();

      expect(highlightedText(alt.getScreenLines()[firstRow]!).join('')).toBe('alpha ');
      expect(highlightedText(alt.getScreenLines()[secondRow]!).join('')).toBe('beta ');
      const emptyLine = alt.getScreenLines()[emptyRow]!;
      expect(highlightedText(emptyLine).join('')).toBe(' ');
      const emptyHighlight = emptyLine.indexOf('\u001B[7m');
      expect(emptyHighlight).toBeGreaterThanOrEqual(0);
      expect(stripAnsi(emptyLine.slice(0, emptyHighlight))).toHaveLength(firstColumn);
      expect(highlightedText(alt.getScreenLines()[lastRow]!).join('')).toBe('gamma');
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith(source);
      expect(state.editor.getText()).toBe('bottom\ndraft');
      expect(state.editor.getCursor()).toEqual(editorCursor);
      expect(alt.getFocusedComponent()).toBe(state.editor);
      expect(state.editor.focused).toBe(true);
      expect(vt.getCursorPosition()).toEqual(terminalCursor);
    } finally {
      state.ui.stop();
    }
  });

  it.each([1, 2, 3, 4, 20])(
    'copies status text without responsive padding at width %i',
    async (width) => {
      await expect(copyComponentSelection(new StatusMessageComponent('abcd'), width)).resolves.toBe('abcd');
    },
  );

  it('copies CJK status text without deleting visible glyphs', async () => {
    await expect(copyComponentSelection(new StatusMessageComponent('中文'), 4)).resolves.toBe('中文');
  });

  it.each([4, 20])('copies notice title and detail at width %i', async (width) => {
    await expect(
      copyComponentSelection(new NoticeMessageComponent('abcd', 'efgh'), width),
    ).resolves.toBe('abcd\nefgh');
  });

  it('does not remove tool header text when the header has no bullet', async () => {
    const component = new ToolCallComponent(
      { id: 'call_plan_copy', name: 'ExitPlanMode', args: {} },
      undefined,
    );
    try {
      await expect(copyComponentSelection(component, 20)).resolves.toBe('Current plan');
    } finally {
      component.dispose();
    }
  });

  it.each([4, 20])('copies tool progress without responsive padding at width %i', async (width) => {
    const component = new ToolCallComponent(
      { id: 'call_progress_copy', name: 'Read', args: { path: 'x' } },
      undefined,
    );
    component.appendProgress('abcd');
    try {
      const copied = await copyComponentSelection(component, width, (rows) => ({
        start: rows.findIndex((row) => row.includes(width === 4 ? 'ab' : 'abcd')),
        end: rows.findIndex((row) => row.includes(width === 4 ? 'cd' : 'abcd')),
      }));
      expect(copied).toBe('abcd');
    } finally {
      component.dispose();
    }
  });

  it.each([8, 120])('copies every agent description fragment at width %i', async (width) => {
    const agent = new ToolCallComponent(
      { id: 'call_agent_copy', name: 'Agent', args: { description: 'abcd' } },
      undefined,
    );
    agent.onSubagentSpawned({ agentId: 'sub_agent_copy', agentName: 'coder', runInBackground: false });
    agent.onSubagentStarted({ agentId: 'sub_agent_copy', agentName: 'coder', runInBackground: false });
    agent.onSubagentCompleted({ resultSummary: 'done' });
    const group = new AgentGroupComponent(undefined);
    group.attach('call_agent_copy', agent);
    try {
      const copied = await copyComponentSelection(group, width, (rows) => ({
        start: rows.findIndex((row) => row.includes('└─')),
        end: rows.length - 1,
      }));
      expect(copied).toBe('└─ coder · abcd · 0 tools · 0s · ✓ Completed');
    } finally {
      group.dispose();
      agent.dispose();
    }
  });

  it.each([8, 120])('copies every grouped read path fragment at width %i', async (width) => {
    const tool = new ToolCallComponent(
      { id: 'call_read_copy', name: 'Read', args: { path: 'src/abcd.ts' } },
      { tool_call_id: 'call_read_copy', output: '1\tline', is_error: false },
    );
    const group = new ReadGroupComponent(undefined);
    group.attach('call_read_copy', tool);
    group.setExpanded(true);
    try {
      const copied = await copyComponentSelection(group, width, (rows) => ({
        start: rows.findIndex((row) => row.includes('└─')),
        end: rows.length - 1,
      }));
      expect(copied).toBe('└─ src/abcd.ts · 1 line');
    } finally {
      group.dispose();
      tool.dispose();
    }
  });

  it.each([2, 4, 20])('copies bare group detail without losing columns at width %i', async (width) => {
    const { state } = await mountFullscreen();
    const source = `START${'x'.repeat(30)}END`;
    const tool = new ToolCallComponent(
      { id: `bare-${width}`, name: 'Read', args: { path: '/work/a.ts' } },
      { tool_call_id: `bare-${width}`, output: source, is_error: false },
    );
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(tool);
      state.transcriptContainer.toggleToolOutputExpansion();
      await expect(
        copyComponentSelection(state.transcriptContainer, width, logicalLineRange, 'S'),
      ).resolves.toBe(source);
    } finally {
      tool.dispose();
      state.ui.stop();
    }
  });

  it.each([
    { name: 'an independent row', tools: ['CronCreate'] },
    { name: 'a single-member group', tools: ['Read'] },
    { name: 'a multi-member group', tools: ['Read', 'Read'] },
  ])('copies a soft-wrapped logical line from $name', async ({ tools }) => {
    const { state } = await mountFullscreen();
    const source = `START${'x'.repeat(50)}END`;
    const calls = tools.map((name, index) => new ToolCallComponent(
      { id: `wrapped-${name}-${index}`, name, args: name === 'Read' ? { path: `/work/${index}.ts` } : {} },
      {
        tool_call_id: `wrapped-${name}-${index}`,
        output: index === 0 ? source : `OTHER${'y'.repeat(50)}DONE`,
        is_error: false,
      },
    ));
    try {
      groupTranscript(state);
      for (const call of calls) state.transcriptContainer.addChild(call);
      state.transcriptContainer.toggleToolOutputExpansion();
      const copied = await copyComponentSelection(state.transcriptContainer, 20, logicalLineRange, 'S');
      expect(copied).toBe(source);
    } finally {
      for (const call of calls) call.dispose();
      state.ui.stop();
    }
  });

  it('copies a soft-wrapped Thinking logical line without visual indentation', async () => {
    const source = `START${'x'.repeat(50)}END`;
    const thinking = new ThinkingComponent(source, true, 'finalized');
    thinking.setExpanded(true);
    await expect(copyComponentSelection(thinking, 20, logicalLineRange)).resolves.toBe(source);
    thinking.dispose();
  });

  it('copies a Plan logical line without visual wrapping or frame decorations', async () => {
    const source = `START${'x'.repeat(50)}END`;
    const plan = new PlanBoxComponent(source, createMarkdownTheme(), darkColors.success);

    await expectComponentCopyGestures(plan, 24, source, logicalLineRange, 'S');
  });

  it('copies a Worktree logical line without visual wrapping or generated indentation', async () => {
    const source = `START${'x'.repeat(50)}END`;
    const worktree = new WorktreeProgressComponent(() => {});
    worktree.update({ phase: 'move_failed', name: 'fix-login', sourceDir: '/tmp/project', reason: source });
    try {
      await expectComponentCopyGestures(worktree, 24, source, logicalLineRange, 'S');
    } finally {
      worktree.dispose();
    }
  });

  it('excludes only the two columns before the Status left border from selections and copies', async () => {
    const panel = new UsagePanelComponent(() => ['alpha', '', 'beta'], 'primary', ' Status ');
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      state.transcriptContainer.addChild(
        new Text(Array.from({ length: 40 }, (_, index) => `filler ${String(index)}`).join('\n'), 0, 0),
      );
      state.transcriptContainer.addChild(new StatusMessageComponent('before', 'error'));
      state.transcriptContainer.addChild(panel);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('before'));
      const lastRow = rows.findIndex((row) => row.includes('╰'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      const lastColumn = rows[lastRow]!.length - 1;

      vt.sendInput(`\u001B[<0;1;${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);
      await vt.waitForRender();

      const selectedLines = alt.getScreenLines().slice(firstRow, lastRow + 1);
      const highlights = selectedLines.flatMap((line) => highlightedText(line));
      expect(highlights.some((text) => text.startsWith('╭') && text.includes(' Status ') && text.includes('╮'))).toBe(true);
      expect(highlights.some((text) => text.startsWith('╰') && text.includes('╯'))).toBe(true);
      expect(highlights.some((text) => /^│ alpha +│/.test(text))).toBe(true);
      expect(highlights.some((text) => /^│ beta +│/.test(text))).toBe(true);
      for (const line of selectedLines) {
        const highlightColumns = [...line.matchAll(/\u001B\[7m/g)].map((match) =>
          stripAnsi(line.slice(0, match.index)).length,
        );
        expect(highlightColumns.every((column) => column >= CHROME_GUTTER)).toBe(true);
      }
      expect(highlights.every((text) => !text.startsWith('  │'))).toBe(true);

      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      const copied = clipboardText.copyTextToClipboard.mock.calls.at(-1)?.[0];
      expect(copied).toContain('before');
      expect(copied).toContain(' Status ');
      expect(copied).toMatch(/\n╭.*╮/);
      expect(copied).toMatch(/\n╰.*╯/);
      expect(copied).toMatch(/\n│ alpha +│/);
      expect(copied).toMatch(/\n│ beta +│/);
      expect(copied).not.toContain('  │ alpha');
      expect(copied).not.toContain('  │ beta');
    } finally {
      state.ui.stop();
    }
  });

  it.each([false, true])(
    'invalidates a queued editor paste on transcript click (flush before click: %s)',
    async (flushBeforeClick) => {
      const { state, vt } = await mountFullscreen();
      let resolvePaste!: (handled: boolean) => void;
      state.editor.onPasteImage = () =>
        new Promise<boolean>((resolve) => {
          resolvePaste = resolve;
        });
      state.editor.setText('alpha beta');
      state.transcriptContainer.addChild(new Text('transcript', 0, 0));
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      try {
        let rows = screenRows(vt);
        const editorRow = rows.findIndex((row) => row.includes('alpha beta'));
        const betaColumn = rows[editorRow]!.indexOf('beta');
        expect(editorRow).toBeGreaterThanOrEqual(0);
        vt.sendInput(`\u001B[<0;${betaColumn + 1};${editorRow + 1}M`);
        vt.sendInput(`\u001B[<32;${betaColumn + 4};${editorRow + 1}M`);
        vt.sendInput(`\u001B[<0;${betaColumn + 4};${editorRow + 1}m`);
        await vt.waitForRender();
        expect(alt.hasActiveSelection()).toBe(true);

        state.editor.handleInput(process.platform === 'win32' ? '\u001Bv' : '\u0016');
        vt.sendInput('\u001B[200~');
        await vt.waitForRender();
        expect(alt.hasActiveSelection()).toBe(false);
        const pasteQueueFlushed = vi.spyOn(
          state.editor as unknown as { flushPasteInputQueue(): void },
          'flushPasteInputQueue',
        );
        const flushPaste = async () => {
          resolvePaste(true);
          await vi.waitFor(() => expect(pasteQueueFlushed).toHaveBeenCalled());
        };
        if (flushBeforeClick) await flushPaste();

        rows = screenRows(vt);
        const transcriptRow = rows.findIndex((row) => row.includes('transcript'));
        const transcriptColumn = rows[transcriptRow]!.indexOf('transcript');
        expect(transcriptRow).toBeGreaterThanOrEqual(0);
        vt.sendInput(`\u001B[<0;${transcriptColumn + 1};${transcriptRow + 1}M`);
        vt.sendInput(`\u001B[<0;${transcriptColumn + 1};${transcriptRow + 1}m`);
        await vt.waitForRender();
        expect(alt.getFocusedComponent()).toBe(state.editor);
        if (!flushBeforeClick) await flushPaste();

        const beforePaste = state.editor.getText();
        const cursor = state.editor.getCursor();
        expect(beforePaste).toBe('alpha beta');
        expect(cursor.line).toBe(0);
        const expected = `${beforePaste.slice(0, cursor.col)}X${beforePaste.slice(cursor.col)}`;
        vt.sendInput('X');
        vt.sendInput('\u001B[201~');
        await vt.waitForRender();
        expect(state.editor.getText()).toBe(expected);
      } finally {
        state.ui.stop();
      }
    },
  );

  it('copies expanded Thought indentation while leaving copied blank lines empty', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const source = 'alpha\n\nbeta';
    const thinking = new ThinkingComponent(source, true, 'finalized');
    thinking.finalize({ known: true, ms: 3000 });
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(thinking);
      state.transcriptContainer.toggleGroup(thinking);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('alpha'));
      const emptyRow = firstRow + 1;
      const lastRow = rows.findIndex((row) => row.includes('beta'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBe(emptyRow + 1);
      const firstColumn = rows[firstRow]!.indexOf('alpha');
      const lastColumn = rows[lastRow]!.indexOf('beta') + 'beta'.length - 1;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);
      await vt.waitForRender();

      expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual(['alpha ']);
      const emptyLine = alt.getScreenLines()[emptyRow]!;
      expect(highlightedText(emptyLine)).toEqual([' ']);
      const emptyHighlight = emptyLine.indexOf('\u001B[7m');
      expect(emptyHighlight).toBeGreaterThanOrEqual(0);
      expect(stripAnsi(emptyLine.slice(0, emptyHighlight))).toHaveLength(firstColumn);
      expect(highlightedText(alt.getScreenLines()[lastRow]!)).toEqual(['  beta']);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('alpha\n\n  beta');
    } finally {
      state.ui.stop();
    }
  });

  it('places grouped transcript blank-line markers after the message gutter', async () => {
    const thinking = new ThinkingComponent('alpha\n\nbeta', true, 'finalized');
    thinking.finalize({ known: true, ms: 3000 });
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(new UserMessageComponent('start'));
      state.transcriptContainer.addChild(thinking);
      state.transcriptContainer.toggleGroup(thinking);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const startRow = rows.findIndex((row) => row.includes('start'));
      const titleRow = rows.findIndex((row) => row.includes('Thought for 3s'));
      const firstRow = rows.findIndex((row) => row.includes('alpha'));
      const lastRow = rows.findIndex((row) => row.includes('beta'));
      expect(startRow).toBeGreaterThanOrEqual(0);
      expect(titleRow).toBeGreaterThan(startRow);
      expect(firstRow).toBe(titleRow + 2);
      expect(lastRow).toBe(firstRow + 2);
      const blankRows = [titleRow - 1, titleRow + 1, firstRow + 1];
      for (const row of blankRows) expect(rows[row]?.trim()).toBe('');
      const startColumn = rows[startRow]!.indexOf('start');
      const contentColumn = rows[firstRow]!.indexOf('alpha');
      const lastColumn = rows[lastRow]!.indexOf('beta') + 'beta'.length - 1;

      vt.sendInput(`\u001B[<0;${startColumn + 1};${startRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);
      await vt.waitForRender();

      for (const row of blankRows) {
        const line = alt.getScreenLines()[row]!;
        expect(highlightedText(line)).toEqual([' ']);
        const highlight = line.indexOf('\u001B[7m');
        expect(highlight).toBeGreaterThanOrEqual(0);
        expect(stripAnsi(line.slice(0, highlight))).toHaveLength(contentColumn);
      }
    } finally {
      state.ui.stop();
    }
  });

  it('places an independent row blank-line marker after its status marker', async () => {
    const call = new ToolCallComponent(
      { id: 'cron-blank', name: 'CronCreate', args: { cron: '*/5 * * * *', prompt: 'check CI' } },
      { tool_call_id: 'cron-blank', output: 'created', is_error: false },
    );
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(new UserMessageComponent('start'));
      state.transcriptContainer.addChild(call);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const startRow = rows.findIndex((row) => row.includes('start'));
      const cronRow = rows.findIndex((row) => row.includes('CronCreate'));
      const blankRow = cronRow - 1;
      expect(startRow).toBeGreaterThanOrEqual(0);
      expect(cronRow).toBeGreaterThan(startRow);
      expect(rows[blankRow]?.trim()).toBe('');
      const startColumn = rows[startRow]!.indexOf('start');
      const contentColumn = rows[cronRow]!.indexOf('CronCreate');
      const lastColumn = rows[cronRow]!.length - 1;

      vt.sendInput(`\u001B[<0;${startColumn + 1};${startRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${cronRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${cronRow + 1}m`);
      await vt.waitForRender();

      const line = alt.getScreenLines()[blankRow]!;
      expect(highlightedText(line)).toEqual([' ']);
      const highlight = line.indexOf('\u001B[7m');
      expect(highlight).toBeGreaterThanOrEqual(0);
      expect(stripAnsi(line.slice(0, highlight))).toHaveLength(contentColumn);
    } finally {
      call.dispose();
      state.ui.stop();
    }
  });

  it('places an agent group leading blank-line marker after its bullet', async () => {
    const agent = new ToolCallComponent(
      { id: 'call_agent_blank', name: 'Agent', args: { description: 'abcd' } },
      undefined,
    );
    agent.onSubagentSpawned({ agentId: 'sub_agent_blank', agentName: 'coder', runInBackground: false });
    agent.onSubagentStarted({ agentId: 'sub_agent_blank', agentName: 'coder', runInBackground: false });
    agent.onSubagentCompleted({ resultSummary: 'done' });
    const group = new AgentGroupComponent(undefined);
    group.attach('call_agent_blank', agent);
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(new UserMessageComponent('start'));
      state.transcriptContainer.addChild(group);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const startRow = rows.findIndex((row) => row.includes('start'));
      const headerRow = rows.findIndex((row) => row.includes('agents finished'));
      const blankRow = headerRow - 1;
      expect(startRow).toBeGreaterThanOrEqual(0);
      expect(headerRow).toBeGreaterThan(startRow);
      expect(rows[blankRow]?.trim()).toBe('');
      const startColumn = rows[startRow]!.indexOf('start');
      const contentColumn = rows[headerRow]!.indexOf('1 coder');
      const lastColumn = rows[headerRow]!.length - 1;

      vt.sendInput(`\u001B[<0;${startColumn + 1};${startRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${headerRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${headerRow + 1}m`);
      await vt.waitForRender();

      const line = alt.getScreenLines()[blankRow]!;
      expect(highlightedText(line)).toEqual([' ']);
      const highlight = line.indexOf('\u001B[7m');
      expect(highlight).toBeGreaterThanOrEqual(0);
      expect(stripAnsi(line.slice(0, highlight))).toHaveLength(contentColumn);
    } finally {
      group.dispose();
      agent.dispose();
      state.ui.stop();
    }
  });

  it('places a read group leading blank-line marker after its bullet', async () => {
    const tool = new ToolCallComponent(
      { id: 'call_read_blank', name: 'Read', args: { path: 'src/abcd.ts' } },
      { tool_call_id: 'call_read_blank', output: '1\tline', is_error: false },
    );
    const group = new ReadGroupComponent(undefined);
    group.attach('call_read_blank', tool);
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.setPresentationOptions({ fullscreen: true, toolCallDensity: 'ungrouped', thinking: 'ungrouped' });
      state.transcriptContainer.addChild(new UserMessageComponent('start'));
      state.transcriptContainer.addChild(group);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const startRow = rows.findIndex((row) => row.includes('start'));
      const headerRow = rows.findIndex((row) => row.includes('Read'));
      const blankRow = headerRow - 1;
      expect(startRow).toBeGreaterThanOrEqual(0);
      expect(headerRow).toBeGreaterThan(startRow);
      expect(rows[blankRow]?.trim()).toBe('');
      const startColumn = rows[startRow]!.indexOf('start');
      const contentColumn = rows[headerRow]!.indexOf('Read');
      const lastColumn = rows[headerRow]!.length - 1;

      vt.sendInput(`\u001B[<0;${startColumn + 1};${startRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${headerRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${headerRow + 1}m`);
      await vt.waitForRender();

      const line = alt.getScreenLines()[blankRow]!;
      expect(highlightedText(line)).toEqual([' ']);
      const highlight = line.indexOf('\u001B[7m');
      expect(highlight).toBeGreaterThanOrEqual(0);
      expect(stripAnsi(line.slice(0, highlight))).toHaveLength(contentColumn);
    } finally {
      group.dispose();
      tool.dispose();
      state.ui.stop();
    }
  });

  it('places a tool card leading blank-line marker after its status marker', async () => {
    const call = new ToolCallComponent(
      { id: 'swarm-blank', name: 'AgentSwarm', args: { prompt: 'fix the selection' } },
      { tool_call_id: 'swarm-blank', output: '3 completed', is_error: false },
    );
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(new UserMessageComponent('start'));
      state.transcriptContainer.addChild(call);
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const startRow = rows.findIndex((row) => row.includes('start'));
      const headerRow = rows.findIndex((row) => row.includes('AgentSwarm'));
      const blankRow = headerRow - 1;
      expect(startRow).toBeGreaterThanOrEqual(0);
      expect(headerRow).toBeGreaterThan(startRow);
      expect(rows[blankRow]?.trim()).toBe('');
      const startColumn = rows[startRow]!.indexOf('start');
      const contentColumn = rows[headerRow]!.indexOf('Used');
      const lastColumn = rows[headerRow]!.length - 1;

      vt.sendInput(`\u001B[<0;${startColumn + 1};${startRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${headerRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${headerRow + 1}m`);
      await vt.waitForRender();

      const line = alt.getScreenLines()[blankRow]!;
      expect(highlightedText(line)).toEqual([' ']);
      const highlight = line.indexOf('\u001B[7m');
      expect(highlight).toBeGreaterThanOrEqual(0);
      expect(stripAnsi(line.slice(0, highlight))).toHaveLength(contentColumn);
    } finally {
      call.dispose();
      state.ui.stop();
    }
  });

  it('copies a soft-wrapped ToolOutputMarkdown logical line without visual indentation', async () => {
    setExperimentalFeatures([{ id: 'notify_user', enabled: true }]);
    onTestFinished(() => setExperimentalFeatures([]));
    const source = `START${'x'.repeat(50)}END`;
    const component = new ToolCallComponent(
      { id: 'notify-soft-wrap-copy', name: 'NotifyUser', args: { title: 'Update', message: source } },
      {
        tool_call_id: 'notify-soft-wrap-copy',
        output: 'Update shown to the user.',
        is_error: false,
      },
    );
    component.setExpanded(true);
    try {
      await expect(copyComponentSelection(component, 20, logicalLineRange)).resolves.toBe(source);
    } finally {
      component.dispose();
    }
  });

  it.each(['thinking', 'text'] as const)('copies long gutter %s by dragging and triple-clicking', async (kind) => {
    const source = `START ${'x'.repeat(8)} ${'y'.repeat(8)} END`;
    const component = new ToolCallComponent(
      { id: `gutter-${kind}`, name: 'Agent', args: { description: 'inspect wrapping' } },
      undefined,
    );
    component.onSubagentSpawned({
      agentId: `gutter-${kind}`,
      agentName: 'explore',
      runInBackground: false,
    });
    component.appendSubagentText(source, kind);
    try {
      await expectComponentCopyGestures(component, 24, `│ ${source}`);
    } finally {
      component.dispose();
    }
  });

  it('copies an expanded NotifyUser title across both wrap widths', async () => {
    setExperimentalFeatures([{ id: 'notify_user', enabled: true }]);
    onTestFinished(() => setExperimentalFeatures([]));
    const source = `START ${'x'.repeat(20)} ${'y'.repeat(15)} END`;
    const ui = {
      mode: 'fullscreen',
      terminal: { rows: 30 },
      requestRender: () => {},
    } as unknown as TUI;
    const component = new ToolCallComponent(
      { id: 'notify-title-wrap', name: 'NotifyUser', args: { title: source, message: 'Body' } },
      undefined,
      ui,
    );
    component.setExpanded(true);
    try {
      await expectComponentCopyGestures(component, 24, source);
    } finally {
      component.dispose();
    }
  });

  it('copies a NotifyUser title with first-line text after a tab across both wrap widths', async () => {
    setExperimentalFeatures([{ id: 'notify_user', enabled: true }]);
    onTestFinished(() => setExperimentalFeatures([]));
    const suffix = `${'x'.repeat(30)} ${'y'.repeat(15)} END`;
    const component = new ToolCallComponent(
      {
        id: 'notify-title-tab-wrap',
        name: 'NotifyUser',
        args: { title: `START\tABCEFGHIJ ${suffix}`, message: 'Body' },
      },
      undefined,
      {
        mode: 'fullscreen',
        terminal: { rows: 30 },
        requestRender: () => {},
      } as unknown as TUI,
    );
    component.setExpanded(true);
    try {
      await expectComponentCopyGestures(component, 24, `START   ABCEFGHIJ ${suffix}`);
    } finally {
      component.dispose();
    }
  });

  it('copies a single-member expanded group title as one logical line', async () => {
    const { state } = await mountFullscreen();
    const source = `START${'x'.repeat(40)}END`;
    const call = new ToolCallComponent(
      { id: 'single-title-wrap', name: 'Read', args: { path: `/work/${source}` } },
      { tool_call_id: 'single-title-wrap', output: '', is_error: false },
      undefined,
      '/work',
    );
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(call);
      state.transcriptContainer.toggleGroup(call);
      await expectComponentCopyGestures(
        state.transcriptContainer,
        24,
        `Read ${source}`,
        (rows) => ({
          start: rows.findIndex((row) => row.includes('Read')),
          end: rows.findIndex((row) => row.includes('D')),
        }),
        'Read',
      );
    } finally {
      call.dispose();
      state.ui.stop();
    }
  });

  it.each(['Bash', 'Read'] as const)('copies an expanded %s wrappedRow by dragging and triple-clicking', async (name) => {
    const { state } = await mountFullscreen();
    const source = name === 'Bash'
      ? `START ${'x'.repeat(12)} ${'y'.repeat(12)} END`
      : `START${'x'.repeat(40)}END`;
    const otherName = name === 'Bash' ? 'Read' : 'Bash';
    const target = new ToolCallComponent(
      {
        id: `wrapped-row-${name}`,
        name,
        args: name === 'Bash' ? { command: source } : { path: `/work/${source}` },
      },
      { tool_call_id: `wrapped-row-${name}`, output: '', is_error: false },
      undefined,
      '/work',
    );
    const other = new ToolCallComponent(
      {
        id: `wrapped-row-other-${name}`,
        name: otherName,
        args: otherName === 'Bash' ? { command: 'true' } : { path: '/work/other.ts' },
      },
      { tool_call_id: `wrapped-row-other-${name}`, output: '', is_error: false },
      undefined,
      '/work',
    );
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(target);
      state.transcriptContainer.addChild(other);
      state.transcriptContainer.toggleToolOutputExpansion();
      await expectComponentCopyGestures(state.transcriptContainer, 32, `${name} ${source}`, logicalLineRange, name);
    } finally {
      target.dispose();
      other.dispose();
      state.ui.stop();
    }
  });

  it('renders expanded group tree guides outside the selectable content', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      const thinking = new ThinkingComponent('reasoning', true, 'finalized');
      thinking.finalize({ known: true, ms: 3000 });
      state.transcriptContainer.addChild(thinking);
      state.transcriptContainer.addChild(new ToolCallComponent(
        { id: 'tree-read', name: 'Read', args: { path: '/work/a.ts' } },
        { tool_call_id: 'tree-read', output: 'content', is_error: false },
      ));
      state.transcriptContainer.addChild(new ToolCallComponent(
        { id: 'tree-bash', name: 'Bash', args: { command: 'pnpm test' } },
        { tool_call_id: 'tree-bash', output: 'passed', is_error: false },
      ));
      state.transcriptContainer.toggleGroup(thinking);
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const titleRow = rows.findIndex((row) => row.includes('● Thought for 3s,'));
      const firstRow = rows.findIndex((row) => row.includes('├ Thought for 3s'));
      const lastRow = rows.findIndex((row) => row.includes('└ Bash pnpm test'));
      expect(titleRow).toBeGreaterThanOrEqual(0);
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      expect(rows[firstRow]!.indexOf('├')).toBe(rows[titleRow]!.indexOf('●'));
      const firstColumn = rows[firstRow]!.indexOf('Thought');
      const lastColumn = rows[lastRow]!.indexOf('Bash pnpm test') + 'Bash pnpm test'.length - 1;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);

      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith('Thought for 3s\nRead /work/a.ts\nBash pnpm test');
      });
      expect(highlightedText(alt.getScreenLines()[firstRow]!).join('')).not.toContain('├');
      expect(highlightedText(alt.getScreenLines()[lastRow]!).join('')).not.toContain('└');
    } finally {
      state.ui.stop();
    }
  });

  it('copies expanded row details with indentation and without tree guides', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const first = new ToolCallComponent(
      { id: 'indent-bash-first', name: 'Bash', args: { command: 'git status' } },
      { tool_call_id: 'indent-bash-first', output: 'one\ntwo', is_error: false },
    );
    const second = new ToolCallComponent(
      { id: 'indent-bash-second', name: 'Bash', args: { command: 'pnpm test' } },
      { tool_call_id: 'indent-bash-second', output: 'passed', is_error: false },
    );
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(first);
      state.transcriptContainer.addChild(second);
      state.transcriptContainer.toggleToolOutputExpansion();
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('├ Bash git status'));
      const lastRow = rows.findIndex((row) => row.includes('passed'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      const firstColumn = rows[firstRow]!.indexOf('Bash git status');
      const lastColumn = rows[lastRow]!.indexOf('passed') + 'passed'.length - 1;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);

      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith(
          'Bash git status\n  one\n  two\nBash pnpm test\n  passed',
        );
      });
      expect(highlightedText(alt.getScreenLines()[firstRow]!).join('')).not.toContain('├');
      expect(highlightedText(alt.getScreenLines()[lastRow]!).join('')).not.toContain('└');
    } finally {
      first.dispose();
      second.dispose();
      state.ui.stop();
    }
  });

  it('copies group tail content without highlighting its tree guide', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      const timeline = new TurnTimeline();
      state.transcriptContainer.setTimeline(timeline);
      const thinking = new ThinkingComponent('reasoning', true, 'live');
      state.transcriptContainer.addChild(thinking);
      timeline.turnStarted();
      timeline.thinkingDelta('Tail body');
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const tailRow = rows.findIndex((row) => row.includes('└ Tail body'));
      expect(tailRow).toBeGreaterThanOrEqual(0);
      const firstColumn = rows[tailRow]!.indexOf('Tail body');
      const lastColumn = firstColumn + 'Tail body'.length - 1;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${tailRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${tailRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${tailRow + 1}m`);

      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith('Tail body');
      });
      alt.renderNow();
      await vt.flush();
      expect(highlightedText(alt.getScreenLines()[tailRow]!).join('')).toBe('Tail body');
    } finally {
      state.ui.stop();
    }
  });

  it('starts left-gutter drags at the content boundary while clicks toggle a group', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const thinking = new ThinkingComponent('reasoning', true, 'finalized');
    thinking.finalize({ known: true, ms: 3000 });
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(thinking);
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const titleRow = rows.findIndex((row) => row.includes('Thought for 3s'));
      expect(titleRow).toBeGreaterThanOrEqual(0);
      expect(rows.some((row) => row.includes('reasoning'))).toBe(false);
      const gutterColumn = CHROME_GUTTER;
      const titleColumn = rows[titleRow]!.indexOf('Thought for 3s');
      const dragColumn = titleColumn + 'Thought'.length - 1;

      vt.sendInput(`\u001B[<0;${gutterColumn + 1};${titleRow + 1}M`);
      vt.sendInput(`\u001B[<32;${dragColumn + 1};${titleRow + 1}M`);
      vt.sendInput(`\u001B[<0;${dragColumn + 1};${titleRow + 1}m`);
      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith('Thought');
      });
      alt.renderNow();
      await vt.flush();
      expect(alt.hasActiveSelection()).toBe(true);
      expect(highlightedText(alt.getScreenLines()[titleRow]!).join('')).toBe('Thought');
      expect(screenRows(vt).some((row) => row.includes('reasoning'))).toBe(false);

      vt.sendInput(`\u001B[<0;${gutterColumn + 1};${titleRow + 1}M`);
      vt.sendInput(`\u001B[<0;${gutterColumn + 1};${titleRow + 1}m`);
      await vt.waitForRender();
      expect(screenRows(vt).some((row) => row.includes('reasoning'))).toBe(true);
      expect(alt.hasActiveSelection()).toBe(false);

      vt.sendInput(`\u001B[<0;${gutterColumn + 1};${titleRow + 1}M`);
      vt.sendInput(`\u001B[<0;${gutterColumn + 1};${titleRow + 1}m`);
      await vt.waitForRender();
      expect(screenRows(vt).some((row) => row.includes('reasoning'))).toBe(false);
      expect(clipboardText.copyTextToClipboard).toHaveBeenCalledTimes(1);
    } finally {
      state.ui.stop();
    }
  });

  it('copies only content across Thought, groups, blank lines, and Assistant', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const thinking = new ThinkingComponent('thought alpha\n\nthought beta', true, 'finalized');
    thinking.finalize({ known: true, ms: 3000 });
    const read = new ToolCallComponent(
      { id: 'region-read', name: 'Read', args: { path: '/work/a.ts' } },
      { tool_call_id: 'region-read', output: 'content', is_error: false },
    );
    const bash = new ToolCallComponent(
      { id: 'region-bash', name: 'Bash', args: { command: 'pnpm test' } },
      { tool_call_id: 'region-bash', output: 'passed', is_error: false },
    );
    const assistant = new AssistantMessageComponent();
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(thinking);
      state.transcriptContainer.addChild(read);
      state.transcriptContainer.addChild(bash);
      state.transcriptContainer.addChild(assistant);
      assistant.updateContent('assistant alpha\n\nassistant beta');
      thinking.setExpanded(true);
      state.transcriptContainer.toggleGroup(thinking);
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('thought alpha'));
      const lastRow = rows.findIndex((row) => row.includes('assistant beta'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      expect(rows.slice(firstRow, lastRow + 1).some((row) => row.trim() === '')).toBe(true);
      expect(rows.slice(firstRow, lastRow + 1).some((row) => row.includes('├ Read /work/a.ts'))).toBe(true);
      const firstColumn = rows[firstRow]!.indexOf('thought alpha');
      const lastColumn = rows[lastRow]!.indexOf('assistant beta') + 'assistant beta'.length - 1;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}m`);
      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalled();
      });
      const copied = clipboardText.copyTextToClipboard.mock.calls.at(-1)?.[0];
      expect(copied).toBe(
        'thought alpha\n\n  thought beta\nRead /work/a.ts\nBash pnpm test\n\nassistant alpha\n\nassistant beta',
      );
    } finally {
      read.dispose();
      bash.dispose();
      state.ui.stop();
    }
  });

  it('clamps transcript drags entering the left gutter and scrollbar column', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(new UserMessageComponent('alpha\n\nbeta'));
      state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      alt.scrollToTop();
      await vt.waitForRender();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('alpha'));
      const lastRow = rows.findIndex((row) => row.includes('beta'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      const firstColumn = rows[firstRow]!.indexOf('alpha');
      const lastColumn = rows[lastRow]!.indexOf('beta') + 'beta'.length - 1;

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${WIDTH};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${WIDTH};${lastRow + 1}m`);
      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith('alpha\n\nbeta');
      });
      expect(alt.getScreenLines().every((line) => highlightedText(line).every((text) => !/[❯│┃]/u.test(text)))).toBe(true);

      alt.resetTextSelection();
      clipboardText.copyTextToClipboard.mockClear();
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<32;1;${firstRow + 1}M`);
      vt.sendInput(`\u001B[<0;1;${firstRow + 1}m`);
      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith('alpha\n\nbeta');
      });
      expect(alt.getScreenLines().every((line) => highlightedText(line).every((text) => !/[❯│┃]/u.test(text)))).toBe(true);
    } finally {
      state.ui.stop();
    }
  });

  it('keeps scrollbar track gestures from creating or extending text selections', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      groupTranscript(state);
      state.transcriptContainer.addChild(
        new Text(Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n'), 0, 0),
      );
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      alt.scrollToTop();
      await vt.waitForRender();
      vt.sendInput(`\u001B[<35;${WIDTH};2M`);
      await vt.waitForRender();
      const editorTop = screenRows(vt).findIndex((row) => row.includes('╭'));
      expect(editorTop).toBeGreaterThan(1);
      const trackRow = editorTop - 1;
      const initialTop = alt.viewportTop;

      vt.sendInput(`\u001B[<0;${WIDTH};${trackRow + 1}M`);
      vt.sendInput(`\u001B[<0;${WIDTH};${trackRow + 1}m`);
      await vt.waitForRender();
      expect(alt.viewportTop).toBeGreaterThan(initialTop);
      expect(alt.hasActiveSelection()).toBe(false);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(false);

      alt.scrollToTop();
      await vt.waitForRender();
      const rows = screenRows(vt);
      const textRow = rows.findIndex((row) => row.includes('line 1'));
      const textColumn = rows[textRow]!.indexOf('line 1');
      vt.sendInput(`\u001B[<0;${textColumn + 1};${textRow + 1}M`);
      vt.sendInput(`\u001B[<32;${textColumn + 6};${textRow + 1}M`);
      vt.sendInput(`\u001B[<0;${textColumn + 6};${textRow + 1}m`);
      await vt.waitForRender();
      expect(alt.hasActiveSelection()).toBe(true);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('line 1');
      clipboardText.copyTextToClipboard.mockClear();

      const topBeforeDrag = alt.viewportTop;
      vt.sendInput(`\u001B[<0;${WIDTH};${trackRow + 1}M`);
      await vt.waitForRender();
      const pressedTop = alt.viewportTop;
      expect(pressedTop).toBeGreaterThan(topBeforeDrag);
      vt.sendInput(`\u001B[<32;${WIDTH};2M`);
      vt.sendInput(`\u001B[<0;${WIDTH};2m`);
      await vt.waitForRender();
      expect(alt.viewportTop).toBeLessThan(pressedTop);
      expect(alt.hasActiveSelection()).toBe(false);
      expect(clipboardText.copyTextToClipboard).not.toHaveBeenCalled();
      const releasedTop = alt.viewportTop;
      vt.sendInput(`\u001B[<35;${textColumn + 6};${textRow + 1}M`);
      await vt.waitForRender();
      expect(alt.viewportTop).toBe(releasedTop);
      expect(alt.hasActiveSelection()).toBe(false);
    } finally {
      state.ui.stop();
    }
  });

  it('preserves soft-wrapped assistant dragging, double-click words, and triple-click lines', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    clipboardText.copyTextToClipboard.mockResolvedValueOnce('native');
    const { state, vt } = await mountFullscreen();
    const source = 'A'.repeat(WIDTH);
    const assistant = new AssistantMessageComponent();
    state.transcriptContainer.addChild(assistant);
    assistant.updateContent(source);
    const alt = state.ui as TuiAltScreen;
    try {
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('A'.repeat(100)));
      const secondRow = rows.findIndex((row, index) => index > firstRow && row.includes('A'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(secondRow).toBeGreaterThan(firstRow);
      const firstColumn = rows[firstRow]!.indexOf('A');
      const lastColumn = rows[secondRow]!.lastIndexOf('A');

      vt.sendInput(`\u001B[<0;${firstColumn + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastColumn + 1};${secondRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastColumn + 1};${secondRow + 1}m`);
      await vi.waitFor(() => {
        expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith(source);
      });
      for (const row of [firstRow, secondRow]) {
        const column = rows[row]!.indexOf('A');
        const expectedWord = rows[row]!.match(/A+/)?.[0];
        expect(expectedWord).toBeDefined();
        alt.resetTextSelection();
        clipboardText.copyTextToClipboard.mockClear();
        for (let click = 0; click < 2; click++) {
          vt.sendInput(`\u001B[<0;${column + 1};${row + 1}M`);
          vt.sendInput(`\u001B[<0;${column + 1};${row + 1}m`);
        }
        await vi.waitFor(() => {
          expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith(expectedWord);
        });
        alt.resetTextSelection();
        clipboardText.copyTextToClipboard.mockClear();
        for (let click = 0; click < 3; click++) {
          vt.sendInput(`\u001B[<0;${column + 1};${row + 1}M`);
          vt.sendInput(`\u001B[<0;${column + 1};${row + 1}m`);
        }
        await vi.waitFor(() => {
          expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith(source);
        });
      }
    } finally {
      state.ui.stop();
    }
  });

  it('selects a complete soft-wrapped user message when triple-clicking either visual row', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const source = '渲染一个 Markdown 表格，内部随便填写一些内容。'.repeat(6);
    const { state, vt } = await mountFullscreen();
    try {
      state.transcriptContainer.addChild(new UserMessageComponent(source));
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('渲染'));
      const secondRow = firstRow + 1;
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(rows[secondRow]?.trim()).not.toBe('');
      for (const row of [firstRow, secondRow]) {
        clipboardText.copyTextToClipboard.mockClear();
        const column = row === firstRow ? rows[row]!.indexOf('渲') : rows[row]!.search(/\S/);
        for (let click = 0; click < 3; click++) {
          vt.sendInput(`\u001B[<0;${column + 1};${row + 1}M`);
          vt.sendInput(`\u001B[<0;${column + 1};${row + 1}m`);
        }
        await vi.waitFor(() => {
          expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith(source);
        });
      }
    } finally {
      state.ui.stop();
    }
  });

  it('keeps wrapped status text out of message decoration columns', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      vt.resize(60, HEIGHT);
      await vt.waitForRender();
      state.transcriptContainer.addChild(
        new StatusMessageComponent(
          'Routine edits and commands run automatically; risky actions, questions, and plans still ask.',
        ),
      );
      const alt = state.ui as TuiAltScreen;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((row) => row.includes('Routine edits'));
      const continuationRow = firstRow + 1;
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(rows[continuationRow]?.trim()).not.toBe('');
      expect(rows[continuationRow]!.search(/\S/)).toBe(rows[firstRow]!.indexOf('Routine edits'));
    } finally {
      state.ui.stop();
    }
  });

  it('completes right-click copy after unverified OSC 52 delivery', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    clipboardText.copyTextToClipboard.mockResolvedValueOnce('osc52');
    const { state, vt } = await mountFullscreen();
    const alt = state.ui as TuiAltScreen;
    try {
      alt.setCopyOnSelect(false);
      alt.setCopyOnRightClick(true);
      state.transcriptContainer.addChild(new Text('hello world', 0, 0));
      alt.renderNow();
      await vt.flush();
      const row = screenRows(vt).findIndex((line) => line.includes('hello world'));
      const col = screenRows(vt)[row]!.indexOf('hello world');

      vt.sendInput(`\u001B[<0;${col + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${col + 11};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${col + 11};${row + 1}m`);
      await vt.waitForRender();
      expect(clipboardText.copyTextToClipboard).not.toHaveBeenCalled();

      vt.sendInput(`\u001B[<2;${col + 11};${row + 1}M`);
      vt.sendInput(`\u001B[<2;${col + 11};${row + 1}m`);

      await vi.waitFor(() => {
        expect(alt.hasActiveSelection()).toBe(false);
        expect(screenRows(vt).join('\n')).toContain('Copied via terminal');
      });
      expect(clipboardText.copyTextToClipboard).toHaveBeenCalledOnce();
      expect(clipboardText.copyTextToClipboard).toHaveBeenCalledWith('hello world');
    } finally {
      state.ui.stop();
    }
  });

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

  it('keeps selection content stable across scrolling, sticky pill, resize, and Jump to bottom', async () => {
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
    const copy = clipboardText.copyTextToClipboard;
    copy.mockClear();
    await alt.copyActiveSelectionToClipboard();
    expect(copy).toHaveBeenCalledWith('alpha');
    copy.mockClear();
    alt.scrollBy(1);
    await vt.waitForRender();
    expect(pillLines(state)).toHaveLength(1);
    await alt.copyActiveSelectionToClipboard();
    expect(copy).toHaveBeenCalledWith('alpha');
    copy.mockClear();
    alt.scrollBy(-1);
    await vt.waitForRender();
    expect(pillLines(state)).toEqual([]);
    await alt.copyActiveSelectionToClipboard();
    expect(copy).toHaveBeenCalledWith('alpha');
    copy.mockClear();
    vt.resize(WIDTH - 20, HEIGHT);
    await vt.waitForRender();
    expect(screenRows(vt).some((row) => row.includes('Jump to bottom'))).toBe(true);
    await alt.copyActiveSelectionToClipboard();
    expect(copy).toHaveBeenCalledWith('alpha');
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
      expect(measure).toHaveBeenCalledWith('latest question', 60 - CHROME_GUTTER * 2 - 1, undefined);
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

  it('keeps the viewport anchored when bottom collapse removes lines', async () => {
    const { state, vt } = await mountFullscreen();
    const first = new Text(Array.from({ length: 20 }, (_, i) => `first ${i}`).join('\n'), 0, 0);
    state.transcriptContainer.addChild(first);
    state.transcriptContainer.addChild(new Text(Array.from({ length: 20 }, (_, i) => `second ${i}`).join('\n'), 0, 0));
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    alt.scrollToTop();
    alt.scrollBy(5);
    await vt.waitForRender();
    const before = alt.viewportTop;
    if (state.transcriptView === undefined) throw new Error('transcript view missing');

    state.transcriptView.withBottomAnchor(() => {
      state.transcriptContainer.replaceChild(
        first,
        new Text(Array.from({ length: 15 }, (_, i) => `first ${i}`).join('\n'), 0, 0),
      );
    }, 5);
    alt.renderNow();
    await vt.flush();

    expect(alt.viewportTop).toBe(before - 5);
    alt.stop();
  });

  it('keeps following the transcript end after a click expands a group', async () => {
    const { state, vt } = await mountFullscreen();
    groupTranscript(state);
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    addReadGroup(state);
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    await vt.flush();
    const title = screenRows(vt).findIndex((row) => row.includes('read 6 files'));
    expect(title).toBeGreaterThan(0);

    await clickRow(vt, title);
    state.transcriptContainer.addChild(new Text('final answer', 0, 0));
    alt.renderNow();
    await vt.flush();

    const rows = screenRows(vt);
    expect(rows.some((row) => row.includes('final answer'))).toBe(true);
    expect(rows.some((row) => row.includes('Jump to bottom'))).toBe(false);
    expect(rows.some((row) => row.includes('Read file-5.ts'))).toBe(true);
    alt.stop();
  });

  it('keeps a clicked group title in place when the transcript is scrolled up', async () => {
    const { state, vt } = await mountFullscreen();
    groupTranscript(state);
    state.transcriptContainer.addChild(new Text('top\n'.repeat(5), 0, 0));
    addReadGroup(state);
    state.transcriptContainer.addChild(new Text('body\n'.repeat(40), 0, 0));
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    alt.scrollToTop();
    await vt.waitForRender();
    const title = screenRows(vt).findIndex((row) => row.includes('read 6 files'));
    expect(title).toBeGreaterThan(0);

    await clickRow(vt, title);

    const rows = screenRows(vt);
    expect(rows[title]).toContain('read 6 files');
    expect(rows.slice(title + 1).some((row) => row.includes('Read file-0.ts'))).toBe(true);
    alt.stop();
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
    expect(clicks.at(-1)?.width).toBe(WIDTH - CHROME_GUTTER * 2 - 1);
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

  it('keeps the editor on the same row from idle through a working turn to its summary', async () => {
    const { driver, vt } = mountFullscreenKimiTui();
    const emit = (event: Record<string, unknown>): void => {
      driver.sessionEventHandler.handleEvent(
        { agentId: 'main', sessionId: 'ses-1', turnId: 1, ...event },
        () => {},
      );
    };
    const dock = async (): Promise<{ editorTop: number; activity: string }> => {
      driver.state.ui.requestRender();
      await vt.waitForRender();
      const rows = screenRows(vt);
      const editorTop = rows.findIndex((row) => row.includes('╭'));
      return { editorTop, activity: rows[editorTop - 1]?.trim() ?? '' };
    };

    driver.updateActivityPane();
    const idle = await dock();
    expect(idle).toEqual({ editorTop: expect.any(Number), activity: '' });

    driver.beginSessionRequest();
    expect(await dock()).toEqual({ editorTop: idle.editorTop, activity: expect.stringMatching(/^[🌑🌒🌓🌔🌕🌖🌗🌘]/u) });
    emit({ type: 'thinking.delta', delta: 'Plan the change.' });
    expect(await dock()).toEqual({ editorTop: idle.editorTop, activity: expect.stringMatching(/^\S Working for \d+s/u) });
    emit({ type: 'tool.call.started', toolCallId: 'call_read', name: 'Read', args: { path: 'a.ts' } });
    expect(await dock()).toEqual({ editorTop: idle.editorTop, activity: expect.stringMatching(/^[🌑🌒🌓🌔🌕🌖🌗🌘]/u) });
    emit({ type: 'tool.result', toolCallId: 'call_read', output: 'content' });
    emit({ type: 'turn.ended', reason: 'completed' });
    expect(await dock()).toEqual({
      editorTop: idle.editorTop,
      activity: expect.stringMatching(/^Worked for \d+s · done \d{1,2}:\d{2} [AP]M$/u),
    });

    driver.state.ui.stop();
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

    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRows()[1]).toContain('回答二');

    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRows()[1]).toContain('第二轮提问');

    vt.sendInput('\u001B[1;6B');
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

    expect(alt.isFollowingOutput).toBe(true);
    expect(alt.viewportTop).toBeGreaterThan(1);
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(messageRowCount()).toBe(1);

    alt.scrollToTop();
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(0);
    expect(topRow()).not.toContain('❯ 第一轮问题');

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

    vt.sendInput('\u001B[<65;5;1M');
    await vt.waitForRender();
    expect(alt.viewportTop).toBeGreaterThan(scrolledTop);

    vt.sendInput('\u001B[<0;5;1M');
    vt.sendInput('\u001B[<0;5;1m');
    await vt.waitForRender();
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

    alt.scrollBy(2);
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一行');

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行 第二行');

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(topRow()).toBe('❯ 第一行 第二行 第三行');

    vt.sendInput('\u001B[<0;5;1M');
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

    alt.scrollBy(3);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(3);
    expect(topRow()).not.toContain('第一行');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1);
    await vt.waitForRender();
    expect(alt.viewportTop).toBe(4);
    expect(topRow()).toContain('第一行');
    expect(topRow()).not.toContain('❯');
    expect(countRows('第一行')).toBe(1);

    alt.scrollBy(1);
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

    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第二轮问题');
    expect(countRows('第二轮问题')).toBe(1);

    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(countRows('第二轮问题')).toBe(1);
    expect(countRows('第一轮问题')).toBe(1);

    vt.sendInput('\u001B[1;6A');
    await vt.waitForRender();
    expect(topRow()).toContain('❯ 第一轮问题');
    expect(countRows('第一轮问题')).toBe(1);

    vt.sendInput('\u001B[1;6A');
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
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 24 }, (_, i) => `填充行 ${i + 1}`).join('\n'), 0, 0),
    );
    state.ui.requestRender(true);
    await vt.waitForRender();

    const alt = state.ui as TuiAltScreen;
    expect(alt.isFollowingOutput).toBe(true);
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
      promptPredictionController: {},
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
    const picker = new SettingsSelectorComponent({
      fullscreen: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
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
    expect(rows.join('\n')).toContain('❯ Editor');

    state.ui.setFocus(state.notifyPanel);
    state.ui.requestRender();
    await vt.waitForRender();
    expect(picker.focused).toBe(false);

    state.ui.stop();
  });

  it('scrolls a transcript setting preview that the terminal is too short for', async () => {
    const { state, vt } = await mountFullscreen(24);
    onTestFinished(() => {
      state.ui.stop();
    });
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 40 }, (_, i) => `transcript ${String(i + 1)}`).join('\n'), 0, 0),
    );
    showSettingsSelector(editorReplacementHost(state));
    for (let i = 0; i < 4; i++) vt.sendInput('\u001B[B');
    vt.sendInput('\r');
    await vt.waitForRender();
    const panel = (): string[] => screenRows(vt).map((row) => row.replace(/[┃│]$/, '').trim());
    const borders = (): number[] => panel().flatMap((row, index) => (/^─{20,}$/.test(row) ? [index] : []));
    const summary = 'Thought for 3s, read 1 file, ran 1 command, edited 1 file +1 -1';

    let rows = panel();
    expect(rows).toContain('Tool call density');
    expect(rows).toContain('↑↓ navigate · Enter select · Esc cancel · shift+↑/↓ scroll');
    const frame = borders();
    expect(frame).toHaveLength(2);
    const bottom = frame[1] ?? rows.length;
    const label = rows.indexOf('Preview');
    expect(label).toBeGreaterThan(rows.indexOf('Detailed'));
    const content = label + 2;
    expect(rows.slice(label, content + 1)).toEqual(['Preview', '', summary]);
    const top = rows.slice(content, bottom);

    vt.sendInput('\u001B[1;2B');
    await vt.waitForRender();
    rows = panel();
    expect(rows.slice(label, content)).toEqual(['Preview', '']);
    expect(rows.slice(content, bottom - 1)).toEqual(top.slice(1));
    expect(rows).not.toContain(summary);

    vt.sendInput('\u001B[1;2A');
    await vt.waitForRender();
    expect(panel().slice(label, content + 1)).toEqual(['Preview', '', summary]);

    vt.sendInput(`\u001B[<65;5;${String(label + 1)}M`);
    await vt.waitForRender();
    expect(panel().slice(label, content + 1)).toEqual(['Preview', '', summary]);

    vt.sendInput(`\u001B[<65;5;${String(content + 1)}M`);
    await vt.waitForRender();
    rows = panel();
    expect(rows.slice(label, content)).toEqual(['Preview', '']);
    expect(rows).not.toContain(summary);

    const transcriptTop = (state.ui as TuiAltScreen).viewportTop;
    vt.sendInput(`\u001B[<64;5;${String(frame[1]! + 1)}M`);
    await vt.waitForRender();
    expect((state.ui as TuiAltScreen).viewportTop).toBe(transcriptTop);

    vt.sendInput('\u001B[B');
    await vt.waitForRender();
    rows = panel();
    expect(rows).toContain('❯ Balanced');
    expect(rows.slice(label, content + 1)).toEqual(['Preview', '', 'Thought for 3s, read 1 file']);
    expect(borders()).toEqual(frame);
  });

  it('shows a whole transcript setting preview without scrolling when the terminal is tall', async () => {
    const { state, vt } = await mountFullscreen(40);
    onTestFinished(() => {
      state.ui.stop();
    });
    showSettingsSelector(editorReplacementHost(state));
    for (let i = 0; i < 5; i++) vt.sendInput('\u001B[B');
    vt.sendInput('\r');
    await vt.waitForRender();
    vt.sendInput('\u001B[B');
    await vt.waitForRender();

    const rows = screenRows(vt);
    expect(rows.some((row) => /[┃│]$/.test(row))).toBe(false);
    const panel = rows.map((row) => row.trim());
    expect(panel).toContain('Thinking folding');
    expect(panel).toContain('↑↓ navigate · Enter select · Esc cancel');
    expect(panel).toContain("❯ Don't fold thinking");
    const thinking = panel.indexOf('● Check how the app starts before changing it.');
    expect(thinking).toBeGreaterThan(panel.indexOf('Preview'));
    expect(panel.slice(thinking + 1, thinking + 3)).toEqual([
      'start() in src/app.ts takes no arguments, so the port is fixed.',
      '… (2 more lines, ctrl+o to expand)',
    ]);
    expect(panel.filter((row) => /^─{20,}$/.test(row))).toHaveLength(2);
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
      promptPredictionController: {},
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
      promptPredictionController: {},
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

  it('omits the editor border and prompt gutter from dragged selections', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('hello');
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const top = rows.findIndex((line) => line.includes('╭'));
      const bottom = rows.findIndex((line) => line.includes('╰'));
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeGreaterThan(top);
      const startColumn = rows[top]!.indexOf('╭');
      const endColumn = rows[bottom]!.lastIndexOf('╯');

      vt.sendInput(`\u001B[<0;${startColumn + 1};${top + 1}M`);
      vt.sendInput(`\u001B[<32;${endColumn + 1};${bottom + 1}M`);
      vt.sendInput(`\u001B[<0;${endColumn + 1};${bottom + 1}m`);
      await vt.waitForRender();

      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      const copied = clipboardText.copyTextToClipboard.mock.calls.at(-1)?.[0];
      expect(copied).toBe('hello');
      expect(copied).not.toMatch(/[╭╮╰╯│─>]/u);
    } finally {
      state.ui.stop();
    }
  });

  it.each([
    [4, ' a│', ' b│', ['a'], ['b']],
    [6, ' │ab│', ' │ab│', ['ab'], ['ab']],
    [8, ' │ ab │', ' │ ab │', ['ab'], ['ab']],
  ])(
    'highlights only docked editor text dragged at width %i',
    async (width, firstLine, lastLine, firstHighlight, lastHighlight) => {
      clipboardText.copyTextToClipboard.mockClear();
      const { state, vt } = await mountFullscreen();
      try {
        const alt = state.ui as TuiAltScreen;
        alt.setCopyOnSelect(false);
        state.editor.setText('ab');
        state.editor.focused = false;
        vt.resize(width, HEIGHT);
        alt.renderNow();
        await vt.flush();
        const rows = screenRows(vt);
        const firstRow = rows.findIndex((line) => line === firstLine);
        const lastRow = rows.findIndex((line) => line === lastLine);
        expect(firstRow).toBeGreaterThanOrEqual(0);
        expect(lastRow).toBeGreaterThanOrEqual(firstRow);
        const textStart = rows[firstRow]!.indexOf('a');
        const textEnd = rows[lastRow]!.indexOf('b');

        vt.sendInput(`\u001B[<0;${textStart + 1};${firstRow + 1}M`);
        vt.sendInput(`\u001B[<32;${textEnd + 2};${lastRow + 1}M`);
        vt.sendInput(`\u001B[<0;${textEnd + 2};${lastRow + 1}m`);
        await vt.waitForRender();

        expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual(firstHighlight);
        expect(highlightedText(alt.getScreenLines()[lastRow]!)).toEqual(lastHighlight);
        expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
        expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('ab');
      } finally {
        state.ui.stop();
      }
    },
  );

  it('clips docked editor selection safely at width 1 without highlighting decorations', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('ab');
      state.editor.focused = false;
      vt.resize(1, HEIGHT);
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      expect(rows.every((line) => line === '')).toBe(true);

      vt.sendInput('\u001B[<0;1;1M');
      vt.sendInput(`\u001B[<32;1;${HEIGHT}M`);
      vt.sendInput(`\u001B[<0;1;${HEIGHT}m`);
      await vt.waitForRender();

      for (const line of alt.getScreenLines()) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(1);
        expect(highlightedText(line)).toEqual([]);
      }
    } finally {
      state.ui.stop();
    }
  });

  it('keeps search focused while selecting docked editor text and focuses the editor on click', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('hello world');
      alt.renderNow();
      await vt.flush();
      vt.sendInput('\u001B[102;6u');
      vt.sendInput('find');
      await vt.waitForRender();
      const searchFocus = alt.getFocusedComponent();
      const searchCursor = vt.getCursorPosition();
      const editorCursor = state.editor.getCursor();
      expect(searchFocus).not.toBe(state.editor);
      expect(state.editor.focused).toBe(false);
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('hello world'));
      expect(row).toBeGreaterThanOrEqual(0);
      const start = rows[row]!.indexOf('hello');
      expect(start).toBeGreaterThanOrEqual(0);

      vt.sendInput(`\u001B[<0;${start + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${start + 5};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${start + 5};${row + 1}m`);
      await vt.waitForRender();

      expect(alt.getFocusedComponent()).toBe(searchFocus);
      expect(state.editor.getCursor()).toEqual(editorCursor);
      expect(vt.getCursorPosition()).toEqual(searchCursor);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('hello');

      vt.sendInput(`\u001B[<0;${start + 7};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${start + 7};${row + 1}m`);
      await vt.waitForRender();

      expect(alt.getFocusedComponent()).toBe(state.editor);
      expect(state.editor.focused).toBe(true);
      expect(screenRows(vt).join('\n')).not.toContain('↑ Previous · ↓ Next');
      vt.sendInput('X');
      await vt.waitForRender();
      expect(state.editor.getText()).toBe('hello Xworld');
    } finally {
      state.ui.stop();
    }
  });

  it('right-click paste replaces the selected search query without changing the editor', async () => {
    clipboardText.readClipboardText.mockClear();
    clipboardText.readClipboardText.mockResolvedValueOnce('replacement');
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('editor body');
      alt.renderNow();
      await vt.flush();
      vt.sendInput('\u001B[102;6u');
      vt.sendInput('alpha beta');
      await vt.waitForRender();
      const search = alt.getFocusedComponent() as Component & { getText(): string };
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('alpha beta'));
      const start = rows[row]!.indexOf('beta');
      expect(row).toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThanOrEqual(0);

      vt.sendInput(`\u001B[<0;${start + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${start + 4};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${start + 4};${row + 1}m`);
      await vt.waitForRender();
      expect(alt.hasActiveSelection()).toBe(true);
      rightClick(vt, start + 3, row);

      await vi.waitFor(() => {
        expect(search.getText()).toBe('alpha replacement');
      });
      expect(alt.hasActiveSelection()).toBe(false);
      expect(state.editor.getText()).toBe('editor body');
      expect(clipboardText.readClipboardText).toHaveBeenCalledTimes(1);
    } finally {
      state.ui.stop();
    }
  });

  it('right-click paste replaces the selected editor text without changing the search query', async () => {
    clipboardText.readClipboardText.mockClear();
    clipboardText.readClipboardText.mockResolvedValueOnce('replacement');
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      alt.renderNow();
      await vt.flush();
      vt.sendInput('\u001B[102;6u');
      vt.sendInput('search query');
      await vt.waitForRender();
      const search = alt.getFocusedComponent() as Component & { getText(): string };
      vt.sendInput('\u001B');
      state.editor.setText('alpha beta');
      alt.renderNow();
      await vt.flush();
      expect(alt.getFocusedComponent()).toBe(state.editor);
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('alpha beta'));
      const start = rows[row]!.indexOf('beta');
      expect(row).toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThanOrEqual(0);

      vt.sendInput(`\u001B[<0;${start + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${start + 4};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${start + 4};${row + 1}m`);
      await vt.waitForRender();
      expect(alt.hasActiveSelection()).toBe(true);
      rightClick(vt, start + 3, row);

      await vi.waitFor(() => {
        expect(state.editor.getText()).toBe('alpha replacement');
      });
      expect(alt.hasActiveSelection()).toBe(false);
      expect(search.getText()).toBe('search query');
      expect(clipboardText.readClipboardText).toHaveBeenCalledTimes(1);
    } finally {
      state.ui.stop();
    }
  });

  it('omits virtual space after docked editor text from dragged highlights', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('ddd');
      state.editor.focused = false;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('ddd'));
      expect(row).toBeGreaterThanOrEqual(0);
      const line = rows[row]!;
      const textStart = line.indexOf('ddd');
      const textEnd = textStart + 3;

      vt.sendInput(`\u001B[<0;${textEnd + 6};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${textEnd + 11};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${textEnd + 11};${row + 1}m`);
      await vt.waitForRender();
      expect(highlightedText(alt.getScreenLines()[row]!).filter((text) => text !== ' ')).toEqual([]);

      vt.sendInput(`\u001B[<0;${textEnd + 11};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${textStart + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${textStart + 1};${row + 1}m`);
      await vt.waitForRender();
      expect(highlightedText(alt.getScreenLines()[row]!).filter((text) => text !== ' ')).toEqual(['ddd']);
    } finally {
      state.ui.stop();
    }
  });

  it('limits multiline docked editor highlights to content and selected newline cells', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('ddd\neee\nfff');
      state.editor.focused = false;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('ddd'));
      const middleRow = rows.findIndex((line) => line.includes('eee'));
      const lastRow = rows.findIndex((line) => line.includes('fff'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(middleRow).toBeGreaterThan(firstRow);
      expect(lastRow).toBeGreaterThan(middleRow);
      const firstEnd = rows[firstRow]!.indexOf('ddd') + 3;
      const lastEnd = rows[lastRow]!.indexOf('fff') + 3;

      vt.sendInput(`\u001B[<0;${firstEnd + 6};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${lastEnd + 6};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${lastEnd + 6};${lastRow + 1}m`);
      await vt.waitForRender();

      for (const [row, expected] of [[firstRow, [' ']], [middleRow, ['eee ']], [lastRow, ['fff']]] as const) {
        expect(highlightedText(alt.getScreenLines()[row]!)).toEqual(expected);
      }
    } finally {
      state.ui.stop();
    }
  });

  it('starts a logical multiline editor selection from the top frame', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('ddd\n');
      state.editor.focused = false;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('ddd'));
      const topRow = rows.findIndex((line) => line.includes('╭'));
      const emptyRow = firstRow + 1;
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(topRow).toBe(firstRow - 1);
      const column = rows[firstRow]!.indexOf('ddd');

      vt.sendInput(`\u001B[<0;${column + 1};${topRow + 1}M`);
      vt.sendInput(`\u001B[<32;${column + 1};${emptyRow + 1}M`);
      vt.sendInput(`\u001B[<0;${column + 1};${emptyRow + 1}m`);
      await vt.waitForRender();

      expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual(['ddd ']);
      expect(highlightedText(alt.getScreenLines()[emptyRow]!)).toEqual([' ']);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('ddd\n');
    } finally {
      state.ui.stop();
    }
  });

  it('keeps selected editor newlines and the empty-line endpoint visible when dragged outside', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('ddd\n');
      state.editor.focused = false;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('ddd'));
      const emptyRow = firstRow + 1;
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(rows[emptyRow]).toContain('│');
      const column = rows[firstRow]!.indexOf('ddd');

      vt.sendInput(`\u001B[<0;${column + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${column + 1};${emptyRow + 1}M`);
      await vt.waitForRender();

      expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual(['ddd ']);
      expect(highlightedText(alt.getScreenLines()[emptyRow]!)).toEqual([' ']);

      vt.sendInput(`\u001B[<32;${column + 1};${HEIGHT}M`);
      await vt.waitForRender();
      expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual(['ddd ']);
      expect(highlightedText(alt.getScreenLines()[emptyRow]!)).toEqual([' ']);
      vt.sendInput(`\u001B[<0;${column + 1};${HEIGHT}m`);
      await vt.waitForRender();
      expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual(['ddd ']);
      expect(highlightedText(alt.getScreenLines()[emptyRow]!)).toEqual([' ']);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('ddd\n');
    } finally {
      state.ui.stop();
    }
  });

  it('starts a docked editor selection at the prompt without highlighting trailing space', async () => {
    clipboardText.copyTextToClipboard.mockClear();
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('ddd');
      state.editor.focused = false;
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('ddd'));
      expect(row).toBeGreaterThanOrEqual(0);
      const prompt = rows[row]!.indexOf('>');
      const textStart = rows[row]!.indexOf('ddd');
      expect(prompt).toBeGreaterThanOrEqual(0);
      expect(textStart).toBeGreaterThan(prompt);

      vt.sendInput(`\u001B[<0;${prompt + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${WIDTH - 1};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${WIDTH - 1};${row + 1}m`);
      await vt.waitForRender();

      expect(highlightedText(alt.getScreenLines()[row]!)).toEqual(['ddd']);
      expect(await alt.copyActiveSelectionToClipboard()).toBe(true);
      expect(clipboardText.copyTextToClipboard).toHaveBeenLastCalledWith('ddd');
    } finally {
      state.ui.stop();
    }
  });

  it('moves the docked editor caret to the active drag endpoint', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('qqq\nwww\neee');
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('qqq'));
      const secondRow = rows.findIndex((line) => line.includes('www'));
      const thirdRow = rows.findIndex((line) => line.includes('eee'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(secondRow).toBeGreaterThan(firstRow);
      expect(thirdRow).toBeGreaterThan(secondRow);
      const start = rows[firstRow]!.indexOf('qqq');
      const endpoint = rows[secondRow]!.indexOf('www') + 1;
      expect(state.editor.getCursor()).toEqual({ line: 2, col: 3 });
      expect(vt.getCursorPosition()).toEqual({ x: rows[thirdRow]!.indexOf('eee') + 3, y: thirdRow });

      vt.sendInput(`\u001B[<0;${start + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${endpoint + 1};${secondRow + 1}M`);
      await vt.waitForRender();

      expect(state.editor.getCursor()).toEqual({ line: 1, col: 1 });
      expect(vt.getCursorPosition()).toEqual({ x: endpoint, y: secondRow });
      expect(highlightedText(alt.getScreenLines()[thirdRow]!)).toEqual([]);
      vt.sendInput(`\u001B[<0;${endpoint + 1};${secondRow + 1}m`);
      await vt.waitForRender();
      expect(state.editor.getCursor()).toEqual({ line: 1, col: 1 });
      expect(vt.getCursorPosition()).toEqual({ x: endpoint, y: secondRow });
    } finally {
      state.ui.stop();
    }
  });

  it('immediately clears a dragged editor selection and shows one caret at the clicked position', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('dddd\naaa\neee');
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('dddd'));
      const thirdRow = rows.findIndex((line) => line.includes('eee'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(thirdRow).toBeGreaterThan(firstRow);
      const start = rows[firstRow]!.indexOf('dddd') + 1;
      const endpoint = start + 1;
      const click = rows[thirdRow]!.indexOf('eee');
      vt.sendInput(`\u001B[<0;${start + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${endpoint + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<0;${endpoint + 1};${firstRow + 1}m`);
      await vt.waitForRender();

      vt.sendInput(`\u001B[<0;${click + 1};${thirdRow + 1}M`);
      vt.sendInput(`\u001B[<0;${click + 1};${thirdRow + 1}m`);
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(state.editor.getCursor()).toEqual({ line: 2, col: 0 });
      expect(alt.hasActiveSelection()).toBe(false);
      expect(highlightedText(alt.getScreenLines()[firstRow]!)).toEqual([]);
      expect(highlightedText(alt.getScreenLines()[thirdRow]!)).toEqual(['e']);
    } finally {
      state.ui.stop();
    }
  });

  it('replaces a dragged multiline editor selection with typed input', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('first\nsecond\nthird');
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('first'));
      const lastRow = rows.findIndex((line) => line.includes('third'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      const start = rows[firstRow]!.indexOf('first') + 1;
      const end = rows[lastRow]!.indexOf('third') + 3;
      vt.sendInput(`\u001B[<0;${start + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${end + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${end + 1};${lastRow + 1}m`);
      await vt.waitForRender();

      vt.sendInput('X');
      await vt.waitForRender();

      expect(state.editor.getText()).toBe('fXd');
      expect(state.editor.getCursor()).toEqual({ line: 0, col: 2 });
      expect(alt.hasActiveSelection()).toBe(false);
    } finally {
      state.ui.stop();
    }
  });

  it('deletes a dragged multiline selection in the docked editor', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('first\nsecond\nthird');
      alt.renderNow();
      await vt.flush();
      const rows = screenRows(vt);
      const firstRow = rows.findIndex((line) => line.includes('first'));
      const lastRow = rows.findIndex((line) => line.includes('third'));
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeGreaterThan(firstRow);
      const start = rows[firstRow]!.indexOf('first') + 1;
      const end = rows[lastRow]!.indexOf('third') + 3;

      vt.sendInput(`\u001B[<0;${start + 1};${firstRow + 1}M`);
      vt.sendInput(`\u001B[<32;${end + 1};${lastRow + 1}M`);
      vt.sendInput(`\u001B[<0;${end + 1};${lastRow + 1}m`);
      await vt.waitForRender();
      vt.sendInput('\u007F');
      await vt.waitForRender();

      expect(state.editor.getText()).toBe('fd');
    } finally {
      state.ui.stop();
    }
  });

  it('deletes the complete horizontally scrolled search query after triple click through KimiTUI', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      vt.sendInput('\u001B[102;6u');
      vt.sendInput('abcdefghijklmnopqrstuvwxyz0123456789');
      await vt.waitForRender();
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('No matches'));
      expect(row).toBeGreaterThanOrEqual(0);
      const line = rows[row]!;
      const borderIndex = line.indexOf('│');
      expect(borderIndex).toBeGreaterThanOrEqual(0);
      const clickColumn = borderIndex + 3;
      for (let click = 0; click < 3; click++) {
        vt.sendInput(`\u001B[<0;${clickColumn};${row + 1}M`);
        vt.sendInput(`\u001B[<0;${clickColumn};${row + 1}m`);
        await vt.waitForRender();
      }
      await vt.waitForRender();

      vt.sendInput('\u001B[3~');
      await vt.waitForRender();
      expect(screenRows(vt).some((line) => line.includes('Find in transcript'))).toBe(true);
    } finally {
      state.ui.stop();
    }
  });

  it('replaces a search selection with bracketed paste through KimiTUI without changing the editor', async () => {
    const { driver, vt } = mountFullscreenKimiTui();
    const { state } = driver;
    try {
      const alt = state.ui as TuiAltScreen;
      alt.setCopyOnSelect(false);
      state.editor.setText('bottom\ndraft');
      const editorCursor = state.editor.getCursor();
      state.ui.requestRender();
      await vt.waitForRender();

      vt.sendInput('\u001B[102;6u');
      vt.sendInput('hello world');
      await vt.waitForRender();
      const searchFocus = alt.getFocusedComponent();
      expect(searchFocus).not.toBe(state.editor);
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('hello world'));
      expect(row).toBeGreaterThanOrEqual(0);
      const start = rows[row]!.indexOf('world');
      expect(start).toBeGreaterThanOrEqual(0);
      vt.sendInput(`\u001B[<0;${start + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${start + 5};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${start + 5};${row + 1}m`);
      await vt.waitForRender();
      expect(alt.hasActiveSelection()).toBe(true);

      vt.sendInput('\u001B[200~PASTE\u001B[201~');
      await vt.waitForRender();

      expect(screenRows(vt).some((line) => line.includes('hello PASTE'))).toBe(true);
      expect(screenRows(vt).some((line) => line.includes('hello worldPASTE'))).toBe(false);
      expect(state.editor.getText()).toBe('bottom\ndraft');
      expect(state.editor.getCursor()).toEqual(editorCursor);
      expect(state.editor.focused).toBe(false);
      expect(alt.getFocusedComponent()).toBe(searchFocus);
      expect(alt.hasActiveSelection()).toBe(false);
    } finally {
      state.ui.stop();
    }
  });

  it('deletes a dragged selection in the docked editor', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      (state.ui as TuiAltScreen).setCopyOnSelect(false);
      state.editor.setText('hello world');
      state.ui.requestRender();
      await vt.waitForRender();
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('hello world'));
      expect(row).toBeGreaterThanOrEqual(0);
      const start = rows[row]!.indexOf('world');
      expect(start).toBeGreaterThanOrEqual(0);
      vt.sendInput(`\u001B[<0;${start + 1};${row + 1}M`);
      vt.sendInput(`\u001B[<32;${start + 5};${row + 1}M`);
      vt.sendInput(`\u001B[<0;${start + 5};${row + 1}m`);
      await vt.waitForRender();
      vt.sendInput('\u007F');
      vt.sendInput('X');
      await vt.waitForRender();

      expect(state.editor.getText()).toBe('hello X');
    } finally {
      state.ui.stop();
    }
  });

  it('deletes the current logical line on triple click in the docked editor', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      (state.ui as TuiAltScreen).setCopyOnSelect(false);
      state.editor.setText('first\nsecond');
      state.ui.requestRender();
      await vt.waitForRender();
      const rows = screenRows(vt);
      const row = rows.findIndex((line) => line.includes('second'));
      expect(row).toBeGreaterThanOrEqual(0);
      const column = rows[row]!.indexOf('second') + 2;
      for (let click = 0; click < 3; click++) {
        vt.sendInput(`\u001B[<0;${column};${row + 1}M`);
        vt.sendInput(`\u001B[<0;${column};${row + 1}m`);
      }
      await vt.waitForRender();
      vt.sendInput('\u007F');
      await vt.waitForRender();

      expect(state.editor.getText()).toBe('first\n');
    } finally {
      state.ui.stop();
    }
  });

  it('selects and deletes all docked editor text with Ctrl+Shift+A', async () => {
    const { state, vt } = await mountFullscreen();
    try {
      (state.ui as TuiAltScreen).setCopyOnSelect(false);
      state.editor.setText('first\nsecond');
      state.ui.requestRender();
      await vt.waitForRender();
      vt.sendInput('\u001B[97;6u');
      await vt.waitForRender();
      vt.sendInput('\u007F');
      await vt.waitForRender();

      expect(state.editor.getText()).toBe('');
    } finally {
      state.ui.stop();
    }
  });
});
