import { describe, it, expect } from 'vitest';

import { isAppRendererUrl, shouldHideOnClose } from '../../src/main/window';

describe('isAppRendererUrl', () => {
  it('accepts the packaged renderer protocol and the dev-server http URL', () => {
    expect(isAppRendererUrl('app://renderer/index.html')).toBe(true);
    expect(isAppRendererUrl('app://renderer/sessions/session_abc')).toBe(true);
    expect(isAppRendererUrl('http://127.0.0.1:5174/')).toBe(true);
    expect(isAppRendererUrl('https://127.0.0.1:5174/')).toBe(true);
  });

  it('rejects pages without a tray-select subscription (error page, blank)', () => {
    expect(isAppRendererUrl('data:text/html;charset=utf-8,%3C!doctype%20html%3E')).toBe(false);
    expect(isAppRendererUrl('about:blank')).toBe(false);
    expect(isAppRendererUrl('')).toBe(false);
  });
});

describe('shouldHideOnClose', () => {
  it('hides instead of destroying on macOS (tray-resident model)', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(true);
  });

  it('lets real quits destroy the window', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false);
  });

  it('keeps destroy-on-close on other platforms', () => {
    expect(shouldHideOnClose('win32', false)).toBe(false);
    expect(shouldHideOnClose('linux', false)).toBe(false);
  });
});
