import { ScrollView, Text, TuiAltScreen, VStack } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import { BtwPanelComponent } from '#/tui/components/panes/btw-panel';
import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePanel(overrides: Partial<ConstructorParameters<typeof BtwPanelComponent>[0]> = {}): BtwPanelComponent {
  return new BtwPanelComponent({
    markdownTheme: createMarkdownTheme(),
    canUseScrollKeys: () => false,
    onPrompt: () => {},
    terminalRows: () => 0,
    ...overrides,
  });
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

  it('bounds regular-mode render height to one third of terminal rows and shrinks when terminal rows decrease', () => {
    let rows = 15;
    const panel = makePanel({ terminalRows: () => rows });
    panel.submit('long answer');
    panel.appendAnswer(Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`).join('\n'));
    panel.markDone();

    const rendered = panel.render(50).map(strip);
    expect(rendered).toHaveLength(5);
    expect(rendered[0]).toMatch(/^╭ BTW ─ Esc close ─+╮$/);
    expect(rendered.at(-1)).toContain('line 20');

    rows = 4;
    const shrunk = panel.render(50).map(strip);
    expect(shrunk).toHaveLength(3);
    expect(shrunk.at(-1)).toContain('line 20');
  });

  it('refreshes cached turn styling when theme palette changes without explicit invalidate', () => {
    const previousLevel = chalk.level;
    const previousPalette = currentTheme.palette;
    try {
      chalk.level = 3;
      currentTheme.setPalette(darkColors);
      const panel = makePanel();
      panel.submit('theme check');
      panel.appendAnswer('hello world');
      panel.markDone();
      const darkPromptLine = panel.render(50)[1];

      currentTheme.setPalette(lightColors);
      const lightPromptLine = panel.render(50)[1];
      expect(lightPromptLine).not.toBe(darkPromptLine);
    } finally {
      currentTheme.setPalette(previousPalette);
      chalk.level = previousLevel;
    }
  });

  it('supports fullscreen Box + ScrollView wheel scrolling, overscroll containment, clean copy without borders, and top-bar close click', async () => {
    let copied = '';
    const onClose = vi.fn();
    const vt = new VirtualTerminal(60, 15);
    const ui = new TuiAltScreen(vt, undefined, undefined, {
      copySelection: async (text) => {
        copied = text;
        return true;
      },
    });
    const transcript = new ScrollView(
      new Text(Array.from({ length: 20 }, (_, i) => `chat ${String(i + 1)}`).join('\n'), 0, 0),
      { follow: 'end', primary: true },
    );
    const panel = makePanel({
      fullscreen: true,
      terminalRows: () => vt.rows,
      canUseScrollKeys: () => true,
      onClose,
    });
    panel.submit('explain');
    panel.appendAnswer(Array.from({ length: 12 }, (_, i) => `ans-${String(i + 1)}`).join('\n\n'));
    panel.markDone();

    const root = new VStack([
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: panel, shrink: 1, minSize: 0 },
    ]);
    ui.addLayoutEffect(() => {
      if (panel.consumeOverflowChange()) ui.requestRender();
    });
    ui.setLayoutRoot(root);
    ui.start();
    await vt.waitForRender();
    try {
      let screen = vt.getViewport().map(strip);
      const topRow = screen.findIndex((line) => line.includes('BTW ─ Esc close'));
      expect(topRow).toBeGreaterThan(0);
      expect(screen[topRow]).toContain('↑↓ scroll');
      expect(screen.join('\n')).toContain('ans-12');
      const initialTranscriptTop = transcript.scrollTop;

      vt.sendInput(`\u001B[<64;10;${String(topRow + 2)}M`);
      vt.sendInput(`\u001B[<64;10;${String(topRow + 2)}M`);
      vt.sendInput(`\u001B[<64;10;${String(topRow + 2)}M`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);
      expect(transcript.scrollTop).toBe(initialTranscriptTop);

      for (let i = 0; i < 30; i++) {
        vt.sendInput(`\u001B[<64;3;${String(topRow + 2)}M`);
      }
      await vt.waitForRender();
      expect(transcript.scrollTop).toBe(initialTranscriptTop);

      const exitSnapshot = panel.render(60).map(strip).join('\n');
      expect(exitSnapshot).toContain('Q: explain');
      expect(exitSnapshot).not.toContain('ans-12');

      screen = vt.getViewport().map(strip);
      const bodyRow = topRow + 1;
      vt.sendInput(`\u001B[<0;3;${String(bodyRow + 1)}M`);
      vt.sendInput(`\u001B[<32;12;${String(bodyRow + 2)}M`);
      vt.sendInput(`\u001B[<0;12;${String(bodyRow + 2)}m`);
      await vt.waitForRender();
      expect(copied).not.toContain('│');
      expect(copied).toContain('Q: explain');

      const closeCol = screen[topRow]!.indexOf('Esc close') + 2;
      vt.sendInput(`\u001B[<0;${String(closeCol)};${String(topRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(closeCol)};${String(topRow + 1)}m`);
      await vt.waitForRender();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      ui.stop();
    }
  });

  it('toggles fullscreen mode in place while preserving turns and scrolled position', async () => {
    const vt = new VirtualTerminal(60, 15);
    const panel = makePanel({
      fullscreen: false,
      terminalRows: () => vt.rows,
      canUseScrollKeys: () => true,
    });
    panel.submit('side question');
    panel.appendAnswer(Array.from({ length: 16 }, (_, i) => `row-${String(i + 1)}`).join('\n\n'));
    panel.markDone();

    expect(panel.render(60).map(strip)[0]).toMatch(/^╭ BTW ─/);
    for (let i = 0; i < 40; i++) panel.scroll('up');
    const regularTopSnapshot = panel.render(60).map(strip).join('\n');
    expect(regularTopSnapshot).toContain('Q: side question');
    expect(regularTopSnapshot).not.toContain('row-16');

    panel.setFullscreen(true);
    const ui = new TuiAltScreen(vt);
    const transcript = new ScrollView(new Text('chat line', 0, 0), { follow: 'end', primary: true });
    const root = new VStack([
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: panel, shrink: 1, minSize: 0 },
    ]);
    ui.addLayoutEffect(() => {
      if (panel.consumeOverflowChange()) ui.requestRender();
    });
    ui.setLayoutRoot(root);
    ui.start();
    try {
      await vt.waitForRender();
      const fullscreenScreen = vt.getViewport().map(strip).join('\n');
      expect(fullscreenScreen).toContain('↑↓ scroll');
      expect(fullscreenScreen).toContain('Q: side question');
      expect(fullscreenScreen).not.toContain('row-16');

      const topRow = vt.getViewport().map(strip).findIndex((line) => line.includes('BTW ─ Esc close'));
      expect(topRow).toBeGreaterThan(0);
      for (let i = 0; i < 40; i++) {
        vt.sendInput(`\u001B[<65;10;${String(topRow + 2)}M`);
      }
      await vt.waitForRender();
      expect(vt.getViewport().map(strip).join('\n')).toContain('row-16');

      panel.setFullscreen(false);
      const backToRegular = panel.render(60).map(strip);
      expect(backToRegular[0]).toMatch(/^╭ BTW ─/);
      expect(backToRegular.join('\n')).toContain('row-16');
    } finally {
      ui.stop();
    }
  });
});
