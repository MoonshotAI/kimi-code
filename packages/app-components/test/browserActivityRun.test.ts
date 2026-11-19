// @vitest-environment jsdom
import { computed, createApp, h, nextTick, reactive, type App } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return { Markdown: vue.defineComponent({ name: 'Markdown', props: { text: String }, setup: (props) => () => vue.h('div', { class: 'md-stub' }, props.text) }) };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';
import { resetKimiClientDeps, setKimiClientDeps } from '../../app-client/src/client/deps';
import type { ActivityItem } from '../src/chatTurnRendering';
import ActivityRun from '../src/chat/ActivityRun.vue';
import BrowserSources from '../src/chat/tool-calls/browser/BrowserSources.vue';
import { BrowserToolContextKey } from '../src/chat/tool-calls/browserToolContext';
import { browserToolContexts } from '../src/chat/tool-calls/browserToolPresentation';
import { BrowserFaviconSourceKey, BrowserLiveViewKey, type BrowserLiveView } from '../src/chat/tool-calls/browserLive';
import { BrowserReceiptReaderKey } from '../src/chat/tool-calls/browserReceipts';

const i18n = createKimiI18n({ locale: 'zh' });
const SEARCH = 'https://notes.example/search?keyword=jeju';
const POST_A = 'https://notes.example/explore/a';
const POST_B = 'https://notes.example/explore/b';
let serial = 0;
let app: App | null = null;
let host: HTMLDivElement;

beforeAll(() => {
  setKimiClientDeps({ api: () => { throw new Error('unused'); }, t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params as never)) });
});

afterAll(() => resetKimiClientDeps());

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
  vi.restoreAllMocks();
});

function call(operation: string, args: Record<string, unknown> = {}, result?: Record<string, unknown>, status: ToolCall['status'] = 'ok'): ToolCall {
  serial++;
  return {
    id: `run-call-${serial}`,
    name: 'mcp__desktop_browser__run',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, ...args }),
    status,
    output: result === undefined ? undefined : [JSON.stringify({ operation, ...result })],
  };
}

const tab = (url: string, title: string) => ({ tabId: 'tab-1', url, title, loading: false });
const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });
const elements = (snapshotId: string, names: Record<string, string>) => ok({
  tab: tab(SEARCH, 'jeju - 搜索'),
  elements: { snapshotId, elements: Object.entries(names).map(([ref, name]) => ({ ref, name, role: 'link' })) },
});

function research() {
  const tools = {
    create: call('browser.create_tab', { url: SEARCH }, ok({ tab: tab(SEARCH, 'jeju - 搜索') })),
    list: call('page.elements.snapshot', { tabId: 'tab-1' }, elements('el-1', { e1: '城山日出峰这样走', e2: '东线保姆级攻略' })),
    openA: call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1' }, ok({ tab: tab(POST_A, 'jeju - 搜索'), receipt: 'r-00000000000a' })),
    readA: call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } })),
    back: call('tab.go_back', { tabId: 'tab-1' }, ok({ tab: tab(SEARCH, 'jeju - 搜索') })),
    staleB: call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e2' }, { ok: false, error: { code: 'STALE_ELEMENT', message: 'stale' } }, 'error'),
    relist: call('page.elements.snapshot', { tabId: 'tab-1' }, elements('el-2', { e5: '东线保姆级攻略' })),
    openB: call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e5' }, ok({ tab: tab(POST_B, 'jeju - 搜索'), receipt: 'r-00000000000b' })),
    shotB: call('page.visual.snapshot', { tabId: 'tab-1' }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记'), visual: { snapshotId: 'v-1', width: 10, height: 10 } })),
    readB: call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } })),
  };
  return { tools, list: Object.values(tools) };
}

function turnOf(list: ToolCall[], id = 'turn'): ChatTurn {
  return { id, sessionId: 'session-1', role: 'assistant', no: 1, text: '', tools: list };
}

const itemsOf = (list: ToolCall[]): ActivityItem[] => list.map((tool, sourceIndex) => ({ kind: 'tool', tool, sourceIndex }));

async function hover(el: Element): Promise<void> {
  vi.useFakeTimers();
  try {
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
    el.dispatchEvent(new MouseEvent('pointermove', { clientX: 24, clientY: 18, bubbles: true }));
    vi.advanceTimersByTime(200);
  } finally {
    vi.useRealTimers();
  }
  await settle();
}

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await nextTick();
  }
};

function mount(render: () => ReturnType<typeof h>, turns: ChatTurn[], provide: (target: App) => void = () => {}): HTMLElement {
  app = createApp({ render });
  app.use(i18n);
  app.provide(BrowserToolContextKey, computed(() => browserToolContexts(turns)));
  provide(app);
  app.mount(host);
  return host;
}

describe('browser activity runs', () => {
  it('summarizes a finished run by pages and folds the recovered click into one row', async () => {
    const { tools, list } = research();
    const items = itemsOf(list);
    items.splice(6, 0, { kind: 'thinking', thinking: 'the list changed', sourceIndex: 99 });
    const root = mount(() => h(ActivityRun, { items }), [turnOf(list)]);
    await settle();
    const summary = root.querySelector('.ar-sum')!;
    expect(summary.textContent).toBe('浏览了 3 个页面，读了 2 个 · 点击 2 次 · 截图 1 次 · 重试 1 次');
    expect(summary.hasAttribute('title')).toBe(false);
    await hover(root.querySelector('.ar-head')!);
    expect(document.querySelector('.ui-tip__bubble')?.textContent).toContain('共 10 次浏览器操作：新建标签页 1、查看页面元素 2、点击页面元素 3（1 失败）');
    expect(root.querySelector('.ar-sr-only')?.textContent).toBe('done');
    const rows = [...root.querySelectorAll('.ar-body-inner > .tool-line, .ar-body-inner > .think')];
    expect(rows).toHaveLength(8);
    const retry = root.querySelector<HTMLElement>('.browser-retry')!;
    expect(retry.querySelector('.tl-name')?.textContent).toBe('已点击');
    expect(retry.querySelector('.tl-dim')?.textContent).toBe('东线保姆级攻略');
    expect(retry.querySelector('.brr-chip')?.textContent?.trim()).toBe('重试 1 次');
    expect(retry.querySelector('.tl-status')).toBeNull();
    retry.querySelector<HTMLElement>('.tl-head')!.click();
    await settle();
    expect(retry.querySelector('.brr-caption')?.textContent).toBe('完整经过（3 次调用）');
    const attempts = [...retry.querySelectorAll('.brr-attempt')];
    expect(attempts).toHaveLength(4);
    expect(attempts[0]!.querySelector('.tl-name')?.textContent).toBe('点击失败');
    expect(attempts[0]!.querySelector('.tl-status.error')).not.toBeNull();
    expect(attempts[1]!.querySelector('.think')).not.toBeNull();
    expect(attempts[2]!.querySelector('.tl-name')?.textContent).toBe('已查看页面元素');
    expect(attempts[3]!.querySelector('.tl-name')?.textContent).toBe('已点击');
    expect(tools.staleB.status).toBe('error');
  });

  it('keeps unrecovered failures visible in the rows and the title', async () => {
    const failed = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, { ok: false, error: { code: 'NAVIGATION_FAILED', message: 'x' } }, 'error');
    const opened = call('tab.navigate', { tabId: 'tab-1', url: SEARCH }, ok({ tab: tab(SEARCH, 'jeju - 搜索') }));
    const root = mount(() => h(ActivityRun, { items: itemsOf([opened, failed]) }), [turnOf([opened, failed])]);
    await settle();
    expect(root.querySelector('.ar-sum')?.textContent).toBe('浏览了 1 个页面 · 另有 1 次失败');
    expect(root.querySelector('.ar-sr-only')?.textContent).toBe('error');
    expect(root.querySelector('.browser-retry')).toBeNull();
    expect(root.querySelectorAll('.tool-line.err')).toHaveLength(1);
  });

  it('marks the group failed when the browser reports a failure without an error status', async () => {
    const opened = call('browser.create_tab', { url: SEARCH }, ok({ tab: tab(SEARCH, 'jeju - 搜索') }));
    const refused = call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1' }, { ok: false, error: { code: 'ELEMENT_NOT_FOUND', message: 'gone' } });
    const root = mount(() => h(ActivityRun, { items: itemsOf([opened, refused]) }), [turnOf([opened, refused])]);
    await settle();
    expect(root.querySelector('.ar-sum')?.textContent).toBe('浏览了 1 个页面 · 点击 1 次（1 失败）');
    expect(root.querySelector('.ar-sr-only')?.textContent).toBe('error');
  });

  it('narrates the running step and offers to show the page the agent controls', async () => {
    const { tools } = research();
    const running: ToolCall = { ...tools.readA, status: 'running', output: undefined };
    const elsewhere: ToolCall = { ...call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-9', ref: 'e9' }, ok({ tab: tab(POST_B, 'B'), receipt: 'r-00000000000c' })), agentId: 'agent-2' };
    const list = [tools.create, tools.list, tools.openA, elsewhere, running];
    const state = reactive({ visible: false, controlled: true, tab: 'tab-1' });
    const show = vi.fn();
    const liveView: BrowserLiveView = {
      state: (sessionId) => (sessionId === 'session-1' && state.controlled ? { visible: state.visible, tabId: state.tab } : null),
      show,
    };
    const reader = vi.fn(async (_session: string, id: string) => ({ id, mimeType: 'image/jpeg' as const, data: id, width: 480, height: 300, point: { x: 0.5, y: 0.5 } }));
    const root = mount(() => h(ActivityRun, { items: itemsOf(list) }), [turnOf(list)], (target) => {
      target.provide(BrowserLiveViewKey, liveView);
      target.provide(BrowserReceiptReaderKey, reader);
    });
    await settle();
    expect(root.querySelector('.ar-sum')?.textContent).toBe('正在读取页面文字「城山日出峰这样走」 · 已浏览 3 个页面');
    const entry = root.querySelector<HTMLElement>('.ar-top .ble')!;
    expect(entry).not.toBeNull();
    expect(entry.textContent).toContain('查看');
    expect(reader).toHaveBeenCalledWith('session-1', 'r-00000000000a');
    expect(entry.querySelector('img.brt-img')?.getAttribute('src')).toBe('data:image/jpeg;base64,r-00000000000a');
    expect(entry.querySelector('button.brt .brt-live .kw-dot--running')).not.toBeNull();
    entry.querySelector<HTMLButtonElement>('.ble-view')!.click();
    expect(show).toHaveBeenCalledWith('session-1');
    entry.querySelector<HTMLButtonElement>('button.brt')!.click();
    expect(show).toHaveBeenCalledTimes(2);
    state.tab = 'tab-2';
    await settle();
    expect(root.querySelector('.ble button.brt')).toBeNull();
    expect(root.querySelector('.ble')?.textContent).toContain('查看');
    state.tab = 'tab-1';
    await settle();
    expect(root.querySelector('.ble button.brt')).not.toBeNull();
    state.visible = true;
    await settle();
    expect(root.querySelector('.ble')).toBeNull();
    state.visible = false;
    state.controlled = false;
    await settle();
    expect(root.querySelector('.ble')).toBeNull();
  });

  it('shows no live entry without a native browser or once the run ends', async () => {
    const { tools } = research();
    const running: ToolCall = { ...tools.readA, status: 'running', output: undefined };
    const root = mount(() => h(ActivityRun, { items: itemsOf([tools.create, running]) }), [turnOf([tools.create, running])]);
    await settle();
    expect(root.querySelector('.ble')).toBeNull();
    app?.unmount();
    host.replaceChildren();
    const finished = mount(() => h(ActivityRun, { items: itemsOf([tools.create, tools.readA]) }), [turnOf([tools.create, tools.readA])], (target) => {
      target.provide(BrowserLiveViewKey, { state: () => ({ visible: false, tabId: 'tab-1' }), show: vi.fn() });
    });
    await settle();
    expect(finished.querySelector('.ble')).toBeNull();
  });
});

describe('browser sources', () => {
  it('lists the pages read and passed through, and opens them in the right panel', async () => {
    const { list } = research();
    const opened: string[] = [];
    const refresh = vi.fn();
    const turns = [turnOf(list.slice(0, 5), 'turn-a'), turnOf(list.slice(5), 'turn-b')];
    const root = mount(() => h(BrowserSources, { turns }), turns, (target) => {
      target.provide(OpenSidebarBrowserUrlKey, () => (url: string) => { opened.push(url); });
      target.provide(BrowserFaviconSourceKey, { refresh, favicon: (url: string) => (url.includes('notes.example') ? 'data:image/png;base64,AA' : undefined) });
    });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    const pill = root.querySelector<HTMLButtonElement>('.bsrc-pill')!;
    expect(pill.textContent?.trim()).toBe('来源 · 读了 2 个页面 · 经过 1 个页面');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    expect([...pill.classList]).toEqual(expect.arrayContaining(['ui-button', 'ui-button--secondary', 'ui-button--sm']));
    expect(root.querySelectorAll('.bsrc-sites .bsrc-fav')).toHaveLength(1);
    expect(root.querySelector('.bsrc-sites img')?.getAttribute('src')).toBe('data:image/png;base64,AA');
    expect(root.querySelector('.bsrc-fallback')).toBeNull();
    pill.click();
    await settle();
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    const groups = [...root.querySelectorAll('.bsrc-group')];
    expect(groups.map((group) => group.querySelector('.bsrc-group-title')?.textContent)).toEqual(['读过的页面', '经过的页面']);
    const titles = [...root.querySelectorAll('.bsrc-title')].map((node) => node.textContent);
    expect(titles).toEqual(['城山日出峰这样走', '东线保姆级攻略 - 笔记', 'jeju - 搜索']);
    const tags = [...root.querySelectorAll('.bsrc-tag')];
    expect(tags.map((node) => node.textContent?.trim())).toEqual(['已读', '已读', '打开 2 次']);
    expect(tags.map((node) => [...node.classList].filter((name) => name.startsWith('ui-badge')))).toEqual([
      ['ui-badge', 'ui-badge--success', 'ui-badge--sm'],
      ['ui-badge', 'ui-badge--success', 'ui-badge--sm'],
      ['ui-badge', 'ui-badge--neutral', 'ui-badge--sm'],
    ]);
    expect(root.querySelector<HTMLElement>('.bsrc-list')?.style.getPropertyValue('--bsrc-action-count')).toBe('3');
    expect(root.querySelector('.bsrc-address')?.textContent).toBe('notes.example/explore/a');
    root.querySelector<HTMLButtonElement>('.bsrc-main')!.click();
    expect(opened).toEqual([POST_A]);
    const external = vi.spyOn(window, 'open').mockReturnValue(null);
    const actions = root.querySelectorAll('.bsrc-row')[2]!.querySelectorAll<HTMLButtonElement>('.bsrc-actions button');
    expect(actions).toHaveLength(3);
    actions[0]!.click();
    actions[1]!.click();
    expect(opened).toEqual([POST_A, SEARCH]);
    expect(external).toHaveBeenCalledWith(SEARCH, '_blank', 'noopener');
    const writeText = vi.fn(async () => undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      actions[2]!.click();
      await settle();
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
    expect(writeText).toHaveBeenCalledWith(SEARCH);
    expect(actions[2]!.getAttribute('aria-label')).toBe('已复制链接');
    root.querySelector('.bsrc-sites img')!.dispatchEvent(new Event('error'));
    await settle();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelectorAll('.bsrc-sites .bsrc-fav > .bsrc-fallback')).toHaveLength(1);
    expect(root.querySelectorAll('.bsrc-main .bsrc-fav > .bsrc-fallback')).toHaveLength(3);
  });

  it('marks a monochrome site icon so the theme can keep it visible', async () => {
    const frame = new Uint8ClampedArray(32 * 32 * 4);
    for (let pixel = 0; pixel < 32 * 32; pixel++) {
      if (Math.hypot((pixel % 32) - 15.5, Math.floor(pixel / 32) - 15.5) <= 12) frame[pixel * 4 + 3] = 255;
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: () => undefined, drawImage: () => undefined, getImageData: () => ({ data: frame }) } as never);
    const navigate = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, ok({ tab: tab(POST_A, '城山日出峰这样走') }));
    const turns = [turnOf([navigate])];
    const root = mount(() => h(BrowserSources, { turns }), turns, (target) => {
      target.provide(BrowserFaviconSourceKey, { refresh: vi.fn(), favicon: () => 'data:image/png;base64,bW9ubw==' });
    });
    await settle();
    const icon = root.querySelector<HTMLImageElement>('.bsrc-sites img')!;
    expect(icon.hasAttribute('data-ink')).toBe(false);
    icon.dispatchEvent(new Event('load'));
    await settle();
    expect(icon.dataset.ink).toBe('dark');
  });

  it('shows the whole address in a tooltip instead of a native title', async () => {
    const navigate = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, ok({ tab: tab(POST_A, '城山日出峰这样走') }));
    const turns = [turnOf([navigate])];
    const root = mount(() => h(BrowserSources, { turns }), turns);
    await settle();
    root.querySelector<HTMLButtonElement>('.bsrc-pill')!.click();
    await settle();
    const main = root.querySelector<HTMLButtonElement>('.bsrc-main')!;
    expect(main.hasAttribute('title')).toBe(false);
    expect(main.parentElement?.className).toBe('ui-tip');
    await hover(main);
    expect(document.querySelector('.ui-tip__bubble')?.textContent?.trim()).toBe(POST_A);
  });

  it('opens pages in the system browser where no panel exists and hides without pages', async () => {
    const navigate = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, ok({ tab: tab(POST_A, '') }));
    const turns = [turnOf([navigate])];
    const external = vi.spyOn(window, 'open').mockReturnValue(null);
    const root = mount(() => h('div', [h(BrowserSources, { turns }), h(BrowserSources, { turns: [turnOf([], 'empty')] })]), turns);
    await settle();
    expect(root.querySelectorAll('.bsrc')).toHaveLength(1);
    expect(root.querySelector('.bsrc-pill')?.textContent?.trim()).toBe('来源 · 浏览了 1 个页面');
    expect(root.querySelectorAll('.bsrc-sites .bsrc-fav > .bsrc-fallback')).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('.bsrc-pill')!.click();
    await settle();
    expect(root.querySelectorAll('.bsrc-main .bsrc-fav > .bsrc-fallback')).toHaveLength(1);
    expect(root.querySelector('.bsrc-title')?.textContent).toBe('notes.example/explore/a');
    expect(root.querySelector('.bsrc-address')?.textContent).toBe('notes.example');
    expect(root.querySelector('.bsrc-tag')?.textContent?.trim()).toBe('经过');
    expect(root.querySelectorAll('.bsrc-actions button')).toHaveLength(2);
    expect(root.querySelector<HTMLElement>('.bsrc-list')?.style.getPropertyValue('--bsrc-action-count')).toBe('2');
    root.querySelector<HTMLButtonElement>('.bsrc-main')!.click();
    expect(external).toHaveBeenCalledWith(POST_A, '_blank', 'noopener');
  });
});
