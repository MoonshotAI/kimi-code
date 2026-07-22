import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiffFileSelectorComponent } from '#/tui/components/dialogs/diff-file-selector';
import { currentTheme } from '#/tui/theme';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('DiffFileSelectorComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders changed files with status labels and optional change counts', () => {
    const component = new DiffFileSelectorComponent({
      sources: [
        {
          label: 'Current',
          files: [
            { path: 'modified.ts', status: 'modified', source: 'session' },
            { path: 'added.ts', status: 'added', source: 'git' },
            { path: 'deleted.ts', status: 'deleted', source: 'git' },
            { path: 'untracked.ts', status: 'untracked', source: 'git' },
          ],
        },
      ],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = component.render(80).map(strip).join('\n');

    expect(rendered).toContain('Uncommitted changes (git diff HEAD)');

    expect(rendered).toContain('M modified.ts');
    expect(rendered).toContain('A added.ts');
    expect(rendered).toContain('D deleted.ts');
    expect(rendered).toContain('? untracked.ts');
  });

  it('highlights only "Uncommitted changes" and grays out "(git diff HEAD)"', () => {
    const boldFgSpy = vi
      .spyOn(currentTheme, 'boldFg')
      .mockImplementation((token, text) => `<<bold:${token}:${text}>>`);
    const fgSpy = vi.spyOn(currentTheme, 'fg').mockImplementation((token, text) => `<<fg:${token}:${text}>>`);

    const component = new DiffFileSelectorComponent({
      sources: [
        {
          label: 'Current',
          files: [{ path: 'modified.ts', status: 'modified', source: 'session' }],
        },
      ],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = component.render(80).join('\n');

    expect(rendered).toContain('<<bold:primary:Uncommitted changes>>');
    expect(rendered).toContain('<<fg:textMuted:(git diff HEAD)>>');
    expect(boldFgSpy).toHaveBeenCalledWith('primary', 'Uncommitted changes');
    expect(fgSpy).toHaveBeenCalledWith('textMuted', '(git diff HEAD)');
  });

  it('calls onSelect with the selected file on Enter', () => {
    const onSelect = vi.fn();
    const component = new DiffFileSelectorComponent({
      sources: [
        {
          label: 'Current',
          files: [
            { path: 'a.ts', status: 'modified', source: 'session' },
            { path: 'b.ts', status: 'modified', source: 'git' },
          ],
        },
      ],
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput('\r'); // Enter

    expect(onSelect).toHaveBeenCalledWith({
      path: 'a.ts',
      status: 'modified',
      source: 'session',
    });
  });

  it('calls onCancel on Escape', () => {
    const onCancel = vi.fn();
    const component = new DiffFileSelectorComponent({
      sources: [
        {
          label: 'Current',
          files: [{ path: 'a.ts', status: 'modified', source: 'session' }],
        },
      ],
      onSelect: vi.fn(),
      onCancel,
    });

    component.handleInput('\u001B'); // Escape

    expect(onCancel).toHaveBeenCalled();
  });

  describe('multi-source', () => {
    it('renders multiple tabs', () => {
      const component = new DiffFileSelectorComponent({
        sources: [
          { label: 'Current', files: [{ path: 'git.txt', status: 'modified', source: 'git' }] },
          { label: 'T1', files: [{ path: 'session.txt', status: 'modified', source: 'session' }] },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });

      const rendered = component.render(80).map(strip).join('\n');

      expect(rendered).toContain('Current');
      expect(rendered).toContain('T1');
      expect(rendered).toContain('git.txt');
    });

    it('renders the turn subtitle above the tab strip', () => {
      const component = new DiffFileSelectorComponent({
        sources: [
          { label: 'Current', files: [{ path: 'git.txt', status: 'modified', source: 'git' }] },
          {
            label: 'T1',
            subtitle: 'Turn 1 "hello"',
            files: [{ path: 'session.txt', status: 'modified', source: 'session' }],
          },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });

      component.handleInput('\u001B[C'); // switch to T1
      const rendered = component.render(80).map(strip).join('\n');
      const subtitleIndex = rendered.indexOf('Turn 1 "hello"');
      const tabIndex = rendered.indexOf('Current');
      expect(subtitleIndex).toBeGreaterThan(-1);
      expect(tabIndex).toBeGreaterThan(-1);
      expect(subtitleIndex).toBeLessThan(tabIndex);
    });

    it('renders the tab label as the subtitle for an unnamed turn source', () => {
      const component = new DiffFileSelectorComponent({
        sources: [
          { label: 'Current', files: [{ path: 'git.txt', status: 'modified', source: 'git' }] },
          { label: 'T1', files: [{ path: 'session.txt', status: 'modified', source: 'session' }] },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });

      component.handleInput('\u001B[C'); // switch to T1
      const rendered = component.render(80).map(strip).join('\n');
      expect(rendered).toContain('T1');
      expect(rendered).not.toContain('Uncommitted changes');
    });

    it('renders a summary line and right-aligns stats or status labels', () => {
      const component = new DiffFileSelectorComponent({
        sources: [
          {
            label: 'Current',
            files: [
              { path: 'modified.ts', status: 'modified', source: 'git', additions: 3, deletions: 2 },
              { path: 'untracked.ts', status: 'untracked', source: 'git' },
            ],
          },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });

      const rendered = component.render(80).map(strip).join('\n');
      expect(rendered).toContain('2 files changed +3 -2');
      expect(rendered).toContain('+3 -2');
      expect(rendered).toContain('untracked');
    });

    it('switches source with left/right arrows and updates the file list', () => {
      const component = new DiffFileSelectorComponent({
        sources: [
          { label: 'Current', files: [{ path: 'git.txt', status: 'modified', source: 'git' }] },
          {
            label: 'T1',
            subtitle: 'Turn 1 "hello"',
            files: [{ path: 'session.txt', status: 'modified', source: 'session' }],
          },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });

      const first = component.render(80).map(strip).join('\n');
      expect(first).toContain('Current');
      expect(first).toContain('T1');
      expect(first).toContain('git.txt');
      expect(first).not.toContain('session.txt');
      expect(first).not.toContain('Turn 1 "hello"');

      component.handleInput('\u001B[C'); // right arrow
      const second = component.render(80).map(strip).join('\n');
      expect(second).toContain('session.txt');
      expect(second).not.toContain('git.txt');
      expect(second).toContain('Turn 1 "hello"');

      component.handleInput('\u001B[D'); // left arrow
      const third = component.render(80).map(strip).join('\n');
      expect(third).toContain('git.txt');
      expect(third).not.toContain('session.txt');
      expect(third).not.toContain('Turn 1 "hello"');
    });

    it('calls onSelect with the file from the active source', () => {
      const onSelect = vi.fn();
      const component = new DiffFileSelectorComponent({
        sources: [
          { label: 'Current', files: [{ path: 'git.txt', status: 'modified', source: 'git' }] },
          {
            label: 'T1',
            files: [{ path: 'session.txt', status: 'modified', source: 'session' }],
          },
        ],
        onSelect,
        onCancel: vi.fn(),
      });

      component.handleInput('\u001B[C'); // switch to T1
      component.handleInput('\r'); // Enter

      expect(onSelect).toHaveBeenCalledWith({
        path: 'session.txt',
        status: 'modified',
        source: 'session',
      });
    });

    it('calls onCancel on Escape when multiple sources are shown', () => {
      const onCancel = vi.fn();
      const component = new DiffFileSelectorComponent({
        sources: [
          { label: 'Current', files: [{ path: 'git.txt', status: 'modified', source: 'git' }] },
          { label: 'T1', files: [{ path: 'session.txt', status: 'modified', source: 'session' }] },
        ],
        onSelect: vi.fn(),
        onCancel,
      });

      component.handleInput('\u001B'); // Escape

      expect(onCancel).toHaveBeenCalled();
    });

    it('remembers the cursor position per source when switching tabs', () => {
      const component = new DiffFileSelectorComponent({
        sources: [
          {
            label: 'Current',
            files: [
              { path: 'a.ts', status: 'modified', source: 'git' },
              { path: 'b.ts', status: 'modified', source: 'git' },
            ],
          },
          {
            label: 'T1',
            files: [
              { path: 'x.ts', status: 'modified', source: 'session' },
              { path: 'y.ts', status: 'modified', source: 'session' },
            ],
          },
        ],
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });

      // Move to the second file in Current.
      component.handleInput('\u001B[B'); // down
      expect(component.getSelectedIndex()).toBe(1);

      // Switch to T1 and move to its second file.
      component.handleInput('\u001B[C'); // right
      component.handleInput('\u001B[B'); // down
      expect(component.getSelectedIndex()).toBe(1);

      // Switch back to Current: cursor should still be on the second file.
      component.handleInput('\u001B[D'); // left
      expect(component.getSelectedIndex()).toBe(1);

      // Switch back to T1: cursor should still be on its second file.
      component.handleInput('\u001B[C'); // right
      expect(component.getSelectedIndex()).toBe(1);
    });
  });
});
