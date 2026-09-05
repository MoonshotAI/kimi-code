import { describe, expect, it } from 'vitest';

import { replaceCircledNumbers } from '#/tui/utils/text-sanitize';

describe('replaceCircledNumbers (#3302 display-layer insurance)', () => {
  it('replaces ①-⑳ with 1.-20.', () => {
    expect(replaceCircledNumbers('①②③')).toBe('1.2.3.');
    expect(replaceCircledNumbers('第⑳项')).toBe('第20.项');
  });

  it('replaces ❶-❿ and ⓵-⓾ and zero forms', () => {
    expect(replaceCircledNumbers('❶❿')).toBe('1.10.');
    // ⓵⓾ are double-circled 1 and 10 (U+24F5/U+24FE)
    expect(replaceCircledNumbers('⓵⓾')).toBe('1.10.');
    expect(replaceCircledNumbers('⑴⒇')).toBe('1.20.');
    expect(replaceCircledNumbers('⓪⓿')).toBe('0.0.');
  });

  it('leaves ordinary text untouched', () => {
    expect(replaceCircledNumbers('plain ASCII 123')).toBe('plain ASCII 123');
    expect(replaceCircledNumbers('中文没有圈号')).toBe('中文没有圈号');
  });

  it('handles the user regression probe', () => {
    expect(replaceCircledNumbers('①测试 ★测试 →测试 α测试')).toBe('1.测试 ★测试 →测试 α测试');
  });
});
