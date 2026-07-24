import { Markdown, visibleWidth } from '@moonshot-ai/pi-tui';
import * as cliHighlight from 'cli-highlight';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

import { captureProcessWrite } from '../../../helpers/process';

vi.mock('cli-highlight', async () => {
  const actual = await vi.importActual<typeof import('cli-highlight')>('cli-highlight');
  return {
    ...actual,
    highlight: vi.fn(actual.highlight),
  };
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
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

  it('preserves incomplete math source while assistant content is streaming', () => {
    const component = new AssistantMessageComponent();
    const source = String.raw`[lead $\text{a](b)} tail`;

    component.updateContent(source, { transient: true });

    expect(strip(component.render(120).join('\n'))).toContain(source);
  });

  it('preserves incomplete math source after a streaming render is invalidated', () => {
    const component = new AssistantMessageComponent();
    const source = String.raw`[lead $\text{a](b)} tail`;
    component.updateContent(source, { transient: true });

    component.invalidate();

    expect(strip(component.render(120).join('\n'))).toContain(source);
  });

  it('preserves math-like incomplete source when assistant content is finalized', () => {
    const component = new AssistantMessageComponent();
    const source = String.raw`$5 \theta^*_A + \phi^*_B`;
    component.updateContent(source, { transient: true });

    component.updateContent(source, { transient: false });

    expect(strip(component.render(120).join('\n'))).toContain(source);
  });

  it('reparses an unmatched dollar as ordinary table text when streaming finishes', () => {
    const component = new AssistantMessageComponent();
    const source = `| Price | Meaning |
| --- | --- |
| $5 | cheap |`;

    component.updateContent(source, { transient: true });
    expect(strip(component.render(120).join('\n'))).toContain('| --- | --- |');

    component.updateContent(source, { transient: false });
    const finalized = strip(component.render(120).join('\n'));

    expect(finalized).toContain('┌───────┬─────────┐');
    expect(finalized).toContain('│ $5    │ cheap   │');
    expect(finalized).not.toContain('| --- | --- |');
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
});
