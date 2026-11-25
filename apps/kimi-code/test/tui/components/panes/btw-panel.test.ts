import {
  Spacer,
  Text,
  TuiAltScreen,
  visibleWidth,
  type Terminal,
} from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BtwPanelComponent } from '#/tui/components/panes/btw-panel';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { createTUIState, mountFooter } from '#/tui/tui-state';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { AppState } from '#/tui/types';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;?]*[a-zA-Z]/g, '')
    .replaceAll(/\u001B\][^\u0007]*\u0007/g, '');
}

function makePanel(
  overrides: Partial<ConstructorParameters<typeof BtwPanelComponent>[0]> = {},
): BtwPanelComponent {
  return new BtwPanelComponent({
    markdownTheme: createMarkdownTheme(),
    canUseScrollKeys: () => false,
    onPrompt: () => {},
    terminalRows: () => 0,
    ...overrides,
  });
}

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

async function mountFullscreenWithBtw(
  panel: BtwPanelComponent,
  width = 80,
  height = 24,
): Promise<{
  state: ReturnType<typeof createTUIState>;
  vt: VirtualTerminal;
}> {
  const state = createTUIState({
    initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  });
  const vt = new VirtualTerminal(width, height);
  (state.ui as { terminal: Terminal }).terminal = vt;
  mountFooter(state);
  state.editorContainer.addChild(state.editor);
  state.btwPanelContainer.addChild(new Spacer(1));
  state.btwPanelContainer.addChild(panel);
  state.editor.connectedAbove = true;
  state.ui.setFocus(state.editor);
  state.ui.start();
  await vt.waitForRender();
  return { state, vt };
}

function addTurns(panel: BtwPanelComponent, count: number): void {
  for (let i = 1; i <= count; i++) {
    panel.submit(`question ${String(i)}`);
    panel.appendAnswer(`answer ${String(i)}`);
    panel.markDone();
  }
}

describe('BtwPanelComponent', () => {
  it('defers mermaid drawing until the turn completes', () => {
    const panel = makePanel();
    panel.submit('draw a flow');
    panel.appendAnswer('```mermaid\nflowchart LR\n  A-->B\n```\n');

    const streaming = strip(panel.render(60).join('\n'));
    expect(streaming).toContain('A-->B');
    expect(streaming).not.toContain('┌');

    panel.markDone();
    const done = strip(panel.render(60).join('\n'));
    expect(done).not.toContain('A-->B');
    expect(done).toContain('┌');
  });

  it('preserves regular-mode borders, dynamic height cap, and keyboard scrolling without scrollbars', () => {
    const panel = makePanel({
      canUseScrollKeys: () => true,
      terminalRows: () => 15,
    });
    addTurns(panel, 8);

    const lines = panel.render(60).map(strip);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^╭ BTW ─ Esc close · ↑↓ scroll ─+╮$/);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(60);
    }
    for (const bodyLine of lines.slice(1)) {
      expect(bodyLine.startsWith('│ ')).toBe(true);
      expect(bodyLine.endsWith(' │')).toBe(true);
      expect(bodyLine).not.toMatch(/[┃█]/);
    }
    expect(lines.join('\n')).toContain('answer 8');
    expect(lines.join('\n')).not.toContain('question 1');

    for (let i = 0; i < 25; i++) {
      expect(panel.scroll('up')).toBe(true);
    }
    const scrolledUp = panel.render(60).map(strip).join('\n');
    expect(scrolledUp).toContain('question 1');
    expect(scrolledUp).not.toContain('answer 8');

    for (let i = 0; i < 25; i++) {
      expect(panel.scroll('down')).toBe(true);
    }
    const scrolledDown = panel.render(60).map(strip).join('\n');
    expect(scrolledDown).toContain('answer 8');
  });

  it('aligns fullscreen borders with the editor, paints the scrollbar inside the right rail, and omits it on direct render', async () => {
    const width = 80;
    const height = 24;
    const panel = makePanel({
      gutter: CHROME_GUTTER,
      canUseScrollKeys: () => true,
      terminalRows: () => height,
    });
    addTurns(panel, 10);

    const { state, vt } = await mountFullscreenWithBtw(panel, width, height);
    onTestFinished(() => state.ui.stop());

    const rows = vt.getViewport().map(strip);
    const topIdx = rows.findIndex((row) => row.includes('╭ BTW'));
    const editorTopIdx = rows.findIndex((row) => row.includes('├'));
    expect(topIdx).toBeGreaterThan(0);
    expect(editorTopIdx - topIdx).toBe(Math.floor(height / 3));

    const topRow = rows[topIdx]!;
    const editorTopRow = rows[editorTopIdx]!;
    expect(topRow[0]).toBe(' ');
    expect(topRow[1]).toBe('╭');
    expect(topRow[width - 2]).toBe('╮');
    expect(editorTopRow[1]).toBe('├');
    expect(editorTopRow[width - 2]).toBe('┤');

    const bodyRows = rows.slice(topIdx + 1, editorTopIdx);
    expect(bodyRows).toHaveLength(Math.floor(height / 3) - 1);
    for (const row of bodyRows) {
      expect(row[0]).toBe(' ');
      expect(row[1]).toBe('│');
      expect(row[width - 2]).toBe('│');
    }
    expect(bodyRows.some((row) => row[width - 3] === '┃' || row[width - 3] === '│')).toBe(true);

    const directRows = panel.render(width).map(strip);
    expect(directRows).toHaveLength(Math.floor(height / 3));
    expect(directRows[0]![1]).toBe('╭');
    expect(directRows[0]![width - 2]).toBe('╮');
    for (const row of directRows.slice(1)) {
      expect(row[1]).toBe('│');
      expect(row[width - 3]).toBe(' ');
      expect(row[width - 2]).toBe('│');
    }
  });

  it('contains fullscreen mouse wheel scrolling inside the BTW ScrollView without leaking to the transcript', async () => {
    const width = 80;
    const height = 24;
    const panel = makePanel({
      gutter: CHROME_GUTTER,
      canUseScrollKeys: () => true,
      terminalRows: () => height,
    });
    addTurns(panel, 10);

    const { state, vt } = await mountFullscreenWithBtw(panel, width, height);
    onTestFinished(() => state.ui.stop());
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 40 }, (_, i) => `transcript line ${String(i + 1)}`).join('\n'), 0, 0),
    );
    const alt = state.ui as TuiAltScreen;
    alt.renderNow();
    await vt.flush();

    const rowsBefore = vt.getViewport().map(strip);
    const topIdx = rowsBefore.findIndex((row) => row.includes('╭ BTW'));
    const bodyRow = topIdx + 2;
    const initialTranscriptTop = alt.viewportTop;
    expect(initialTranscriptTop).toBeGreaterThan(0);
    expect(rowsBefore.join('\n')).toContain('answer 10');
    expect(rowsBefore.join('\n')).not.toMatch(/Q: question 1\b/);

    for (let i = 0; i < 30; i++) {
      vt.sendInput(`\u001B[<64;10;${String(bodyRow + 1)}M`);
    }
    await vt.waitForRender();

    const rowsAfterUp = vt.getViewport().map(strip);
    expect(rowsAfterUp.join('\n')).toMatch(/Q: question 1\b/);
    expect(rowsAfterUp.join('\n')).not.toContain('answer 10');
    expect(alt.viewportTop).toBe(initialTranscriptTop);

    for (let i = 0; i < 30; i++) {
      vt.sendInput(`\u001B[<65;10;${String(bodyRow + 1)}M`);
    }
    await vt.waitForRender();

    const rowsAfterDown = vt.getViewport().map(strip);
    expect(rowsAfterDown.join('\n')).toContain('answer 10');
    expect(alt.viewportTop).toBe(initialTranscriptTop);
  });

  it('closes on clicking Esc close without stealing focus from the editor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const onClose = vi.fn();
    const panel = makePanel({
      gutter: CHROME_GUTTER,
      terminalRows: () => 24,
      onClose,
    });
    panel.submit('quick question');
    panel.appendAnswer('quick answer');
    panel.markDone();

    const { state, vt } = await mountFullscreenWithBtw(panel, 80, 24);
    onTestFinished(() => {
      state.ui.stop();
      vi.useRealTimers();
    });

    const rows = vt.getViewport().map(strip);
    const topIdx = rows.findIndex((row) => row.includes('╭ BTW'));
    const closeCol = rows[topIdx]!.indexOf('Esc close');
    expect(closeCol).toBeGreaterThan(0);
    expect(state.editor.focused).toBe(true);

    vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(topIdx + 1)}M`);
    vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(topIdx + 1)}m`);
    await vt.waitForRender();
    expect(onClose).not.toHaveBeenCalled();

    vi.setSystemTime(10_400);
    const btwCol = rows[topIdx]!.indexOf('BTW');
    vt.sendInput(`\u001B[<0;${String(btwCol + 1)};${String(topIdx + 1)}M`);
    vt.sendInput(`\u001B[<0;${String(btwCol + 1)};${String(topIdx + 1)}m`);
    await vt.waitForRender();
    expect(onClose).not.toHaveBeenCalled();
    expect(state.editor.focused).toBe(true);

    vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(topIdx + 1)}M`);
    vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(topIdx + 1)}m`);
    await vt.waitForRender();
    expect(onClose).toHaveBeenCalledOnce();
    expect(state.editor.focused).toBe(true);
  });

  it('settles cleanly in a squeezed fullscreen terminal without looping', async () => {
    const panel = makePanel({
      gutter: CHROME_GUTTER,
      terminalRows: () => 8,
    });
    addTurns(panel, 2);

    const { state, vt } = await mountFullscreenWithBtw(panel, 60, 8);
    onTestFinished(() => state.ui.stop());

    const rows = vt.getViewport().map(strip);
    expect(rows.some((row) => row.includes('╭ BTW'))).toBe(true);
  });
});
