// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Favicon from '../../app-ui/src/components/ui/Favicon.vue';

type Rgba = readonly [number, number, number, number];

const SIZE = 32;

function disc(fill: Rgba): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (Math.hypot(x - 15.5, y - 15.5) <= 12) data.set(fill, (y * SIZE + x) * 4);
    }
  }
  return data;
}

const DARK = disc([0, 0, 0, 255]);
const LIGHT = disc([255, 255, 255, 255]);
const COLOR = disc([255, 36, 66, 255]);

let frame: Uint8ClampedArray = DARK;
let draws = 0;
let serial = 0;
let app: App | null = null;
let host: HTMLDivElement;

const source = () => `data:image/png;base64,favicon-${++serial}`;

function stubCanvas(overrides: Partial<Record<'getImageData', () => unknown>> = {}) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect: () => undefined,
    drawImage: () => { draws++; },
    getImageData: () => ({ data: frame }),
    ...overrides,
  }) as never);
}

function mount(render: () => ReturnType<typeof h>): HTMLImageElement {
  app = createApp({ render });
  app.mount(host);
  return host.querySelector('img')!;
}

async function load(image: HTMLImageElement): Promise<void> {
  image.dispatchEvent(new Event('load'));
  await nextTick();
}

beforeEach(() => {
  frame = DARK;
  draws = 0;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.restoreAllMocks();
});

describe('Favicon', () => {
  it('marks a dark monochrome favicon once it loads', async () => {
    stubCanvas();
    const image = mount(() => h(Favicon, { src: source() }));
    expect(image.classList.contains('ui-favicon')).toBe(true);
    expect(image.getAttribute('alt')).toBe('');
    expect(image.hasAttribute('data-ink')).toBe(false);
    await load(image);
    expect(image.dataset.ink).toBe('dark');
  });

  it('marks a light monochrome favicon', async () => {
    stubCanvas();
    frame = LIGHT;
    const image = mount(() => h(Favicon, { src: source() }));
    await load(image);
    expect(image.dataset.ink).toBe('light');
  });

  it('leaves colored favicons unmarked', async () => {
    stubCanvas();
    frame = COLOR;
    const image = mount(() => h(Favicon, { src: source() }));
    await load(image);
    expect(image.hasAttribute('data-ink')).toBe(false);
  });

  it('only reads inline images', async () => {
    const context = stubCanvas();
    const image = mount(() => h(Favicon, { src: 'https://example.com/favicon.ico' }));
    await load(image);
    expect(context).not.toHaveBeenCalled();
    expect(image.hasAttribute('data-ink')).toBe(false);
  });

  it('leaves favicons that restyle themselves for the color scheme alone', async () => {
    const context = stubCanvas();
    const adaptive = '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:#000}@media (prefers-color-scheme: dark){path{fill:#fff}}</style><path d="M0 0h16v16H0z"/></svg>';
    const shouted = adaptive.replace('prefers-color-scheme: dark', 'PREFERS-COLOR-SCHEME: DARK');
    const sources = [
      `data:image/svg+xml,${encodeURIComponent(adaptive)}`,
      `data:image/svg+xml;base64,${btoa(adaptive)}`,
      `data:image/svg+xml,${encodeURIComponent(shouted)}`,
      `data:image/svg+xml;BASE64,${btoa(adaptive)}`,
      `DATA:IMAGE/SVG+XML;charset=utf-8; base64,${btoa(adaptive)}`,
    ];
    for (const src of sources) {
      const image = mount(() => h(Favicon, { src }));
      await load(image);
      expect(image.hasAttribute('data-ink')).toBe(false);
      app?.unmount();
      app = null;
    }
    expect(context).not.toHaveBeenCalled();
    const fixed = mount(() => h(Favicon, { src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z"/></svg>')}` }));
    await load(fixed);
    expect(fixed.dataset.ink).toBe('dark');
  });

  it('reads data URL headers regardless of case', async () => {
    stubCanvas();
    const image = mount(() => h(Favicon, { src: `DATA:IMAGE/PNG;BASE64,favicon-${++serial}` }));
    await load(image);
    expect(image.dataset.ink).toBe('dark');
  });

  it('leaves the image alone when its pixels cannot be read', async () => {
    stubCanvas({ getImageData: () => { throw new DOMException('tainted', 'SecurityError'); } });
    const image = mount(() => h(Favicon, { src: source() }));
    await load(image);
    expect(image.hasAttribute('data-ink')).toBe(false);
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app?.unmount();
    const other = mount(() => h(Favicon, { src: source() }));
    await load(other);
    expect(other.hasAttribute('data-ink')).toBe(false);
  });

  it('reuses the verdict for a favicon it has already read', async () => {
    stubCanvas();
    const src = source();
    const first = mount(() => h(Favicon, { src }));
    await load(first);
    expect(draws).toBe(1);
    app?.unmount();
    const again = mount(() => h(Favicon, { src }));
    expect(again.dataset.ink).toBe('dark');
    await load(again);
    expect(draws).toBe(1);
  });

  it('judges the new image when the source changes', async () => {
    stubCanvas();
    const src = ref(source());
    const image = mount(() => h(Favicon, { src: src.value }));
    await load(image);
    expect(image.dataset.ink).toBe('dark');
    frame = COLOR;
    src.value = source();
    await nextTick();
    expect(image.hasAttribute('data-ink')).toBe(false);
    await load(image);
    expect(image.hasAttribute('data-ink')).toBe(false);
  });

  it("keeps the caller's class and listeners", async () => {
    stubCanvas();
    const onLoad = vi.fn();
    const image = mount(() => h(Favicon, { src: source(), class: 'tab-favicon', onLoad }));
    expect(image.classList.contains('tab-favicon')).toBe(true);
    await load(image);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(image.dataset.ink).toBe('dark');
  });
});
