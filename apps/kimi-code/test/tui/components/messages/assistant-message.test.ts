import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import * as cliHighlight from 'cli-highlight';
import { describe, expect, it, vi } from 'vitest';

import { Markdown } from '#/tui/components/markdown/markdown';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { currentTheme } from '#/tui/theme/theme';
import { setMarkdownAltScreenActive, setMarkdownRenderLatex } from '#/tui/utils/markdown-options';

import { captureProcessWrite } from '../../../helpers/process';

vi.mock('cli-highlight', async () => {
  const actual = await vi.importActual<typeof import('cli-highlight')>('cli-highlight');
  return {
    ...actual,
    highlight: vi.fn(actual.highlight),
  };
});

const clipboardMock = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock('#/utils/clipboard/clipboard-text', () => clipboardMock);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(/\u001B\]133;[ABC]\u0007/g, '');
}

describe('AssistantMessageComponent', () => {
  it('defines the shared status bullet as a stable non-emoji glyph', () => {
    expect(STATUS_BULLET).toBe('● ');
    expect(visibleWidth(STATUS_BULLET)).toBe(2);
  });

  it('uses the stable status bullet without stealing content width', () => {
    const component = new AssistantMessageComponent();

    component.updateContent('abcdef');

    const lines = component.render(8).map(strip);
    expect(lines).toEqual(['', `${STATUS_BULLET}abcdef`]);
    expect(visibleWidth(lines[1] ?? '')).toBe(8);
  });

  it('keeps assistant lines within very narrow widths', () => {
    const component = new AssistantMessageComponent();
    component.updateContent('abcdef');

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders unknown markdown fence languages as plain text without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const theme = createMarkdownTheme();
      expect(theme.highlightCode?.('hello\nworld', 'abcxyz')).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('preserves literal hook result XML in normal assistant text', () => {
    const component = new AssistantMessageComponent();

    component.updateContent('<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>');

    const text = component.render(80).map(strip).join('\n');
    expect(text).toContain('<hook_result hook_event="UserPromptSubmit">');
    expect(text).toContain('{}');
    expect(text).toContain('</hook_result>');
    expect(text).not.toContain('UserPromptSubmit hook');
  });

  it('reuses the same Markdown child across streaming text updates', () => {
    const component = new AssistantMessageComponent();

    component.updateContent('hello');
    const first = (component as any).contentContainer.children[0];
    expect(first).toBeInstanceOf(Markdown);

    component.updateContent('hello world');
    const second = (component as any).contentContainer.children[0];

    expect(second).toBe(first);
    expect(strip(component.render(80).join('\n'))).toContain('hello world');
  });

  it('does not recreate the Markdown child when the text is unchanged', () => {
    const component = new AssistantMessageComponent();

    component.updateContent('hello');
    const first = (component as any).contentContainer.children[0];
    expect(first).toBeInstanceOf(Markdown);

    component.updateContent('hello');
    const second = (component as any).contentContainer.children[0];

    expect(second).toBe(first);
  });

  it('rebuilds the Markdown child when transient changes so final render can highlight code', () => {
    const component = new AssistantMessageComponent();
    const code = '```ts\nconst x = 1\n```';

    component.updateContent(code, { transient: true });
    const streaming = (component as any).contentContainer.children[0];
    expect(streaming).toBeInstanceOf(Markdown);

    component.updateContent(code, { transient: false });
    const finalized = (component as any).contentContainer.children[0];
    expect(finalized).toBeInstanceOf(Markdown);

    expect(finalized).not.toBe(streaming);
  });

  it('skips synchronous syntax highlighting in transient markdown themes', () => {
    const highlightSpy = vi.mocked(cliHighlight.highlight);
    highlightSpy.mockClear();
    const streamingTheme = createMarkdownTheme({ transient: true });
    const finalTheme = createMarkdownTheme();
    const code = 'const x = 1';

    expect(streamingTheme.highlightCode?.(code, 'typescript')).toEqual([code]);
    expect(highlightSpy).not.toHaveBeenCalled();

    finalTheme.highlightCode?.(code, 'typescript');
    expect(highlightSpy).toHaveBeenCalled();
  });

  it('highlights diff fences with the palette diff colors', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const theme = createMarkdownTheme();
      expect(theme.highlightCode?.('- removed\n+ added', 'diff')).toEqual([
        chalk.hex(currentTheme.color('diffRemoved'))('- removed'),
        chalk.hex(currentTheme.color('diffAdded'))('+ added'),
      ]);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('marks the rendered zone with OSC 133 markers, once across cache hits', () => {
    const component = new AssistantMessageComponent();
    component.updateContent('hello');

    const lines = component.render(80);
    expect(lines[0]).toMatch(/^\u001B\]133;A\u0007/);
    expect(lines.at(-1)).toMatch(/^\u001B\]133;B\u0007\u001B\]133;C\u0007/);

    const cached = component.render(80);
    expect(cached[0]).toBe(lines[0]);
  });

  it('renders LaTeX math by default and keeps raw source when disabled', () => {
    const component = new AssistantMessageComponent();
    try {
      setMarkdownRenderLatex(true);
      component.updateContent('能量公式 $E = mc^2$');
      expect(strip(component.render(80).join('\n'))).toContain('E = mc²');

      setMarkdownRenderLatex(false);
      component.invalidate();
      expect(strip(component.render(80).join('\n'))).toContain('$E = mc^2$');
    } finally {
      setMarkdownRenderLatex(true);
    }
  });

  it('forwards mouse clicks into the markdown subtree using the render geometry', async () => {
    const component = new AssistantMessageComponent();
    clipboardMock.copyTextToClipboard.mockClear();
    clipboardMock.copyTextToClipboard.mockResolvedValue('native');
    try {
      setMarkdownAltScreenActive(true);
      component.updateContent('```mermaid\nflowchart LR\n  A-->B\n```\n');
      const lines = component.render(80);

      const press = component.handleMouse({
        type: 'press',
        button: 'left',
        x: 3,
        y: lines.length - 1,
        screenX: 3,
        screenY: lines.length - 1,
        width: 80,
        height: lines.length,
        shift: false,
        alt: false,
        ctrl: false,
      });
      expect(press?.capture).toBe(true);

      const result = component.handleMouse({
        type: 'release',
        button: 'left',
        x: 3,
        y: lines.length - 1,
        screenX: 3,
        screenY: lines.length - 1,
        width: 80,
        height: lines.length,
        shift: false,
        alt: false,
        ctrl: false,
      });

      expect(result?.handled).toBe(true);
      await vi.waitFor(() => {
        expect(clipboardMock.copyTextToClipboard).toHaveBeenCalled();
      });
      const copied = String(clipboardMock.copyTextToClipboard.mock.calls[0]?.[0] ?? '');
      expect(copied).toContain('flowchart LR');
      expect(copied).not.toContain('```');
    } finally {
      setMarkdownAltScreenActive(false);
    }
  });

  it('reflects copy-chip state changes through the render cache', async () => {
    const component = new AssistantMessageComponent();
    clipboardMock.copyTextToClipboard.mockClear();
    clipboardMock.copyTextToClipboard.mockResolvedValue('native');
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      setMarkdownAltScreenActive(true);
      component.updateContent('```mermaid\nflowchart LR\n  A-->B\n```\n');
      const before = component.render(80);

      const mouse = (type: 'press' | 'release') => ({
        type,
        button: 'left' as const,
        x: 3,
        y: before.length - 1,
        screenX: 3,
        screenY: before.length - 1,
        width: 80,
        height: before.length,
        shift: false,
        alt: false,
        ctrl: false,
      });
      component.handleMouse(mouse('press'));
      expect(component.render(80).join('\n')).not.toBe(before.join('\n'));

      component.handleMouse(mouse('release'));
      await vi.waitFor(() => {
        expect(strip(component.render(80).join('\n'))).toContain('[Copied]');
      });
    } finally {
      chalk.level = previousLevel;
      setMarkdownAltScreenActive(false);
    }
  });
});
