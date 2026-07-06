import { describe, expect, it } from 'vitest';

import { stripSystemFromOutput, stripSystemTags } from '../../src/utils/strip-system-tags';

describe('stripSystemTags', () => {
  it('removes a paired system block', () => {
    expect(stripSystemTags('before <system>secret note</system> after')).toBe('before  after');
  });

  it('removes multiple blocks', () => {
    expect(stripSystemTags('<system>a</system>x<system>b</system>')).toBe('x');
  });

  it('removes multiline blocks', () => {
    expect(stripSystemTags('<system>line1\nline2</system>')).toBe('');
  });

  it('leaves a lone opening tag untouched so user data is not eaten', () => {
    expect(stripSystemTags('value <system> not closed')).toBe('value <system> not closed');
  });

  it('leaves text without system tags unchanged', () => {
    expect(stripSystemTags('plain text')).toBe('plain text');
  });

  it('strips tool error/empty sentinels but keeps surrounding text', () => {
    expect(stripSystemTags('<system>ERROR: Tool execution failed.</system>\nreal stderr')).toBe(
      '\nreal stderr',
    );
    expect(stripSystemTags('<system>Tool output is empty.</system>')).toBe('');
  });
});

describe('stripSystemFromOutput', () => {
  it('strips string output', () => {
    expect(stripSystemFromOutput('<system>x</system>hi')).toBe('hi');
  });

  it('strips only text parts in a content-part array and keeps media parts', () => {
    const out = stripSystemFromOutput([
      { type: 'text', text: '<system>note</system>' },
      { type: 'text', text: '<image path="x.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,A' } },
    ]);
    expect(out).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: '<image path="x.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,A' } },
    ]);
  });
});
