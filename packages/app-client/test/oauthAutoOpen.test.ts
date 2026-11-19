import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopOAuthAutoOpen,
  createWebOAuthAutoOpen,
  type AutoOpenTab,
} from '../src/lib/oauthAutoOpen';

const DEVICE_URL = 'https://example.com/device?code=ABCD';

function makeTab() {
  const state = { closed: false };
  const tab = {
    get closed() { return state.closed; },
    navigate: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => { state.closed = true; }),
  } satisfies AutoOpenTab;
  return { state, tab };
}

describe('createWebOAuthAutoOpen', () => {
  it('opens a placeholder on the gesture and navigates it once the DEVICE_URL arrives', () => {
    const { tab } = makeTab();
    const openTab = vi.fn(() => tab);
    const driver = createWebOAuthAutoOpen(openTab);

    driver.onGesture?.();
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    expect(tab.navigate).toHaveBeenCalledWith(DEVICE_URL);
  });

  it('reports failure when the placeholder was popup-blocked', () => {
    const driver = createWebOAuthAutoOpen(() => null);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(false);
  });

  it('reports failure when the user closed the placeholder before the DEVICE_URL arrived', () => {
    const { state, tab } = makeTab();
    const driver = createWebOAuthAutoOpen(() => tab);
    driver.onGesture?.();
    state.closed = true;
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(false);
  });

  it('reports failure when navigation throws', () => {
    const { tab } = makeTab();
    tab.navigate.mockImplementation(() => { throw new Error('denied'); });
    const driver = createWebOAuthAutoOpen(() => tab);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(false);
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-http(s) URL without navigating the placeholder', () => {
    const { tab } = makeTab();
    const driver = createWebOAuthAutoOpen(() => tab);
    driver.onGesture?.();
    expect(driver.openUrl('kimi-code://auth/success', 'flow_1')).toBe(false);
    expect(driver.openUrl('file:///etc/passwd', 'flow_1')).toBe(false);
    expect(driver.openUrl('javascript:alert(1)', 'flow_1')).toBe(false);
    expect(tab.navigate).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('focuses the live tab when the same URL arrives again instead of reloading it', () => {
    const { tab } = makeTab();
    const driver = createWebOAuthAutoOpen(() => tab);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    expect(tab.navigate).toHaveBeenCalledTimes(1);
    expect(tab.focus).toHaveBeenCalledTimes(1);
    expect(driver.openUrl(`${DEVICE_URL}2`, 'flow_2')).toBe(true);
    expect(tab.navigate).toHaveBeenCalledTimes(2);
  });

  it('navigates the fresh placeholder when a retry re-issues the same flow', () => {
    const first = makeTab();
    const second = makeTab();
    const openTab = vi.fn()
      .mockReturnValueOnce(first.tab)
      .mockReturnValueOnce(second.tab);
    const driver = createWebOAuthAutoOpen(openTab);

    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    driver.settle(false);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    expect(second.tab.navigate).toHaveBeenCalledWith(DEVICE_URL);
  });

  it('closes the tab when the flow fails — navigated or not', () => {
    const { tab } = makeTab();
    const driver = createWebOAuthAutoOpen(() => tab);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    driver.settle(false);
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a navigated tab on settle(false, { keepNavigated }) but closes a blank placeholder', () => {
    const navigated = makeTab();
    const driver = createWebOAuthAutoOpen(() => navigated.tab);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    driver.settle(false, { keepNavigated: true });
    expect(navigated.tab.close).not.toHaveBeenCalled();

    const blank = makeTab();
    const blankDriver = createWebOAuthAutoOpen(() => blank.tab);
    blankDriver.onGesture?.();
    blankDriver.settle(false, { keepNavigated: true });
    expect(blank.tab.close).toHaveBeenCalledTimes(1);
  });

  it('closes a blank placeholder on success but keeps a navigated tab open', () => {
    const blank = makeTab();
    const fastPath = createWebOAuthAutoOpen(() => blank.tab);
    fastPath.onGesture?.();
    fastPath.settle(true);
    expect(blank.tab.close).toHaveBeenCalledTimes(1);

    const navigated = makeTab();
    const driver = createWebOAuthAutoOpen(() => navigated.tab);
    driver.onGesture?.();
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    driver.settle(true);
    expect(navigated.tab.close).not.toHaveBeenCalled();
  });

  it('closes a leftover placeholder when a new gesture starts over', () => {
    const first = makeTab();
    const second = makeTab();
    const openTab = vi.fn()
      .mockReturnValueOnce(first.tab)
      .mockReturnValueOnce(second.tab);
    const driver = createWebOAuthAutoOpen(openTab);

    driver.onGesture?.();
    driver.onGesture?.();
    expect(first.tab.close).toHaveBeenCalledTimes(1);
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(true);
    expect(second.tab.navigate).toHaveBeenCalledWith(DEVICE_URL);
  });

  it('settle is idempotent', () => {
    const { tab } = makeTab();
    const driver = createWebOAuthAutoOpen(() => tab);
    driver.onGesture?.();
    driver.settle(false);
    driver.settle(false);
    expect(tab.close).toHaveBeenCalledTimes(1);
  });
});

describe('createDesktopOAuthAutoOpen', () => {
  const globalRef = globalThis as { window?: unknown };
  const originalWindow = globalRef.window;

  afterEach(() => {
    if (originalWindow === undefined) delete globalRef.window;
    else globalRef.window = originalWindow;
  });

  it('hands the wrapped DEVICE_URL to the preload bridge', async () => {
    const openExternal = vi.fn(async () => {});
    globalRef.window = { kimiDesktop: { openExternal } };
    const wrapUrl = vi.fn((url: string) => `${url}&from=kimi_code_desktop`);
    const driver = createDesktopOAuthAutoOpen(wrapUrl);

    await expect(driver.openUrl(DEVICE_URL, 'flow_1')).resolves.toBe(true);
    expect(wrapUrl).toHaveBeenCalledWith(DEVICE_URL);
    expect(openExternal).toHaveBeenCalledWith(`${DEVICE_URL}&from=kimi_code_desktop`);
  });

  it('opens the system browser once per flow id', async () => {
    const openExternal = vi.fn(async () => {});
    globalRef.window = { kimiDesktop: { openExternal } };
    const driver = createDesktopOAuthAutoOpen((url) => url);

    await expect(driver.openUrl(DEVICE_URL, 'flow_1')).resolves.toBe(true);
    await expect(driver.openUrl(DEVICE_URL, 'flow_1')).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    await expect(driver.openUrl(`${DEVICE_URL}2`, 'flow_2')).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('reports failure when the bridge or the method is missing', () => {
    const driver = createDesktopOAuthAutoOpen((url) => url);
    globalRef.window = {};
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(false);
    globalRef.window = { kimiDesktop: {} };
    expect(driver.openUrl(DEVICE_URL, 'flow_1')).toBe(false);
  });

  it('rejects a non-http(s) URL before touching the bridge', () => {
    const openExternal = vi.fn(async () => {});
    globalRef.window = { kimiDesktop: { openExternal } };
    const driver = createDesktopOAuthAutoOpen((url) => url);
    expect(driver.openUrl('kimi-code://auth/success', 'flow_1')).toBe(false);
    expect(driver.openUrl('file:///etc/passwd', 'flow_1')).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports delivery failure when the bridge call rejects, and retries the same flow afterwards', async () => {
    const openExternal = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('no browser'))
      .mockResolvedValueOnce(undefined);
    globalRef.window = { kimiDesktop: { openExternal } };
    const driver = createDesktopOAuthAutoOpen((url) => url);

    await expect(driver.openUrl(DEVICE_URL, 'flow_1')).resolves.toBe(false);
    await expect(driver.openUrl(DEVICE_URL, 'flow_1')).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('settle is a no-op — the system browser owns the tab', () => {
    const driver = createDesktopOAuthAutoOpen((url) => url);
    expect(() => driver.settle(false)).not.toThrow();
    expect(() => driver.settle(true)).not.toThrow();
  });
});
