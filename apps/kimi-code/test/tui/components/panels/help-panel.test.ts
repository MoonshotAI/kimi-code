import {
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

import type { KimiSlashCommand } from '#/tui/commands/index';
import { HelpPanelComponent, keyboardShortcuts } from '#/tui/components/dialogs/help-panel';
import { DOCK_PREVIEW_ROWS } from '#/tui/constant/rendering';

function cmd(name: string, description: string, aliases: string[] = []): KimiSlashCommand {
  return {
    name,
    aliases,
    description,
  };
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('HelpPanelComponent', () => {
  const QUEUES = 'Submit; queues while Kimi is working';
  const STEERS = 'Submit; steers into the running turn';

  it.each([
    ['queue', true, { Enter: QUEUES, 'Ctrl-Enter': STEERS, 'Ctrl-Q': QUEUES }],
    ['queue', false, { Enter: QUEUES, 'Ctrl-Q': QUEUES }],
    ['steer', true, { Enter: STEERS, 'Ctrl-Enter': QUEUES, 'Ctrl-Q': QUEUES }],
    ['steer', false, { Enter: STEERS, 'Ctrl-Q': QUEUES }],
  ] as const)(
    'describes the submit keys for follow_up_behavior %s (Ctrl-Enter recognized: %s)',
    (followUpBehavior, ctrlEnterRecognized, expected) => {
      const submitKeys = Object.fromEntries(
        keyboardShortcuts(followUpBehavior, ctrlEnterRecognized)
          .filter((shortcut) => ['Enter', 'Ctrl-Enter', 'Ctrl-Q'].includes(shortcut.keys))
          .map((shortcut) => [shortcut.keys, shortcut.description]),
      );

      expect(submitKeys).toEqual(expected);
    },
  );

  it('renders keyboard shortcuts + slash commands sections', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit', ['quit', 'q'])],
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/help/);
    expect(out).toMatch(/Keyboard shortcuts/);
    expect(out).toMatch(/Shift-Tab/);
    expect(out).toMatch(/Ctrl-O/);
    expect(out).toMatch(/Shift-Enter \/ Ctrl-J/);
    expect(out).toMatch(/Slash commands/);
    expect(out).toMatch(/\/exit \(\/quit, \/q\)/);
    expect(out).toMatch(/Exit/);
  });

  it('sorts unprefixed commands before skill commands and by name within each group', () => {
    const panel = new HelpPanelComponent({
      commands: [
        cmd('zebra', 'Z'),
        cmd('skill:bravo', 'B'),
        cmd('alpha', 'A'),
        cmd('mcp-config', 'M'),
      ],
      onClose: () => {},
    });
    const out = strip(panel.render(80).join('\n'));
    const alphaIdx = out.indexOf('/alpha');
    const mcpConfigIdx = out.indexOf('/mcp-config');
    const zebraIdx = out.indexOf('/zebra');
    const skillBravoIdx = out.indexOf('/skill:bravo');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(mcpConfigIdx);
    expect(mcpConfigIdx).toBeLessThan(zebraIdx);
    expect(zebraIdx).toBeLessThan(skillBravoIdx);
  });

  it('Escape fires onClose', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('\u001B');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q / Enter also close the panel', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      onClose,
    });
    panel.handleInput('q');
    panel.handleInput('\r');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('clips to maxVisible with a "showing X-Y of Z" tail', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, `Desc ${String(i)}`));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 1-6 of/);
  });

  it('arrow keys shift the scroll window', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.handleInput('\u001B[B');
    panel.handleInput('\u001B[B');
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 3-8 of/);
    panel.handleInput('\u001B[A');
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/showing 2-7 of/);
  });

  it('supports Home/End keys and wheel scrolling in regular mode', () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${String(i)}`, 'd'));
    const panel = new HelpPanelComponent({
      commands: many,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.focused = true;
    panel.render(80);

    const body = panel.children[1] as Component;
    const wheel = (delta: number): TuiMouseEvent => ({
      type: 'wheel',
      button: 'none',
      x: 4,
      y: 2,
      screenX: 4,
      screenY: 2,
      width: 80,
      height: 7,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: delta,
    });

    expect(body.handleMouse?.(wheel(3))).toEqual({ handled: true, render: true });
    expect(strip(panel.render(80).join('\n'))).toMatch(/showing 4-9 of/);

    panel.handleInput('\u001B[F');
    const endOut = strip(panel.render(80).join('\n'));
    expect(endOut).toContain('/cmd9');

    panel.handleInput('\u001B[H');
    expect(strip(panel.render(80).join('\n'))).toMatch(/showing 1-6 of/);
  });

  describe('fullscreen DockSection mode', () => {
    function screenRows(vt: VirtualTerminal): string[] {
      return vt.getViewport().map((row) => strip(row).trimEnd());
    }

    async function mountDocked(
      panel: HelpPanelComponent,
      height = 16,
      width = 80,
    ): Promise<{ ui: TuiAltScreen; vt: VirtualTerminal; otherFocus: Component & { focused: boolean } }> {
      const vt = new VirtualTerminal(width, height);
      const ui = new TuiAltScreen(vt);
      const transcript = new ScrollView(
        new Text(
          Array.from({ length: 40 }, (_, i) => `transcript ${String(i + 1)}`).join('\n'),
          0,
          0,
        ),
        { follow: 'end', primary: true },
      );
      const otherFocus: Component & { focused: boolean } = {
        focused: false,
        render: () => [],
        invalidate() {},
      };
      const root = new VStack();
      root.addChild(transcript, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
      root.addChild(panel, { basis: 'auto', grow: 0, shrink: 1, minSize: 3 });
      ui.setLayoutRoot(root);
      ui.setFocus(panel);
      ui.start();
      onTestFinished(() => ui.stop());
      await vt.waitForRender();
      return { ui, vt, otherFocus };
    }

    it('scrolls all content inside OverflowScrollView via wheel and keyboard without leaking to transcript', async () => {
      const many = Array.from({ length: 25 }, (_, i) =>
        cmd(`cmd${String(i).padStart(2, '0')}`, `Description ${String(i)}`),
      );
      const panel = new HelpPanelComponent({
        commands: many,
        onClose: vi.fn(),
        maxVisible: 6,
        layout: { maxBodyRows: DOCK_PREVIEW_ROWS },
      });
      const { ui, vt } = await mountDocked(panel, 16, 80);

      let rows = screenRows(vt);
      const headerRow = rows.findIndex((row) => row.includes('Esc / Enter / q to cancel'));
      expect(headerRow).toBeGreaterThan(0);
      expect(rows.join('\n')).not.toContain('showing ');
      expect(rows.some((row) => /[┃│]$/.test(row))).toBe(true);
      expect(rows.join('\n')).toContain('Keyboard shortcuts');
      expect(rows.join('\n')).not.toContain('/cmd24');

      const transcriptTop = ui.viewportTop;
      expect(transcriptTop).toBeGreaterThan(0);

      vt.sendInput(`\u001B[<64;5;${String(headerRow + 1)}M`);
      await vt.waitForRender();
      expect(ui.viewportTop).toBe(transcriptTop);

      vt.sendInput(`\u001B[<64;5;${String(rows.length)}M`);
      await vt.waitForRender();
      expect(ui.viewportTop).toBe(transcriptTop);

      const bodyRow = headerRow + 3;
      vt.sendInput(`\u001B[<64;5;${String(bodyRow + 1)}M`);
      await vt.waitForRender();
      expect(ui.viewportTop).toBe(transcriptTop);

      for (let i = 0; i < 6; i++) vt.sendInput(`\u001B[<65;5;${String(bodyRow + 1)}M`);
      await vt.waitForRender();
      rows = screenRows(vt);
      expect(rows[headerRow]).toContain('Esc / Enter / q to cancel');
      expect(rows.join('\n')).not.toContain('Sure, Kimi is ready to help!');
      expect(ui.viewportTop).toBe(transcriptTop);

      panel.handleInput('\u001B[F');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).toContain('/cmd24');

      panel.handleInput('\u001B[H');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).toContain('Sure, Kimi is ready to help!');

      panel.handleInput('\u001B[6~');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).not.toContain('Sure, Kimi is ready to help!');

      panel.handleInput('\u001B[5~');
      ui.requestRender();
      await vt.waitForRender();
      expect(screenRows(vt).join('\n')).toContain('Sure, Kimi is ready to help!');
    });

    it('focuses on unfocused click and closes when clicking the close hint after settling', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(10_000);
      onTestFinished(() => {
        vi.useRealTimers();
      });

      const onClose = vi.fn();
      const panel = new HelpPanelComponent({
        commands: [cmd('exit', 'Exit')],
        onClose,
        layout: { maxBodyRows: DOCK_PREVIEW_ROWS },
      });
      const { ui, vt, otherFocus } = await mountDocked(panel, 20, 80);

      const rows = screenRows(vt);
      const headerRow = rows.findIndex((row) => row.includes('Esc / Enter / q to cancel'));
      const closeCol = rows[headerRow]!.indexOf('Esc / Enter / q to cancel');
      expect(headerRow).toBeGreaterThan(0);
      expect(closeCol).toBeGreaterThan(0);

      vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(headerRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(headerRow + 1)}m`);
      await vt.waitForRender();
      expect(onClose).not.toHaveBeenCalled();

      vi.setSystemTime(10_500);
      ui.setFocus(otherFocus);
      ui.requestRender();
      await vt.waitForRender();
      expect(panel.focused).toBe(false);

      vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(headerRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(headerRow + 1)}m`);
      await vt.waitForRender();
      expect(panel.focused).toBe(true);
      expect(onClose).not.toHaveBeenCalled();

      vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(headerRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(headerRow + 1)}m`);
      await vt.waitForRender();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
