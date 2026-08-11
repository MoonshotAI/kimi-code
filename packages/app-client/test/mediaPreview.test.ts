import { describe, expect, it } from 'vitest';

import { previewPadding } from '../src/lib/mediaPreview';

// A read map from token name to its computed value.
const readFrom =
  (tokens: Record<string, string>) =>
  (name: string): string =>
    tokens[name] ?? '';

describe('previewPadding', () => {
  it('derives the inset from the spacing tokens', () => {
    expect(previewPadding(readFrom({ '--space-6': '24px', '--space-8': '32px' }))).toEqual({
      top: 56,
      bottom: 56,
      left: 24,
      right: 24,
    });
  });

  it('follows token changes instead of freezing literals', () => {
    expect(previewPadding(readFrom({ '--space-6': '16px', '--space-8': '40px' }))).toEqual({
      top: 56,
      bottom: 56,
      left: 16,
      right: 16,
    });
  });

  it('falls back to the token scale values when tokens are missing or malformed', () => {
    expect(previewPadding(readFrom({}))).toEqual({ top: 56, bottom: 56, left: 24, right: 24 });
    expect(previewPadding(readFrom({ '--space-6': 'abc', '--space-8': '-4px' }))).toEqual({
      top: 56,
      bottom: 56,
      left: 24,
      right: 24,
    });
  });
});
