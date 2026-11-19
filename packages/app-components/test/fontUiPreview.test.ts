// @vitest-environment jsdom
import { createApp, defineComponent, h, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import FontUiPreview from '../src/settings/FontUiPreview.vue';
import {
  FontPreviewBrandKey,
  fontPreviewChrome,
  type FontPreviewChrome,
} from '../src/settings/fontPreviewChrome';

const NONE = { isMacosDesktop: false, isWindowsDesktop: false, isLinuxDesktop: false, hasCustomTitleBar: false };

describe('fontPreviewChrome', () => {
  it('follows the title bar the app picks for each platform', () => {
    expect(fontPreviewChrome({ ...NONE, isMacosDesktop: true })).toBe('macos');
    expect(fontPreviewChrome({ ...NONE, isWindowsDesktop: true, hasCustomTitleBar: true })).toBe('windows');
    expect(fontPreviewChrome({ ...NONE, isLinuxDesktop: true, hasCustomTitleBar: true })).toBe('linux');
    expect(fontPreviewChrome({ ...NONE, isLinuxDesktop: true })).toBe('plain');
    expect(fontPreviewChrome(NONE)).toBe('plain');
  });
});

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

function mount(chrome: FontPreviewChrome): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(FontUiPreview, { chrome }) });
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(FontPreviewBrandKey, defineComponent({ render: () => h('svg', { class: 'brand' }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  return host;
}

function icons(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-icon]')].map((el) => el.getAttribute('data-icon') ?? '');
}

describe('FontUiPreview', () => {
  it('is an inert, labelled image of the new-session window', () => {
    const root = mount('macos');
    const frame = root.querySelector('[role="img"]');
    expect(frame?.getAttribute('aria-label')).toBe('Font preview');
    expect(root.querySelector('.fup-window')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector<HTMLElement>('.fup-window')?.style.height).toBe('440px');
    expect(root.querySelectorAll('.fup-content > .fup-spacer')).toHaveLength(1);
    expect(root.querySelector('.fup-composer > .fup-toolbar')).not.toBeNull();
    expect(root.querySelector('.fup-composer-gap')).not.toBeNull();
    expect(root.querySelector('.wordmark')).not.toBeNull();
    expect(root.querySelector('.mascot-peek')).not.toBeNull();
    expect(root.textContent).toContain('选一个适合着陆的平坦区域');
    expect(root.textContent).toContain('Type a message…');
    expect(root.textContent).toContain('Always Ask');
    expect(icons(root)).toEqual(
      expect.arrayContaining([
        'chat-new', 'search', 'collapse', 'folder-plus', 'view-switch', 'folder', 'settings',
        'terminal', 'panel-expand-right', 'folder-closed', 'chevron-down', 'expand', 'attachment',
        'plus', 'hand', 'send',
      ]),
    );
  });

  it('draws macOS window buttons in the sidebar with no title bar', () => {
    const root = mount('macos');
    expect(root.querySelector('.fup-titlebar')).toBeNull();
    expect(root.querySelectorAll('.fup-light')).toHaveLength(3);
    expect(icons(root)).toContain('panel-collapse');
  });

  it('draws the custom title bar with Windows caption buttons', () => {
    const root = mount('windows');
    const bar = root.querySelector('.fup-titlebar');
    expect(bar?.textContent).toContain('Kimi Code');
    expect(bar?.querySelector('.brand')).not.toBeNull();
    expect([...root.querySelectorAll('.fup-menu')].map((el) => el.textContent)).toEqual(['File', 'Edit', 'View', 'Help']);
    expect([...root.querySelectorAll('[data-caption]')].map((el) => el.getAttribute('data-caption'))).toEqual([
      'minimize', 'maximize', 'close',
    ]);
    expect(root.querySelector('.fup-light')).toBeNull();
  });

  it('draws the custom title bar with a single GNOME close button on Linux', () => {
    const root = mount('linux');
    expect(root.querySelector('.fup-titlebar')).not.toBeNull();
    expect(root.querySelectorAll('.fup-gnome-close')).toHaveLength(1);
    expect(root.querySelector('.fup-caption-btn')).toBeNull();
  });

  it('shows no OS controls without a custom title bar', () => {
    const root = mount('plain');
    expect(root.querySelector('.fup-titlebar')).toBeNull();
    expect(root.querySelector('[data-caption]')).toBeNull();
    expect(root.querySelector('.fup-ch')?.textContent).toContain('Kimi Code');
  });
});
