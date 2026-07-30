import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isDesktopMock } = vi.hoisted(() => ({
  isDesktopMock: { value: false },
}));

vi.mock('../../src/renderer/lib/desktopFlag', () => ({
  get isDesktop() {
    return isDesktopMock.value;
  },
}));

import { withDesktopLoginSource } from '../../src/renderer/lib/loginSource';

beforeEach(() => {
  isDesktopMock.value = false;
});

describe('withDesktopLoginSource', () => {
  it('appends from=kimi_code_desktop on the desktop', () => {
    isDesktopMock.value = true;
    expect(withDesktopLoginSource('https://example.com/device?user_code=ABCD')).toBe(
      'https://example.com/device?user_code=ABCD&from=kimi_code_desktop',
    );
  });

  it('is idempotent — an existing from param is overwritten, not duplicated', () => {
    isDesktopMock.value = true;
    expect(
      withDesktopLoginSource('https://example.com/device?from=kimi_code_desktop&user_code=ABCD'),
    ).toBe('https://example.com/device?from=kimi_code_desktop&user_code=ABCD');
  });

  it('preserves an existing query string and hash', () => {
    isDesktopMock.value = true;
    expect(withDesktopLoginSource('https://example.com/device?user_code=ABCD#frag')).toBe(
      'https://example.com/device?user_code=ABCD&from=kimi_code_desktop#frag',
    );
  });

  it('returns the input unchanged off the desktop (web / CLI)', () => {
    const url = 'https://example.com/device?user_code=ABCD';
    expect(withDesktopLoginSource(url)).toBe(url);
  });

  it('returns the input unchanged when the URL is unparseable', () => {
    isDesktopMock.value = true;
    expect(withDesktopLoginSource('not a url')).toBe('not a url');
  });
});
