// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { useFontPrefs, type FontTarget } from '@moonshot-ai/app-core/composables';
const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core/lib')>();
  return { ...actual, get isWindowsDesktop() { return platform.windows; } };
});
vi.mock('../src/settings/FontSettingsPreview.vue', () => ({
  default: defineComponent({ render: () => h('figure', { class: 'font-specimen' }) }),
}));

import FontSettingsPage from '../src/settings/FontSettingsPage.vue';
import FontSettingsRow from '../src/settings/FontSettingsRow.vue';
import { useSettingsSubpage } from '../src/settings/useSettingsSubpage';

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  platform.windows = false;
  useFontPrefs().setFontPref('ui', { mode: 'kimi', families: [] });
});

const TARGETS: FontTarget[] = ['ui', 'transcript', 'code', 'terminal'];

function mount(locale: 'en' | 'zh' = 'en') {
  host = document.createElement('div');
  document.body.append(host);
  const Harness = defineComponent({
    setup() {
      const subpage = useSettingsSubpage<FontTarget>();
      return () =>
        h('div', { class: 'host' }, [
          subpage.page.value
            ? h(FontSettingsPage, { key: subpage.page.value, target: subpage.page.value, onBack: subpage.back })
            : null,
          h(
            'div',
            { class: 'overview', style: subpage.page.value ? 'display: none' : undefined },
            TARGETS.map((target) => h(FontSettingsRow, { key: target, target, onOpen: subpage.open })),
          ),
        ]);
    },
  });
  app = createApp(Harness);
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale }));
  app.mount(host);
  const root = host;
  return {
    root,
    row: (target: FontTarget) =>
      root.querySelector<HTMLButtonElement>(`[data-settings-subpage-origin="${target}"]`)!,
    page: () => root.querySelector<HTMLElement>('.settings-subpage'),
    back: () => root.querySelector<HTMLButtonElement>('.settings-subpage-back'),
    overviewHidden: () => root.querySelector<HTMLElement>('.overview')?.style.display === 'none',
  };
}

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

describe('font settings child page', () => {
  it('lists the four fonts with a summary and a chevron', () => {
    const { row } = mount();
    for (const target of TARGETS) expect(row(target)).not.toBeNull();
    expect(row('ui').textContent).toContain('UI font');
    expect(row('ui').textContent).toContain('Kimi Code default');
    expect(row('transcript').textContent).toContain('Same as UI font');
    expect(row('ui').querySelector('[data-icon="chevron-right"]')).not.toBeNull();
  });

  it('opens the child page from a row and focuses its back link', async () => {
    const { row, page, back, overviewHidden } = mount();
    row('code').focus();
    row('code').click();
    await flush();
    expect(overviewHidden()).toBe(true);
    expect(page()?.querySelector('.settings-subpage-title')?.textContent).toBe('Code font');
    expect(page()?.textContent).toContain('Code blocks, diffs, and file previews');
    expect(back()?.textContent).toContain('Typefaces and Fonts');
    expect(back()?.getAttribute('aria-label')).toBe('Back to Typefaces and Fonts');
    expect(document.activeElement).toBe(back());
    expect(page()?.querySelectorAll('[role="radio"]')).toHaveLength(3);
  });

  it('returns to the list with the back link and refocuses the opened row', async () => {
    const { row, page, back, overviewHidden } = mount();
    row('terminal').click();
    await flush();
    back()?.click();
    await flush();
    expect(page()).toBeNull();
    expect(overviewHidden()).toBe(false);
    expect(document.activeElement).toBe(row('terminal'));
  });

  it('returns to the list on Escape and claims the key so the dialog stays open', async () => {
    const { row, page } = mount();
    row('transcript').click();
    await flush();
    const radio = page()!.querySelector<HTMLElement>('[role="radio"]')!;
    radio.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    radio.dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(row('transcript'));
  });

  it.each([
    { locale: 'en' as const, label: 'Noto Sans SC' },
    { locale: 'zh' as const, label: '思源黑体' },
  ])('shows the $locale Noto Sans SC display label without changing its identity', async ({ locale, label }) => {
    useFontPrefs().setFontPref('ui', { mode: 'custom', families: ['Noto Sans SC Variable'] });
    const { row, page } = mount(locale);
    expect(row('ui').textContent).toContain(label);
    row('ui').click();
    await flush();
    expect(page()?.querySelector('.fs-chip .nm')?.textContent).toBe(label);
    expect(useFontPrefs().fontPrefs.value.ui.families).toEqual(['Noto Sans SC Variable']);
  });

  it('uses the validated English descriptions and fallback tooltip outside Windows', async () => {
    const { row, page } = mount();
    row('ui').click();
    await flush();
    expect(page()?.textContent).toContain('Use your operating system’s default fonts');
    expect(page()?.textContent).not.toContain('This option sharpens text strokes on lower-resolution displays');
    expect(page()?.textContent).toContain('Use the font pairing Kimi Code has always used');
    expect(page()?.textContent).toContain('Customize font stacks and their order, with CSS font fallback support');
    const info = page()?.querySelector('.fs-fallback-info');
    const tooltip = 'If a character is missing from a font earlier in the stack, a later font renders it. If the character is missing from every specified font, a system font renders it.';
    expect(info?.getAttribute('aria-label')).toBe(tooltip);
    expect(info?.querySelector('[data-icon="info"]')).not.toBeNull();
  });

  it.each([
    {
      locale: 'en' as const,
      system: 'Use your operating system’s default fonts This option sharpens text strokes on lower-resolution displays',
      kimi: 'Use the font pairing Kimi Code has always used',
      custom: 'Customize font stacks and their order, with CSS font fallback support',
      tooltip: 'If a character is missing from a font earlier in the stack, a later font renders it. If the character is missing from every specified font, a system font renders it.',
    },
    {
      locale: 'zh' as const,
      system: '使用操作系统的默认字体在较低分辨率屏幕上使用此选项时，文字笔画会更加清晰锐利',
      kimi: '使用 Kimi Code 一直以来使用的字体搭配',
      custom: '自定义字体搭配和顺序，支持 CSS 字体回退机制',
      tooltip: '如果顺序靠前的字体中缺失某个字符，则会使用顺序靠后的字体进行渲染。若某字符在所有指定字体中都缺失，则会使用系统自带字体渲染。',
    },
  ])('appends the Windows sentence and shows $locale copy', async ({ locale, system, kimi, custom, tooltip }) => {
    platform.windows = true;
    const { row, page } = mount(locale);
    row('ui').click();
    await flush();
    expect(page()?.textContent).toContain(system);
    expect(page()?.textContent).toContain(kimi);
    expect(page()?.textContent).toContain(custom);
    expect(page()?.querySelector('.fs-fallback-info')?.getAttribute('aria-label')).toBe(tooltip);
  });
});

describe('settings child page height', () => {
  function layoutHost(scrollHeight: number) {
    host = document.createElement('div');
    document.body.append(host);
    const dialog = document.createElement('div');
    dialog.className = 'ui-dialog';
    dialog.getBoundingClientRect = () => ({ height: 680 }) as DOMRect;
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    dialog.append(scroller);
    host.append(dialog);
    const target = document.createElement('div');
    scroller.append(target);
    let state: ReturnType<typeof useSettingsSubpage<FontTarget>> | null = null;
    const Host = defineComponent({
      setup() {
        const subpage = useSettingsSubpage<FontTarget>(() => scroller);
        state = subpage;
        return () => (subpage.page.value ? h(FontSettingsPage, { target: subpage.page.value }) : null);
      },
    });
    app = createApp(Host);
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(target);
    return () => state!;
  }

  async function frames(count: number): Promise<void> {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }

  it('grows the host by the page overflow once on entry and returns on back', async () => {
    const state = layoutHost(900);
    state().open('ui');
    await nextTick();
    expect(state().fitHeight.value).toBeNull();
    await frames(8);
    expect(state().fitHeight.value).toBe(980);
    state().back();
    await nextTick();
    expect(state().fitHeight.value).toBeNull();
  });

  it('keeps the normal height when the page already fits', async () => {
    const state = layoutHost(600);
    state().open('code');
    await frames(8);
    expect(state().fitHeight.value).toBeNull();
  });

  it('drops a pending fit when the host resets to the list', async () => {
    const state = layoutHost(900);
    state().open('transcript');
    await nextTick();
    state().reset();
    await frames(8);
    expect(state().fitHeight.value).toBeNull();
  });
});

describe('useSettingsSubpage', () => {
  it('starts each page at the top and restores the list scroll on back', async () => {
    const scroller = document.createElement('div');
    scroller.scrollTop = 120;
    const origin = document.createElement('button');
    document.body.append(scroller, origin);
    const subpage = useSettingsSubpage<string>(() => scroller);
    subpage.open('fonts', origin);
    await nextTick();
    expect(subpage.page.value).toBe('fonts');
    expect(scroller.scrollTop).toBe(0);
    subpage.back();
    await nextTick();
    expect(subpage.page.value).toBeNull();
    expect(scroller.scrollTop).toBe(120);
    expect(document.activeElement).toBe(origin);
    subpage.open('fonts', origin);
    subpage.reset();
    expect(subpage.page.value).toBeNull();
    scroller.remove();
    origin.remove();
  });
});
