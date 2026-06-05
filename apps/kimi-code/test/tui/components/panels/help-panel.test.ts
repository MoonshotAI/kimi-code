import { describe, it, expect, vi } from 'vitest';

import type { KimiSlashCommand } from '#/tui/commands/index';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { darkColors } from '#/tui/theme/colors';

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
  it('renders keyboard shortcuts + slash commands sections', () => {
    const panel = new HelpPanelComponent({
      commands: [cmd('exit', 'Exit', ['quit', 'q'])],
      colors: darkColors,
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
      colors: darkColors,
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
      colors: darkColors,
      onClose,
    });
    panel.handleInput('\u001B'); // Esc
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q / Enter also close the panel', () => {
    const onClose = vi.fn();
    const panel = new HelpPanelComponent({
      commands: [],
      colors: darkColors,
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
      colors: darkColors,
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
      colors: darkColors,
      onClose: () => {},
      maxVisible: 6,
    });
    panel.handleInput('\u001B[B'); // ↓
    panel.handleInput('\u001B[B'); // ↓
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/showing 3-8 of/);
    panel.handleInput('\u001B[A'); // ↑
    const out2 = strip(panel.render(80).join('\n'));
    expect(out2).toMatch(/showing 2-7 of/);
  });
});
