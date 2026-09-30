import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { PluginSummary } from '@moonshot-ai/harness-core/features/plugin/index';

import {
  PluginsSelectorComponent,
  type PluginsSelectorOptions,
} from '#/tui/components/dialogs/plugins-selector';

function makeSummary(id: string, enabled: boolean): PluginSummary {
  return {
    id,
    displayName: `Plugin ${id}`,
    enabled,
    state: 'ok',
    skillCount: 2,
    mcpServerCount: 1,
    enabledMcpServerCount: enabled ? 1 : 0,
    hookCount: 0,
    commandCount: 1,
    hasErrors: false,
    source: 'github',
  };
}

function makeSelector(plugins: readonly PluginSummary[] = [makeSummary('alpha', true), makeSummary('beta', false)]) {
  const opts: PluginsSelectorOptions = {
    plugins,
    onToggle: vi.fn(),
    onRemove: vi.fn(),
    onReload: vi.fn(),
    onClose: vi.fn(),
  };
  return { selector: new PluginsSelectorComponent(opts), opts };
}

describe('PluginsSelectorComponent', () => {
  it('toggles the selected plugin on Space', () => {
    const { selector, opts } = makeSelector();

    selector.handleInput(' ');

    expect(opts.onToggle).toHaveBeenCalledWith('alpha', false);
  });

  it('toggles a disabled plugin on after navigating down', () => {
    const { selector, opts } = makeSelector();

    selector.handleInput('[B');
    selector.handleInput(' ');

    expect(opts.onToggle).toHaveBeenCalledWith('beta', true);
  });

  it('removes a plugin only after the y confirmation', () => {
    const { selector, opts } = makeSelector();

    selector.handleInput('d');
    expect(opts.onRemove).not.toHaveBeenCalled();
    selector.handleInput('n');
    selector.handleInput('d');
    selector.handleInput('y');

    expect(opts.onRemove).toHaveBeenCalledTimes(1);
    expect(opts.onRemove).toHaveBeenCalledWith('alpha');
  });

  it('reloads on R and closes on Esc', () => {
    const { selector, opts } = makeSelector();

    selector.handleInput('r');
    expect(opts.onReload).toHaveBeenCalledTimes(1);
    selector.handleInput('');
    expect(opts.onClose).toHaveBeenCalledTimes(1);
  });

  it('renders enable/disable state labels within width', () => {
    const { selector } = makeSelector();

    const lines = selector.render(60).map((line) => line.replaceAll(/\[[0-9;]*m/g, ''));
    expect(lines.some((line) => line.includes('Plugin alpha') && line.includes('enabled'))).toBe(true);
    expect(lines.some((line) => line.includes('Plugin beta') && line.includes('disabled'))).toBe(true);
    for (const line of selector.render(40)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('keeps the selection on setOptions by plugin id', () => {
    const { selector, opts } = makeSelector();
    selector.handleInput('[B');

    selector.setOptions({ ...opts, plugins: [makeSummary('beta', true)] });
    selector.handleInput(' ');

    expect(opts.onToggle).toHaveBeenCalledWith('beta', false);
  });
});
