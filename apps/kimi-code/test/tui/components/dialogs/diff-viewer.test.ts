import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiffViewerComponent } from '#/tui/components/dialogs/diff-viewer';
import { currentTheme } from '#/tui/theme';

afterEach(() => {
  vi.restoreAllMocks();
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('DiffViewerComponent', () => {
  it('renders initial lines and a back footer', () => {
    const component = new DiffViewerComponent({
      initialLines: ['line 1', 'line 2'],
      onBack: vi.fn(),
    });

    const output = component.render(40).map(strip);
    expect(output[0]).toContain('Diff viewer');
    expect(output.some((line) => line.includes('line 1'))).toBe(true);
    expect(output.some((line) => line.includes('line 2'))).toBe(true);
    expect(output.at(-1)).toContain('Esc to return');
  });

  it('calls onBack when Escape is pressed', () => {
    const onBack = vi.fn();
    const component = new DiffViewerComponent({ onBack });

    component.handleInput('\u001B');

    expect(onBack).toHaveBeenCalled();
  });

  it('toggles expanded context on ctrl+o and updates lines', async () => {
    const onToggleExpand = vi.fn().mockResolvedValue(['expanded line']);
    const component = new DiffViewerComponent({
      initialLines: ['collapsed line'],
      onToggleExpand,
      onBack: vi.fn(),
    });

    component.handleInput('\u000F'); // ctrl+o

    await vi.waitFor(() => {
      const output = component.render(40).map(strip);
      expect(output.some((line) => line.includes('expanded line'))).toBe(true);
    });
    expect(onToggleExpand).toHaveBeenCalledWith(true);
  });

  it('requests a render after async expansion finishes', async () => {
    const onToggleExpand = vi.fn().mockResolvedValue(['expanded line']);
    const requestRender = vi.fn();
    const component = new DiffViewerComponent({
      initialLines: ['collapsed line'],
      onToggleExpand,
      onBack: vi.fn(),
      requestRender,
    });

    component.handleInput('\u000F'); // ctrl+o

    await vi.waitFor(() => {
      const output = component.render(40).map(strip);
      expect(output.some((line) => line.includes('expanded line'))).toBe(true);
    });
    expect(requestRender).toHaveBeenCalled();
  });

  it('requests a render after an expand failure', async () => {
    const onToggleExpand = vi.fn().mockRejectedValue(new Error('boom'));
    const requestRender = vi.fn();
    const component = new DiffViewerComponent({
      initialLines: ['collapsed line'],
      onToggleExpand,
      onBack: vi.fn(),
      requestRender,
    });

    component.handleInput('\u000F'); // ctrl+o

    await vi.waitFor(() => {
      const output = component.render(40).map(strip);
      expect(output.some((line) => line.includes('Failed to load expanded diff'))).toBe(true);
    });
    expect(requestRender).toHaveBeenCalled();
  });

  it('resets toggling state after an expand failure so ctrl+o remains usable', async () => {
    const onToggleExpand = vi.fn().mockRejectedValue(new Error('boom'));
    const component = new DiffViewerComponent({
      initialLines: ['collapsed line'],
      onToggleExpand,
      onBack: vi.fn(),
    });

    component.handleInput('\u000F'); // ctrl+o

    await vi.waitFor(() => {
      const output = component.render(40).map(strip);
      expect(output.some((line) => line.includes('Failed to load expanded diff'))).toBe(true);
    });

    // A second ctrl+o should still be accepted (toggling was reset).
    onToggleExpand.mockResolvedValueOnce(['recovered line']);
    component.handleInput('\u000F');

    await vi.waitFor(() => {
      const output = component.render(40).map(strip);
      expect(output.some((line) => line.includes('recovered line'))).toBe(true);
    });
  });
});
