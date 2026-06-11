import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors, lightColors } from '#/tui/theme/colors';
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

  it('renders unknown markdown fence languages as plain text without stderr noise', () => {
    const stderr = captureProcessWrite('stderr');
    try {
      const theme = createMarkdownTheme(darkColors);
      expect(theme.highlightCode?.('hello\nworld', 'abcxyz')).toEqual(['hello', 'world']);
      expect(stderr.text()).not.toContain('Could not find the language');
    } finally {
      stderr.restore();
    }
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

  it('re-renders content with new theme after applyTheme', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);
    component.updateContent('hello world');

    const beforeTheme = component.render(40).map(strip).join('\n');
    expect(beforeTheme).toContain('hello world');

    component.applyTheme(createMarkdownTheme(lightColors), lightColors);

    const afterTheme = component.render(40).map(strip).join('\n');
    expect(afterTheme).toContain('hello world');
  });

  it('does not render content when lastText is empty after applyTheme', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);

    component.applyTheme(createMarkdownTheme(lightColors), lightColors);

    expect(component.render(40)).toEqual([]);
  });

  it('updates bullet color after applyTheme', () => {
    const component = new AssistantMessageComponent(createMarkdownTheme(darkColors), darkColors);
    component.updateContent('test');

    const darkRender = component.render(40);
    expect(darkRender.some((line) => line.length > 0)).toBe(true);

    component.applyTheme(createMarkdownTheme(lightColors), lightColors);

    const lightRender = component.render(40);
    expect(lightRender.some((line) => line.length > 0)).toBe(true);
  });
});
