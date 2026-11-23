// @vitest-environment jsdom
import { createApp, defineComponent, h, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconResolverKey } from '@moonshot-ai/app-ui';

let app: App | undefined;
let host: HTMLDivElement | undefined;

function mountButton(platform: string, keys: string[]): HTMLElement {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({ setup: () => () => h(Button, { keys }, () => 'Approve') });
  app.provide(IconResolverKey, (name) => defineComponent({ setup: () => () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return host.querySelector('.ui-button__cap')!;
}

function capParts(cap: Element): string[] {
  return [...cap.children].map((part) =>
    part.classList.contains('ui-button__cap-text') ? `text:${part.textContent}` : `key:${part.querySelector('svg')?.getAttribute('data-icon')}`,
  );
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  vi.restoreAllMocks();
});

describe('Button key cap', () => {
  it('joins Command and Enter with a plus icon on Apple platforms', () => {
    const cap = mountButton('MacIntel', ['mod', 'enter']);
    expect(capParts(cap)).toEqual(['key:key-command', 'key:key-plus', 'key:key-enter']);
    expect(cap.classList.contains('ui-button__cap--combo')).toBe(true);
  });

  it('spells Ctrl before the plus and Enter icons on other platforms', () => {
    const cap = mountButton('Win32', ['mod', 'enter']);
    expect(capParts(cap)).toEqual(['text:Ctrl', 'key:key-plus', 'key:key-enter']);
    expect(cap.classList.contains('ui-button__cap--combo')).toBe(true);
  });

  it.each(['MacIntel', 'Win32'])('renders single keys without the combo layout on %s', (platform) => {
    const enter = mountButton(platform, ['enter']);
    expect(capParts(enter)).toEqual(['key:key-enter']);
    expect(enter.classList.contains('ui-button__cap--combo')).toBe(false);
    app?.unmount();
    host?.remove();
    const escape = mountButton(platform, ['escape']);
    expect(capParts(escape)).toEqual(['text:Esc']);
    expect(escape.classList.contains('ui-button__cap--combo')).toBe(false);
  });

  it('renders no cap without keys', () => {
    expect(mountButton('MacIntel', [])).toBeNull();
  });
});
