import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

import { captureProcessWrite } from '../../../helpers/process';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('AssistantMessageComponent', () => {
  it('defines the shared status bullet as a stable non-emoji glyph', () => {
    expect(STATUS_BULLET).toBe('● ');
    expect(visibleWidth(STATUS_BULLET)).toBe(2);
  });

  it('uses the stable status bullet without stealing content width', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('abcdef');

    const lines = component.render(8).map(strip);
    expect(lines).toEqual(['', `${STATUS_BULLET}abcdef`]);
    expect(visibleWidth(lines[1] ?? '')).toBe(8);
  });

  it('renders unknown markdown fence languages without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const theme = createMarkdownTheme(darkColors);
      const result = theme.highlightCode?.('hello\nworld', 'abcxyz') ?? [];
      expect(result).toHaveLength(2);
      expect(strip(result[0])).toBe('hello');
      expect(strip(result[1])).toBe('world');
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
  });

  it('renders headings without raw hash prefix', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);
    component.updateContent('# Heading 1\n## Heading 2\n### Heading 3');
    const text = component.render(80).map(strip).join('\n');
    expect(text).toContain('Heading 1');
    expect(text).toContain('Heading 2');
    expect(text).toContain('Heading 3');
    expect(text).not.toContain('# Heading 1');
    expect(text).not.toContain('## Heading 2');
    expect(text).not.toContain('### Heading 3');
  });

  it('renders bold text without raw asterisks', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);
    component.updateContent('This is **bold** and __also bold__');
    const text = component.render(80).map(strip).join('\n');
    expect(text).toContain('bold');
    expect(text).toContain('also bold');
    expect(text).not.toContain('**bold**');
    expect(text).not.toContain('__also bold__');
  });

  it('renders lists without raw dash markers', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);
    component.updateContent('- item 1\n- item 2\n- item 3');
    const text = component.render(80).map(strip).join('\n');
    expect(text).toContain('item 1');
    expect(text).toContain('item 2');
    expect(text).toContain('item 3');
    expect(text).not.toContain('- item 1');
    expect(text).not.toContain('- item 2');
    expect(text).not.toContain('- item 3');
  });

  it('preserves literal hook result XML in normal assistant text', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.updateContent('<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>');

    const text = component.render(80).map(strip).join('\n');
    expect(text).toContain('<hook_result hook_event="UserPromptSubmit">');
    expect(text).toContain('{}');
    expect(text).toContain('</hook_result>');
    expect(text).not.toContain('UserPromptSubmit hook');
  });
});
