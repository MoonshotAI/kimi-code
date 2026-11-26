// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import Kbd from '../../../../packages/app-ui/src/components/ui/Kbd.vue';
import { IconResolverKey } from '../../../../packages/app-ui/src/iconResolver';

let app: App | undefined;
let appHost: HTMLDivElement | undefined;

const IconStub = (name: string) =>
  defineComponent({ setup: () => () => h('svg', { class: 'stub-icon', 'data-icon': name }) });

function mountKbd(
  keys: string[] | string,
  options: { variant?: 'default' | 'button'; locale?: 'en' | 'zh'; literal?: boolean } = {},
): HTMLElement {
  appHost = document.createElement('div');
  document.body.appendChild(appHost);
  const Root = defineComponent({
    setup: () => () => h(Kbd, {
        keys,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.literal === undefined ? {} : { literal: options.literal }),
      }),
  });
  app = createApp(Root);
  app.use(createKimiI18n({ locale: options.locale ?? 'en' }));
  app.provide(IconResolverKey, (name) => IconStub(name));
  app.mount(appHost);
  return appHost;
}

afterEach(() => {
  vi.unstubAllGlobals();
  app?.unmount();
  app = undefined;
  appHost?.remove();
  appHost = undefined;
});

describe('Kbd glyph icons', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
  });

  it('renders known modifier glyphs as registry icons with accessible names', () => {
    const host = mountKbd(['shift', 'mod', 'b']);
    const chips = host.querySelectorAll('.ui-kbd__key');
    expect(chips).toHaveLength(3);

    const shift = chips[0] as HTMLElement;
    expect(shift.querySelector('svg.stub-icon')?.getAttribute('data-icon')).toBe('key-shift');
    expect(shift.querySelector('.ui-kbd__sr')?.textContent).toBe('Shift');
    expect(shift.textContent).not.toContain('⇧');

    const command = chips[1] as HTMLElement;
    expect(command.querySelector('svg.stub-icon')?.getAttribute('data-icon')).toBe('key-command');
    expect(command.querySelector('.ui-kbd__sr')?.textContent).toBe('Command');
    expect(command.textContent).not.toContain('⌘');

    const letter = chips[2] as HTMLElement;
    expect(letter.querySelector('svg')).toBeNull();
    expect(letter.textContent).toBe('B');
  });

  it('maps every supported glyph to its registry icon and localized name', () => {
    const host = mountKbd([
      'shift',
      'mod',
      'alt',
      'ctrl',
      'enter',
      'backspace',
      'tab',
      'plus',
      'arrowup',
      'arrowdown',
      'arrowleft',
      'arrowright',
    ]);
    const chips = [...host.querySelectorAll('.ui-kbd__key')];
    expect(chips.map((el) => el.querySelector('svg.stub-icon')?.getAttribute('data-icon'))).toEqual([
      'key-shift',
      'key-command',
      'key-option',
      'key-control',
      'key-enter',
      'key-backspace',
      'key-tab',
      'key-plus',
      'key-arrow-up',
      'key-arrow-down',
      'key-arrow-left',
      'key-arrow-right',
    ]);
    expect(chips.map((el) => el.querySelector('.ui-kbd__sr')?.textContent)).toEqual([
      'Shift',
      'Command',
      'Option',
      'Control',
      'Enter',
      'Backspace',
      'Tab',
      'Plus',
      'Up arrow',
      'Down arrow',
      'Left arrow',
      'Right arrow',
    ]);
  });

  it('localizes the accessible names', () => {
    const host = mountKbd(['shift', 'arrowup'], { locale: 'zh' });
    const names = [...host.querySelectorAll('.ui-kbd__sr')].map((el) => el.textContent);
    expect(names).toEqual(['Shift', '上箭头']);
  });

  it('renders word keys and unknown names as text', () => {
    const host = mountKbd(['escape', 'delete', 'k', 'F5']);
    expect(host.querySelectorAll('svg.stub-icon')).toHaveLength(0);
    const chips = [...host.querySelectorAll('.ui-kbd__key')].map((el) => el.textContent);
    expect(chips).toEqual(['Esc', 'Del', 'K', 'F5']);
  });

  it('accepts a binding string', () => {
    const host = mountKbd('mod+shift+k');
    const icons = [...host.querySelectorAll('svg.stub-icon')].map((icon) => icon.getAttribute('data-icon'));
    expect(icons).toEqual(['key-shift', 'key-command']);
    expect(host.querySelectorAll('.ui-kbd__key')[2]?.textContent).toBe('K');
  });

  it('shows literal keys verbatim', () => {
    const host = mountKbd(['Control', 'a', 'Enter'], { literal: true });
    expect(host.querySelectorAll('svg.stub-icon')).toHaveLength(0);
    const chips = [...host.querySelectorAll('.ui-kbd__key')].map((el) => el.textContent);
    expect(chips).toEqual(['Control', 'a', 'Enter']);
  });
});

describe('Kbd on non-Apple platforms', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
  });

  it('spells modifiers as words and keeps icon keys', () => {
    const host = mountKbd(['ctrl', 'alt', 'shift', 'mod', 'enter']);
    const chips = [...host.querySelectorAll('.ui-kbd__key')];
    expect(chips.map((el) => (el.querySelector('svg') === null ? el.textContent : el.querySelector('svg')?.getAttribute('data-icon')))).toEqual([
      'Ctrl',
      'Alt',
      'Shift',
      'Ctrl',
      'key-enter',
    ]);
  });
});
