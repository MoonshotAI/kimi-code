// @vitest-environment jsdom
import { computed, createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { BrowserReceiptReaderKey, loadBrowserReceipt, type BrowserReceiptImage, type BrowserReceiptReader } from '../src/chat/tool-calls/browserReceipts';
import BrowserReceiptThumb from '../src/chat/tool-calls/browser/BrowserReceiptThumb.vue';
import BrowserReceiptView from '../src/chat/tool-calls/browser/BrowserReceiptView.vue';
import BrowserReceiptStrip from '../src/chat/tool-calls/browser/BrowserReceiptStrip.vue';
import { BrowserToolContextKey } from '../src/chat/tool-calls/browserToolContext';
import { browserToolContexts } from '../src/chat/tool-calls/browserToolPresentation';

const image = (id: string, extra: Partial<BrowserReceiptImage> = {}): BrowserReceiptImage => ({ id, mimeType: 'image/jpeg', data: `data-${id}`, width: 480, height: 300, ...extra });

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

function mount(render: () => ReturnType<typeof h>, reader?: BrowserReceiptReader, provide?: (target: App) => void): HTMLElement {
  app = createApp({ render });
  app.use(createKimiI18n({ locale: 'zh' }));
  if (reader) app.provide(BrowserReceiptReaderKey, reader);
  provide?.(app);
  app.mount(host);
  return host;
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await nextTick();
  }
};

describe('browser receipt loading', () => {
  it('reads each receipt once, keeps recent ones and retries after a failure', async () => {
    const reader = vi.fn<BrowserReceiptReader>(async (_session, id) => image(id));
    const first = await loadBrowserReceipt(reader, 'session-a', 'r-000000000001');
    expect(first).toEqual({ url: 'data:image/jpeg;base64,data-r-000000000001', width: 480, height: 300 });
    await loadBrowserReceipt(reader, 'session-a', 'r-000000000001');
    expect(reader).toHaveBeenCalledTimes(1);
    await loadBrowserReceipt(reader, 'session-b', 'r-000000000001');
    expect(reader).toHaveBeenCalledTimes(2);

    const failing = vi.fn<BrowserReceiptReader>().mockRejectedValueOnce(new Error('ipc')).mockResolvedValueOnce(image('r-000000000002'));
    expect(await loadBrowserReceipt(failing, 'session-a', 'r-000000000002')).toBeNull();
    expect(await loadBrowserReceipt(failing, 'session-a', 'r-000000000002')).not.toBeNull();

    const missing = vi.fn<BrowserReceiptReader>(async () => null);
    expect(await loadBrowserReceipt(missing, 'session-a', 'r-000000000003')).toBeNull();
    expect(await loadBrowserReceipt(missing, 'session-a', 'r-000000000003')).toBeNull();
    expect(missing).toHaveBeenCalledTimes(1);

    const many = vi.fn<BrowserReceiptReader>(async (_session, id) => image(id));
    await loadBrowserReceipt(many, 'session-evict', 'r-100000000000');
    for (let i = 1; i <= 200; i++) await loadBrowserReceipt(many, 'session-evict', `r-2${String(i).padStart(11, '0')}`);
    await loadBrowserReceipt(many, 'session-evict', 'r-100000000000');
    expect(many.mock.calls.filter(([, id]) => id === 'r-100000000000')).toHaveLength(2);
  });
});

describe('browser receipt thumbnails', () => {
  it('zooms towards the action point and opens the full image without toggling its row', async () => {
    const reader = vi.fn<BrowserReceiptReader>(async (_session, id) => image(id, { point: { x: 0.25, y: 0.75 } }));
    const opened: unknown[] = [];
    const toggled = vi.fn();
    const root = mount(() => h('div', { onClick: toggled }, [h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-00000000000a', variant: 'row', label: 'View', onOpenMedia: (payload: unknown) => opened.push(payload) })]), reader);
    await settle();
    const img = root.querySelector<HTMLImageElement>('img')!;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,data-r-00000000000a');
    const canvas = root.querySelector<HTMLElement>('.brt-canvas')!;
    expect(canvas.style.transformOrigin).toBe('25% 75%');
    expect(canvas.style.transform).toBe('scale(2)');
    const dot = canvas.querySelector<HTMLElement>('.brt-dot')!;
    expect([dot.style.left, dot.style.top, dot.style.transform]).toEqual(['25%', '75%', 'translate(-50%, -50%) scale(0.5)']);
    root.querySelector<HTMLButtonElement>('button')!.click();
    expect(opened).toEqual([{ media: { kind: 'image', url: 'data:image/jpeg;base64,data-r-00000000000a', mimeType: 'image/jpeg' }, originImg: img }]);
    expect(toggled).not.toHaveBeenCalled();
  });

  it('frames an element box without a pointer dot, and draws both marks at full size', async () => {
    const reader = vi.fn<BrowserReceiptReader>(async (_session, id) => image(id, { box: { x: 0.25, y: 0.45, width: 0.5, height: 0.1 } }));
    const root = mount(() => h('div', [
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-00000000000b', variant: 'row', label: 'View' }),
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-00000000000b', variant: 'frame', label: 'View' }),
    ]), reader);
    await settle();
    const row = root.querySelector<HTMLElement>('.brt-row .brt-canvas')!;
    expect(row.style.transformOrigin).toBe('50% 50%');
    expect(row.style.transform).toBe('scale(1.6)');
    expect(root.querySelector('.brt-row .brt-dot')).toBeNull();
    const box = root.querySelector<HTMLElement>('.brt-frame .brt-canvas .brt-box')!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['25%', '45%', '50%', '10%']);
  });

  it('keeps the pointer dot on the spot it marks when the row zooms into an element box', async () => {
    const reader = vi.fn<BrowserReceiptReader>(async (_session, id) => image(id, { box: { x: 0.4, y: 0.45, width: 0.2, height: 0.1 }, point: { x: 0.55, y: 0.5 } }));
    const root = mount(() => h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-000000000013', variant: 'row', label: 'View' }), reader);
    await settle();
    const canvas = root.querySelector<HTMLElement>('.brt-canvas')!;
    expect([canvas.style.transformOrigin, canvas.style.transform]).toEqual(['50% 50%', 'scale(3)']);
    const dot = canvas.querySelector<HTMLElement>('.brt-dot')!;
    expect([dot.style.left, dot.style.top, dot.style.transform]).toEqual(['55%', '50%', 'translate(-50%, -50%) scale(0.3333)']);
  });

  it('takes the shape of the captured area so the marks stay on their target', async () => {
    const receipts: Record<string, BrowserReceiptImage> = {
      'r-000000000010': image('r-000000000010', { width: 320, height: 300, box: { x: 0.25, y: 0.45, width: 0.5, height: 0.1 }, point: { x: 0.5, y: 0.5 } }),
      'r-000000000011': image('r-000000000011', { width: 480, height: 50, point: { x: 0.9, y: 0.5 } }),
      'r-000000000012': image('r-000000000012', { width: 50, height: 300, point: { x: 0.5, y: 0.1 } }),
    };
    const root = mount(() => h('div', [
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-000000000010', variant: 'row', label: 'View' }),
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-000000000010', variant: 'frame', label: 'View' }),
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-000000000011', variant: 'frame', label: 'View' }),
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-000000000012', variant: 'frame', label: 'View' }),
    ]), async (_session, id) => receipts[id] ?? null);
    await settle();
    const buttons = [...root.querySelectorAll<HTMLElement>('button')];
    expect(buttons.map((button) => button.style.width)).toEqual([
      'calc(var(--browser-receipt-thumb-height) * 1.0667)',
      'calc(var(--browser-receipt-frame-height) * 1.0667)',
      'calc(var(--browser-receipt-frame-height) * 2.4)',
      'calc(var(--browser-receipt-frame-height) * 0.6)',
    ]);
    const placement = (button: HTMLElement) => {
      const { left, top, width, height } = button.querySelector<HTMLElement>('.brt-canvas')!.style;
      return [left, top, width, height];
    };
    expect(buttons.map(placement)).toEqual([
      ['0%', '0%', '100%', '100%'],
      ['0%', '0%', '100%', '100%'],
      ['0%', '37.5%', '100%', '25%'],
      ['36.11%', '0%', '27.78%', '100%'],
    ]);
    const box = buttons[1]!.querySelector<HTMLElement>('.brt-canvas .brt-box')!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['25%', '45%', '50%', '10%']);
    expect(buttons[2]!.querySelector<HTMLElement>('.brt-canvas .brt-ring')!.style.left).toBe('90%');
    expect(buttons[3]!.querySelector<HTMLElement>('.brt-canvas .brt-ring')!.style.top).toBe('10%');
  });

  it('keeps the default shape while loading and for a missing frame', async () => {
    let finish: (value: BrowserReceiptImage | null) => void = () => undefined;
    const root = mount(() => h('div', [
      h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-000000000014', variant: 'frame', label: 'View' }),
    ]), () => new Promise((resolve) => { finish = resolve; }));
    await settle();
    expect(root.querySelector<HTMLElement>('.brt-pending')!.style.width).toBe('');
    finish(null);
    await settle();
    expect(root.querySelector<HTMLElement>('.brt-missing')!.style.width).toBe('');
  });

  it('renders nothing without a desktop reader or when the receipt is gone', async () => {
    const empty = mount(() => h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-00000000000c', variant: 'row', label: 'View' }));
    await settle();
    expect(empty.querySelector('*')).toBeNull();
    app!.unmount();
    host.replaceChildren();
    const gone = mount(() => h(BrowserReceiptThumb, { sessionId: 's1', receiptId: 'r-00000000000d', variant: 'row', label: 'View' }), async () => null);
    await settle();
    expect(gone.querySelector('img')).toBeNull();
    expect(gone.querySelector('button')).toBeNull();
  });
});

describe('browser receipt details', () => {
  it('shows the receipt with its marks, and explains when it cannot be shown', async () => {
    const reader: BrowserReceiptReader = async (_session, id) => id.endsWith('1') ? image(id, { point: { x: 0.5, y: 0.5 }, box: { x: 0.25, y: 0.45, width: 0.5, height: 0.1 } }) : null;
    const root = mount(() => h('div', [
      h(BrowserReceiptView, { sessionId: 's1', receiptId: 'r-000000000001' }),
      h(BrowserReceiptView, { sessionId: 's1', receiptId: 'r-000000000002' }),
      h(BrowserReceiptView, { sessionId: undefined, receiptId: 'r-000000000003' }),
    ]), reader);
    await settle();
    const views = root.querySelectorAll('.brv');
    expect(views[0]!.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,data-r-000000000001');
    expect(views[0]!.querySelector<HTMLElement>('.bshot-point')!.style.left).toBe('50%');
    expect(views[0]!.querySelector<HTMLElement>('.bshot-box')!.style.width).toBe('50%');
    expect(views[1]!.textContent).toContain('这张截图已不可用');
    expect(views[2]!.textContent).toContain('这张截图已不可用');
    app!.unmount();
    host.replaceChildren();
    const web = mount(() => h(BrowserReceiptView, { sessionId: 's1', receiptId: 'r-000000000001' }));
    await settle();
    expect(web.textContent).toContain('这张截图保存在桌面应用中');
  });
});

describe('browser receipt strip', () => {
  const tool = (id: string, operation: string, result: Record<string, unknown>): ToolCall => ({
    id, name: 'mcp__desktop_browser__run', status: 'ok',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, tabId: 't', snapshotId: 's', ref: 'e1', text: 'hello' }),
    output: [JSON.stringify({ ok: true, operation, ...result })],
  });

  function strip(items: ToolCall[], reader?: BrowserReceiptReader) {
    const turns = [{ id: 'turn', sessionId: 'session-1', role: 'assistant' as const, no: 1, text: '', tools: items }];
    const contexts = computed(() => browserToolContexts(turns));
    const activity = [
      ...items.map((item, sourceIndex) => ({ kind: 'tool' as const, tool: item, sourceIndex })),
      { kind: 'thinking' as const, thinking: 'x', sourceIndex: 9 },
    ];
    return mount(() => h(BrowserReceiptStrip, { items: activity }), reader, (target) => target.provide(BrowserToolContextKey, contexts));
  }

  it('lists the before-action receipts of a run in order with their step', async () => {
    const reader = vi.fn<BrowserReceiptReader>(async (_session, id) => image(id));
    const root = strip([
      tool('a', 'page.element.click', { receipt: 'r-00000000000e' }),
      tool('b', 'page.text.snapshot', {}),
      tool('c', 'page.element.fill', { receipt: 'r-00000000000f' }),
    ], reader);
    await settle();
    expect(root.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe('本组操作前画面');
    expect([...root.querySelectorAll('.brs-caption')].map((item) => item.textContent)).toEqual(['已点击 页面元素', '已填写 “hello” · 页面元素']);
    expect(reader.mock.calls.map(([session, id]) => `${session}/${id}`)).toEqual(['session-1/r-00000000000e', 'session-1/r-00000000000f']);
  });

  it('stays out of the way with fewer than two receipts or without a desktop reader', async () => {
    const one = strip([tool('a', 'page.element.click', { receipt: 'r-00000000000e' }), tool('b', 'page.element.click', {})], async (_session, id) => image(id));
    await settle();
    expect(one.querySelector('[role="list"]')).toBeNull();
    app!.unmount();
    host.replaceChildren();
    const web = strip([tool('a', 'page.element.click', { receipt: 'r-00000000000e' }), tool('b', 'page.element.click', { receipt: 'r-00000000000f' })]);
    await settle();
    expect(web.querySelector('[role="list"]')).toBeNull();
  });
});
