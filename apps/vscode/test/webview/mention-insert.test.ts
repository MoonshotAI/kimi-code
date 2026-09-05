import { describe, expect, it } from 'vitest';
import { computeMentionInsert } from '@/components/inputarea/utils';

describe('computeMentionInsert', () => {
  it('replaces the active token with the mention and moves the cursor past it', () => {
    const result = computeMentionInsert({
      text: 'check @ap',
      cursorPos: 9,
      filePath: 'src/app.ts',
      activeToken: { start: 6 },
      isAppend: false,
    });
    expect(result.newText).toBe('check @src/app.ts ');
    expect(result.newCursorPos).toBe(result.newText.length);
  });

  it('appends the mention when there is no active token', () => {
    const result = computeMentionInsert({
      text: 'hi ',
      cursorPos: 3,
      filePath: 'a.ts',
      activeToken: null,
      isAppend: true,
    });
    expect(result.newText).toBe('hi @a.ts ');
    expect(result.newCursorPos).toBe(result.newText.length);
  });

  it('quotes a path containing spaces so whitespace cannot split the mention', () => {
    const result = computeMentionInsert({
      text: '@my',
      cursorPos: 3,
      filePath: 'My Folder/app.ts',
      activeToken: { start: 0 },
      isAppend: false,
    });
    expect(result.newText).toBe('@"My Folder/app.ts" ');
    expect(result.newCursorPos).toBe(result.newText.length);
  });

  it('quotes a path containing spaces in append mode', () => {
    const result = computeMentionInsert({
      text: '',
      cursorPos: 0,
      filePath: 'My Folder',
      activeToken: null,
      isAppend: true,
    });
    expect(result.newText).toBe('@"My Folder" ');
  });
});
