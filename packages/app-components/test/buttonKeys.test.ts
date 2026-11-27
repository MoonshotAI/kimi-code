// @vitest-environment jsdom
import { createApp, defineComponent, h, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconResolverKey } from '@moonshot-ai/app-ui';

let app: App | undefined;
let host: HTMLDivElement | undefined;

function mountButton(platform: string, keys: string[]): HTMLElement | null {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({ setup: () => () => h(Button, { keys }, () => 'Approve') });
  app.provide(IconResolverKey, (name) => defineComponent({ setup: () => () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return host.querySelector('.ui-button__kbd');
}

function keyCaps(kbd: Element): string[] {
  return [...kbd.querySelectorAll('.ui-kbd__key')].map((key) => {
    const svg = key.querySelector('svg');
    return svg === null ? `text:${key.textContent}` : `key:${svg.getAttribute('data-icon')}`;
  });
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  vi.restoreAllMocks();
});

describe('Button key cap', () => {
  it('reuses the button Kbd variant outside the button content and hides it from the accessible name', () => {
    const kbd = mountButton('MacIntel', ['enter'])!;
    expect(kbd.classList.contains('ui-kbd')).toBe(true);
    expect(kbd.classList.contains('ui-kbd--button')).toBe(true);
    expect(kbd.getAttribute('aria-hidden')).toBe('true');
    expect(kbd.parentElement?.tagName).toBe('BUTTON');
    expect(host?.querySelector('.ui-button__cap')).toBeNull();
  });

  it('renders Command and Enter as separate key caps on Apple platforms', () => {
    const kbd = mountButton('MacIntel', ['mod', 'enter'])!;
    expect(keyCaps(kbd)).toEqual(['key:key-command', 'key:key-enter']);
  });

  it('renders Ctrl and Enter as separate key caps on other platforms', () => {
    const kbd = mountButton('Win32', ['mod', 'enter'])!;
    expect(keyCaps(kbd)).toEqual(['text:Ctrl', 'key:key-enter']);
  });

  it.each(['MacIntel', 'Win32'])('renders single Enter and Escape key caps on %s', (platform) => {
    expect(keyCaps(mountButton(platform, ['enter'])!)).toEqual(['key:key-enter']);
    app?.unmount();
    host?.remove();
    expect(keyCaps(mountButton(platform, ['escape'])!)).toEqual(['text:Esc']);
  });

  it('renders no cap without keys', () => {
    expect(mountButton('MacIntel', [])).toBeNull();
  });
});
