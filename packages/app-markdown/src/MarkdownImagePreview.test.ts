// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenMarkdownImageKey, type OpenMarkdownImagePayload } from '@moonshot-ai/app-core/contracts';
import MarkdownImage from './MarkdownImage.vue';

const node = { type: 'image' as const, src: 'https://example.com/image.png', alt: 'Alternative text', title: null, raw: '' };

let app: App | null = null;
let host: HTMLElement | null = null;

function mount(open?: (payload: OpenMarkdownImagePayload) => void): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({ render: () => h(MarkdownImage, { node }) });
  if (open) app.provide(OpenMarkdownImageKey, open);
  app.mount(host);
  return host;
}

async function loadedImg(el: HTMLElement): Promise<HTMLImageElement> {
  await nextTick();
  const img = el.querySelector('img');
  expect(img).not.toBeNull();
  img!.dispatchEvent(new Event('load'));
  await nextTick();
  return img!;
}

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

it('opens the clicked image through the injected opener', async () => {
  const open = vi.fn();
  const el = mount(open);
  const img = await loadedImg(el);
  img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith({ src: node.src, alt: node.alt, originImg: img });
});

it('does nothing on click without an injected opener', async () => {
  const el = mount();
  const img = await loadedImg(el);
  expect(() => img.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
});

it('opens the preview on Enter and Space for keyboard users', async () => {
  const open = vi.fn();
  const el = mount(open);
  const img = await loadedImg(el);
  for (const key of ['Enter', ' ']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    img.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenLastCalledWith({ src: img.currentSrc || img.src, alt: node.alt, originImg: img });
});
