// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import { PinScrollKey } from '@moonshot-ai/app-client/contracts';
import Markdown from './Markdown.vue';

vi.mock('markstream-vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('markstream-vue')>()),
  enableKatex: () => {},
  enableMermaid: () => {},
}));
vi.mock('./lib/markdownWorkers', () => ({ ensureMarkdownWorkers: () => {} }));

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

function mount(render: () => ReturnType<typeof h>, state?: Map<string, unknown>, pin?: (el: HTMLElement, ms?: number) => void): void {
  app?.unmount();
  app = createApp({ render });
  app.use(createKimiI18n({ locale: 'en' }));
  if (state) app.provide(HistoryStateKey, state);
  if (pin) app.provide(PinScrollKey, pin);
  app.mount(host);
}

function codeBlockForms(): string[] {
  return [...host.querySelectorAll('.code-block-container')].map(container =>
    [...(container.querySelector('.code-block-shell-content')?.children ?? [])].map(child => child.className.split(' ').find(name => !name.startsWith('language-')) ?? '').join(','),
  );
}

it('keeps the code block structure when a large answer finishes streaming', async () => {
  const text = Array.from({ length: 34 }, (_, k) => `Block ${k}\n\n\`\`\`ts\nconst value_${k} = ${k};\n\`\`\``).join('\n\n');
  const streaming = ref(true);
  mount(() => h(Markdown, { text, streaming: streaming.value }));
  await vi.waitFor(async () => {
    await nextTick();
    expect(host.querySelectorAll('.code-block-container')).toHaveLength(34);
  }, { timeout: 10_000 });
  const streamed = codeBlockForms();
  streaming.value = false;
  await nextTick();
  await nextTick();
  expect(codeBlockForms()).toEqual(streamed);
});

function deferredResolver() {
  const pending: ((url: string) => void)[] = [];
  return { resolve: () => new Promise<string>(done => pending.push(done)), settle: (url: string) => pending.splice(0).forEach(done => done(url)) };
}

function imageContainer(): HTMLElement {
  return host.querySelector<HTMLElement>('.image-node-container')!;
}

it('reserves a placeholder for unresolved images and reuses the loaded size after remounting', async () => {
  const state = new Map<string, unknown>();
  const text = 'Before\n\n![chart](assets/chart.png)\n\nAfter';
  const first = deferredResolver();
  mount(() => h(Markdown, { text, stateKey: 'body', resolveImage: first.resolve }), state);
  await vi.waitFor(async () => {
    await nextTick();
    expect(imageContainer()?.classList.contains('md-image-pending')).toBe(true);
  });

  const url = 'data:image/png;base64,AAAA';
  first.settle(url);
  await vi.waitFor(async () => {
    await nextTick();
    expect(imageContainer().querySelector('img')?.getAttribute('src')).toBe(url);
  });
  const img = imageContainer().querySelector('img')!;
  Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 640 }, naturalHeight: { value: 320 } });
  img.dispatchEvent(new Event('load'));
  await nextTick();
  expect(imageContainer().classList.contains('md-image-sized')).toBe(true);

  const second = deferredResolver();
  mount(() => h(Markdown, { text, stateKey: 'body', resolveImage: second.resolve }), state);
  await vi.waitFor(async () => {
    await nextTick();
    expect(imageContainer()).not.toBeNull();
  });
  expect(imageContainer().querySelector('img')?.getAttribute('src')).not.toBe(url);
  expect(imageContainer().classList.contains('md-image-sized')).toBe(true);
  expect(imageContainer().classList.contains('md-image-pending')).toBe(false);
  expect(imageContainer().style.getPropertyValue('--md-image-ratio')).toBe('640 / 320');
});

it('holds a table in place when the user toggles its width', async () => {
  const pin = vi.fn();
  mount(() => h('div', { class: 'a-msg' }, [h('div', { class: 'msg' }, [h(Markdown, { text: '| A | B |\n| --- | --- |\n| 1 | 2 |' })])]), undefined, pin);
  let toggle: HTMLButtonElement | null = null;
  await vi.waitFor(async () => {
    await nextTick();
    toggle = host.querySelector<HTMLButtonElement>('.md-table-toggle');
    expect(toggle).not.toBeNull();
  });
  toggle!.click();
  expect(pin).toHaveBeenCalledTimes(1);
  expect(pin.mock.calls[0]![0]).toBe(host.querySelector('.table-node-wrapper'));
});
