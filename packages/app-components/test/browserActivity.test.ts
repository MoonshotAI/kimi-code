import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import { summarizeActivity, summarizeLive, type ActivitySummaryItem, type SummaryClause } from '@moonshot-ai/app-core/lib';
import zh from '../../app-i18n/src/locales/zh/tools';
import en from '../../app-i18n/src/locales/en/tools';
import zhBrowser from '../../app-i18n/src/locales/zh/browser';
import enBrowser from '../../app-i18n/src/locales/en/browser';
import type { ActivityItem } from '../src/chatTurnRendering';
import { BrowserPageTracker, browserPageKey, readableBrowserUrl } from '../src/chat/tool-calls/browserPages';
import { browserClauseProvider, digestBrowserActivity } from '../src/chat/tool-calls/browserActivity';
import { foldBrowserRetries } from '../src/chat/tool-calls/browserRetries';
import { browserToolContexts, browserToolPresentation } from '../src/chat/tool-calls/browserToolPresentation';

const i18n = createKimiI18n({ locale: 'zh' });
const t = (key: string, params?: Record<string, unknown>) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params as never));

afterEach(() => {
  i18n.global.locale.value = 'zh';
});

const SEARCH = 'https://notes.example/search?keyword=jeju';
const POST_A = 'https://notes.example/explore/a';
const POST_B = 'https://notes.example/explore/b';
let serial = 0;

function call(operation: string, args: Record<string, unknown> = {}, result?: Record<string, unknown>, status: ToolCall['status'] = 'ok'): ToolCall {
  serial++;
  return {
    id: `call-${serial}`,
    name: 'mcp__desktop_browser__run',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, ...args }),
    status,
    output: result === undefined ? undefined : [JSON.stringify({ operation, ...result })],
  };
}

const tab = (url: string, title: string) => ({ tabId: 'tab-1', url, title, loading: false });
const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });
const failure = (code: string) => ({ ok: false, error: { code, message: code } });
const elements = (snapshotId: string, names: Record<string, string>) => ok({
  tab: tab(SEARCH, 'jeju - 搜索'),
  elements: { snapshotId, elements: Object.entries(names).map(([ref, name]) => ({ ref, name, role: 'link' })) },
});

function research() {
  const tools = {
    create: call('browser.create_tab', { url: SEARCH }, ok({ tab: tab(SEARCH, 'jeju - 搜索') })),
    list: call('page.elements.snapshot', { tabId: 'tab-1' }, elements('el-1', { e1: '城山日出峰这样走', e2: '东线保姆级攻略' })),
    openA: call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1' }, ok({ tab: tab(`${POST_A}#top`, 'jeju - 搜索') })),
    readA: call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } })),
    back: call('tab.go_back', { tabId: 'tab-1' }, ok({ tab: tab(SEARCH, 'jeju - 搜索') })),
    staleB: call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e2' }, failure('STALE_ELEMENT'), 'error'),
    relist: call('page.elements.snapshot', { tabId: 'tab-1' }, elements('el-2', { e5: '东线保姆级攻略' })),
    openB: call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e5' }, ok({ tab: tab(POST_B, 'jeju - 搜索') })),
    shotB: call('page.visual.snapshot', { tabId: 'tab-1' }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记'), visual: { snapshotId: 'v-1', width: 10, height: 10 } })),
    readB: call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } })),
  };
  const list = Object.values(tools);
  const turn: ChatTurn = { id: 'turn', sessionId: 'session', role: 'assistant', no: 1, text: '', tools: list };
  const contexts = browserToolContexts([turn]);
  return { tools, list, contexts, contextOf: (tool: ToolCall) => contexts.get(tool) };
}

const items = (list: ToolCall[]): ActivityItem[] => list.map((tool, sourceIndex) => ({ kind: 'tool', tool, sourceIndex }));
const summaryItems = (list: ToolCall[]): ActivitySummaryItem[] => list.map((tool) => ({ kind: 'tool', tool }));

function render(clauses: SummaryClause[]): string {
  return clauses.map((clause) => clause.fragments.map((part) => part.tone === 'faint' ? `${part.text}(faint)` : part.text).join('')).join(' · ');
}

describe('browser page tracking', () => {
  it('keys pages without their fragment and reads them back as text', () => {
    expect(browserPageKey('https://notes.example/a?x=1#top')).toBe('https://notes.example/a?x=1');
    expect(browserPageKey('https://notes.example/search/?q=1')).toBe(browserPageKey('https://notes.example/search?q=1'));
    expect(browserPageKey('https://notes.example/')).toBe('https://notes.example/');
    expect(readableBrowserUrl(`https://notes.example/explore/a?xsec_token=${'x'.repeat(60)}`)).toBe('notes.example/explore/a');
    expect(browserPageKey('about:blank')).toBeUndefined();
    expect(browserPageKey('')).toBeUndefined();
    expect(readableBrowserUrl('https://notes.example/%E6%B5%8E%E5%B7%9E?q=%E5%B2%9B')).toBe('notes.example/济州?q=岛');
    expect(readableBrowserUrl('https://notes.example/')).toBe('notes.example');
  });

  it('ignores a title the page carried over from the previous page and prefers the clicked link', () => {
    const tracker = new BrowserPageTracker();
    tracker.observe('t', SEARCH, 'Search');
    tracker.observe('t', POST_A, 'Search', 'Post A');
    expect(tracker.label(POST_A)).toBe('Post A');
    tracker.observe('t', POST_A, 'Search');
    expect(tracker.label(POST_A)).toBe('Post A');
    tracker.observe('t', POST_A, 'Post A - Notes');
    expect(tracker.label(POST_A)).toBe('Post A - Notes');
    tracker.observe('t', SEARCH, 'Post A - Notes');
    expect(tracker.label(SEARCH)).toBe('Search');
    tracker.observe('t', POST_B, 'Post A - Notes', '  ');
    expect(tracker.label(POST_B)).toBeUndefined();
    expect(tracker.current('t')).toBe(POST_B);
    expect(tracker.current('other')).toBeUndefined();
  });

  it('does not hand a title that arrived late to the page after it', () => {
    const tracker = new BrowserPageTracker();
    tracker.observe('t', SEARCH, 'Search');
    tracker.observe('t', POST_A, 'Search');
    expect(tracker.label(POST_A)).toBeUndefined();
    tracker.observe('t', POST_B, 'Post A');
    expect(tracker.label(POST_B)).toBeUndefined();
    tracker.observe('t', POST_B, 'Post B');
    expect(tracker.label(POST_B)).toBe('Post B');
  });

  it('trusts a real title on a page that follows one without any title', () => {
    const tracker = new BrowserPageTracker();
    tracker.observe('t', SEARCH, '');
    tracker.observe('t', POST_A, 'Post A');
    expect(tracker.label(POST_A)).toBe('Post A');
  });

  it('names rows after the page that was actually opened, not the stale title', () => {
    const { tools, contexts } = research();
    expect(contexts.get(tools.openA)?.page).toBe('城山日出峰这样走');
    expect(contexts.get(tools.readA)?.page).toBe('城山日出峰这样走');
    expect(contexts.get(tools.back)?.page).toBe('jeju - 搜索');
    expect(contexts.get(tools.staleB)?.page).toBe('jeju - 搜索');
    expect(contexts.get(tools.shotB)?.page).toBe('东线保姆级攻略 - 笔记');
    expect(browserToolPresentation(tools.readA, contexts.get(tools.readA)!, t).detail).toBe('城山日出峰这样走');
  });
});

describe('browser activity digest', () => {
  it('counts pages, reads, actions and failures in visit order', () => {
    const { tools, list, contextOf } = research();
    const digest = digestBrowserActivity(list, { context: (tool) => contextOf(tool as ToolCall) });
    expect(digest.pages).toEqual([
      { url: SEARCH, label: 'jeju - 搜索', titled: true, read: false, visits: 2 },
      { url: `${POST_A}#top`, label: '城山日出峰这样走', titled: true, read: true, visits: 1 },
      { url: POST_B, label: '东线保姆级攻略 - 笔记', titled: true, read: true, visits: 1 },
    ]);
    expect(digest.actions).toEqual([
      { category: 'click', count: 3, failed: 1 },
      { category: 'screenshot', count: 1, failed: 0 },
    ]);
    expect(digest).toMatchObject({ total: 10, failed: 1, retried: 0 });
    expect(digest.operations).toEqual([
      { action: 'createTab', count: 1, failed: 0 },
      { action: 'elements', count: 2, failed: 0 },
      { action: 'click', count: 3, failed: 1 },
      { action: 'readText', count: 2, failed: 0 },
      { action: 'back', count: 1, failed: 0 },
      { action: 'screenshot', count: 1, failed: 0 },
    ]);
    expect(digest.currentPage(tools.readB, 'tab-1')).toBe('东线保姆级攻略 - 笔记');
  });

  it('moves recovered attempts out of the action counts and into the retries', () => {
    const { tools, list, contextOf } = research();
    const digest = digestBrowserActivity(list, { context: (tool) => contextOf(tool as ToolCall), recovered: new Set([tools.staleB]) });
    expect(digest.actions[0]).toEqual({ category: 'click', count: 2, failed: 0 });
    expect(digest).toMatchObject({ total: 10, failed: 0, retried: 1 });
    expect(digest.operations.find((entry) => entry.action === 'click')).toEqual({ action: 'click', count: 3, failed: 1 });
  });

  it('leaves a probe that clicked nothing out of the click count', () => {
    const missed = call('page.visual.click_if_interactive', { tabId: 'tab-1', snapshotId: 'v-1', x: 5, y: 5 }, ok({ tab: tab(POST_A, 'A'), click: { outcome: 'no_target', nearby: [] } }));
    const hit = call('page.visual.click_if_interactive', { tabId: 'tab-1', snapshotId: 'v-1', x: 9, y: 9 }, ok({ tab: tab(POST_A, 'A'), click: { outcome: 'clicked', target: { name: 'Book' } } }));
    const digest = digestBrowserActivity([missed, hit]);
    expect(digest.actions).toEqual([{ category: 'click', count: 1, failed: 0 }]);
    expect(digest.operations).toEqual([{ action: 'guardedClick', count: 2, failed: 0 }]);
  });

  it('keeps the tabs of different agents apart when a read carries no page', () => {
    const elsewhere: ToolCall = { ...call('browser.create_tab', { url: POST_B }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记') })), agentId: 'agent-2' };
    const read = call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } }));
    const context = { url: SEARCH, title: 'jeju - 搜索', previousTab: { tabId: 'tab-1', url: SEARCH, title: 'jeju - 搜索' } };
    const digest = digestBrowserActivity([elsewhere, read], { context: (tool) => (tool === read ? context : undefined) });
    expect(digest.pages).toEqual([
      { url: POST_B, label: '东线保姆级攻略 - 笔记', titled: true, read: false, visits: 1 },
      { url: SEARCH, label: 'jeju - 搜索', titled: true, read: true, visits: 0 },
    ]);
    expect(digest.currentPage(read, 'tab-1')).toBe('jeju - 搜索');
    expect(digest.currentPage(elsewhere, 'tab-1')).toBe('东线保姆级攻略 - 笔记');
  });

  it('keeps the address the agent actually visited, hash route and all', () => {
    const route = 'https://app.example/#/settings';
    const other = 'https://app.example/#/billing';
    const digest = digestBrowserActivity([
      call('browser.create_tab', { url: route }, ok({ tab: { tabId: 'tab-1', url: route, title: 'Settings' } })),
      call('page.visual.click', { tabId: 'tab-1', snapshotId: 'v', x: 1, y: 1 }, ok({ tab: { tabId: 'tab-1', url: other, title: 'Settings' } })),
    ]);
    expect(digest.pages).toEqual([{ url: other, label: 'Settings', titled: true, read: false, visits: 1 }]);
  });

  it('keeps the real address of a page opened in an earlier answer', () => {
    const route = 'https://app.example/#/settings';
    const opened = call('browser.create_tab', { url: route }, ok({ tab: { tabId: 'tab-1', url: route, title: 'Settings' } }));
    const read = call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } }));
    const turns: ChatTurn[] = [
      { id: 'turn-1', sessionId: 'session', role: 'assistant', no: 1, text: '', tools: [opened] },
      { id: 'turn-2', sessionId: 'session', role: 'assistant', no: 2, text: '', tools: [read] },
    ];
    const contexts = browserToolContexts(turns);
    const digest = digestBrowserActivity([read], { context: (tool) => contexts.get(tool as ToolCall) });
    expect(digest.pages).toEqual([{ url: route, label: 'Settings', titled: true, read: true, visits: 0 }]);
  });

  it('falls back to a readable address for pages without a trustworthy name', () => {
    const digest = digestBrowserActivity([
      call('tab.navigate', { tabId: 'tab-1', url: POST_A }, ok({ tab: { tabId: 'tab-1', url: POST_A, title: '' } })),
      call('page.visual.click', { tabId: 'tab-1', snapshotId: 'v', x: 1, y: 1 }, ok({ tab: { tabId: 'tab-1', url: POST_B, title: '' } })),
      call('browser.get_state', {}, ok({ browser: { tabs: [tab('https://other.example/', 'Other')] } })),
      call('page.text.snapshot', { tabId: 'tab-9' }, ok({ text: { blocks: [] } })),
      { ...call('page.text.snapshot'), arg: 'not json' },
    ]);
    expect(digest.pages).toEqual([
      { url: POST_A, label: 'notes.example/explore/a', titled: false, read: false, visits: 1 },
      { url: POST_B, label: 'notes.example/explore/b', titled: false, read: false, visits: 1 },
    ]);
    expect(digest.total).toBe(5);
  });
});

describe('browser activity clauses', () => {
  it('summarizes a finished run by pages and the most frequent actions', () => {
    const { list, contextOf } = research();
    const summary = summarizeActivity(t, summaryItems(list), { durationMs: 175_000, locale: 'zh', providers: [browserClauseProvider(t, { contextOf })] });
    expect(render(summary.clauses)).toBe('浏览了 3 个页面，读了 2 个 · 点击 3 次（1 失败） · 截图 1 次 · 2 分钟 55 秒(faint)');
    expect(summary.detail).toBe('共 10 次浏览器操作：新建标签页 1、查看页面元素 2、点击页面元素 3（1 失败）、读取页面文字 2、返回上一页 1、截取页面截图 1');
  });

  it('reports recovered failures as retries and keeps unrelated failures visible', () => {
    const { tools, list, contextOf } = research();
    const navigate = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, failure('NAVIGATION_FAILED'), 'error');
    const summary = summarizeActivity(t, summaryItems([...list, navigate]), { providers: [browserClauseProvider(t, { contextOf, recovered: new Set([tools.staleB]) })] });
    expect(render(summary.clauses)).toBe('浏览了 3 个页面，读了 2 个 · 点击 2 次 · 截图 1 次 · 另有 1 次失败 · 重试 1 次(faint)');
  });

  it('describes a run on the page already open by what it read and did', () => {
    const { tools, contextOf } = research();
    const later = [
      call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } })),
      call('page.visual.snapshot', { tabId: 'tab-1' }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记'), visual: { snapshotId: 'v-2', width: 10, height: 10 } })),
      call('page.visual.scroll', { tabId: 'tab-1', snapshotId: 'v-2', x: 1, y: 1, deltaX: 0, deltaY: 300 }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记') })),
    ];
    const clicks = [
      call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e5' }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记') })),
      call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e5' }, ok({ tab: tab(POST_B, '东线保姆级攻略 - 笔记') })),
    ];
    const all = [...Object.values(tools), ...later, ...clicks];
    const contexts = browserToolContexts([{ id: 'turn', sessionId: 'session', role: 'assistant', no: 1, text: '', tools: all }]);
    const provider = browserClauseProvider(t, { contextOf: (tool) => contexts.get(tool) });
    expect(render(summarizeActivity(t, summaryItems(later), { providers: [provider] }).clauses)).toBe('读了 1 个页面 · 截图 1 次 · 滚动 1 次');
    expect(render(summarizeActivity(t, summaryItems(clicks), { providers: [provider] }).clauses)).toBe('点击 2 次');
    const digest = digestBrowserActivity(later, { context: (tool) => contexts.get(tool as ToolCall) });
    expect(digest.pages).toEqual([{ url: POST_B, label: '东线保姆级攻略 - 笔记', titled: true, read: true, visits: 0 }]);
    const live = summarizeLive(t, summaryItems(later), null, [provider]);
    expect(render(live.done)).toBe('已读 1 个页面(faint)');
    const elsewhere = call('tab.navigate', { tabId: 'tab-2', url: 'https://other.example/x' }, ok({ tab: { tabId: 'tab-2', url: 'https://other.example/x', title: 'X' } }));
    const readOld = call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } }));
    const withTabs = browserToolContexts([{ id: 'turn', sessionId: 'session', role: 'assistant', no: 1, text: '', tools: [...Object.values(tools), elsewhere, readOld] }]);
    const mixed = summarizeActivity(t, summaryItems([elsewhere, readOld]), { providers: [browserClauseProvider(t, { contextOf: (tool) => withTabs.get(tool) })] });
    expect(render(mixed.clauses)).toBe('浏览了 1 个页面 · 读了 1 个页面');
    expect(contextOf(tools.readA)).toMatchObject({ url: POST_A, title: '城山日出峰这样走' });
  });

  it('never reports a recovered failure as a failure, even without pages', () => {
    const invalid: ToolCall = { ...call('page.text.snapshot', { tabId: 'tab-9', scope: 'document' }), status: 'error', output: ['Invalid kimi.browser/1.0.0 request. /scope: must be object'] };
    const read = call('page.text.snapshot', { tabId: 'tab-9', scope: { kind: 'document' } }, ok({ text: { blocks: [] } }));
    const provider = browserClauseProvider(t, { recovered: new Set([invalid]) });
    expect(render(summarizeActivity(t, summaryItems([invalid, read]), { providers: [provider] }).clauses)).toBe('执行了 2 次浏览器操作 · 重试 1 次(faint)');
    expect(render(summarizeLive(t, summaryItems([invalid, read]), null, [provider]).done)).toBe('已执行了 2 次浏览器操作(faint) · 重试 1 次(faint)');
    const unrecovered = browserClauseProvider(t);
    expect(render(summarizeActivity(t, summaryItems([invalid, read]), { providers: [unrecovered] }).clauses)).toBe('执行了 2 次浏览器操作（1 失败）');
    expect(render(summarizeLive(t, summaryItems([invalid, read]), null, [unrecovered]).done)).toBe('已执行了 2 次浏览器操作(faint)（1 失败）(faint)');
  });

  it('keeps the generic clause when no page was reached', () => {
    const state = call('browser.get_state', {}, ok({ browser: { tabs: [] } }));
    const summary = summarizeActivity(t, summaryItems([state]), { providers: [browserClauseProvider(t)] });
    expect(render(summary.clauses)).toBe('执行了 1 次浏览器操作');
    expect(summary.detail).toBe('共 1 次浏览器操作：查看浏览器状态 1');
  });

  it('counts the call in flight in the hover breakdown', () => {
    const provider = browserClauseProvider(t);
    const opened = call('browser.create_tab', { url: SEARCH }, ok({ tab: tab(SEARCH, 'jeju - 搜索') }));
    const running: ToolCall = { ...call('page.text.snapshot', { tabId: 'tab-1' }), status: 'running', output: undefined };
    const items = summaryItems([opened, running]);
    const live = summarizeLive(t, items, items[1]!, [provider]);
    expect(live.detail).toBe('共 2 次浏览器操作：新建标签页 1、读取页面文字 1');
    expect(summarizeLive(t, summaryItems([running]), summaryItems([running])[0]!, [provider]).detail).toBe('共 1 次浏览器操作：读取页面文字 1');
  });

  it('narrates the running call with its target while live', () => {
    const { tools, contextOf } = research();
    const provider = browserClauseProvider(t, { contextOf });
    const running = (tool: ToolCall): ToolCall => ({ ...tool, status: 'running', output: undefined });
    const readA = running(tools.readA);
    const live = summarizeLive(t, summaryItems([tools.create, tools.list, tools.openA, readA]), { kind: 'tool', tool: readA }, [provider]);
    expect(render([live.current!])).toBe('正在读取页面文字「城山日出峰这样走」');
    expect(render(live.done)).toBe('已浏览 2 个页面(faint)');
    const openB = { ...running(tools.openB) };
    const clicking = summarizeLive(t, summaryItems([tools.create, openB]), { kind: 'tool', tool: openB }, [browserClauseProvider(t, { contextOf: (tool) => tool === openB ? contextOf(tools.openB) : contextOf(tool) })]);
    expect(render([clicking.current!])).toBe('正在点击「东线保姆级攻略」');
    const create = running(tools.create);
    expect(render([summarizeLive(t, summaryItems([create]), { kind: 'tool', tool: create }, [provider]).current!])).toBe('正在新建标签页「notes.example/search」');
    const typing = call('page.element.fill', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1', text: 'secret' }, undefined, 'running');
    const text = render([summarizeLive(t, summaryItems([typing]), { kind: 'tool', tool: typing }, [browserClauseProvider(t, { contextOf: () => ({ element: '一个非常非常非常非常非常非常长的输入框名称用于截断' }) })]).current!]);
    expect(text).toBe('正在填写「一个非常非常非常非常非常非常长的输入框名…」');
    expect(text).not.toContain('secret');
  });

  it('still loads and clips the running target where Intl.Segmenter is unavailable', async () => {
    const original = Intl.Segmenter;
    Reflect.set(Intl, 'Segmenter', undefined);
    try {
      vi.resetModules();
      const fresh = await import('../src/chat/tool-calls/browserActivity');
      const typing = call('page.element.fill', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1' }, undefined, 'running');
      const provider = fresh.browserClauseProvider(t, { contextOf: () => ({ element: '一个非常非常非常非常非常非常长的输入框名称用于截断' }) });
      const live = summarizeLive(t, summaryItems([typing]), { kind: 'tool', tool: typing }, [provider]);
      expect(render([live.current!])).toBe('正在填写「一个非常非常非常非常非常非常长的输入框名…」');
    } finally {
      Reflect.set(Intl, 'Segmenter', original);
    }
  });

  it('speaks English with plural forms', () => {
    i18n.global.locale.value = 'en';
    const { list, contextOf } = research();
    const summary = summarizeActivity(t, summaryItems(list), { providers: [browserClauseProvider(t, { contextOf })] });
    expect(render(summary.clauses)).toBe('Visited 3 pages, read 2 · 3 clicks (1 failed) · 1 screenshot');
    const single = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, ok({ tab: tab(POST_A, 'A') }));
    expect(render(summarizeActivity(t, summaryItems([single]), { providers: [browserClauseProvider(t)] }).clauses)).toBe('Visited 1 page');
  });

  it('defines every new string in both locales', () => {
    const keys = (value: unknown, prefix = ''): string[] => typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
      : [prefix.slice(0, -1)];
    for (const section of ['activity', 'sources', 'retry', 'live'] as const) {
      expect(keys(en.browser[section])).toEqual(keys(zh.browser[section]));
    }
    expect(typeof zhBrowser.controlOutOfView).toBe('string');
    expect(typeof enBrowser.controlOutOfView).toBe('string');
  });
});

describe('browser retry folding', () => {
  it('narrates a running search by its query and counts the results page as visited', () => {
    const provider = browserClauseProvider(t);
    const results = 'https://www.bing.com/search?q=jeju+food';
    for (const running of [
      call('tab.search', { tabId: 'tab-1', query: 'jeju food' }, undefined, 'running'),
      call('browser.create_tab', { query: 'jeju food' }, undefined, 'running'),
    ]) {
      expect(render([summarizeLive(t, summaryItems([running]), { kind: 'tool', tool: running }, [provider]).current!])).toBe('正在搜索「jeju food」');
    }
    const searched = call('tab.search', { tabId: 'tab-1', query: 'jeju food' }, ok({ search: { engine: 'bing' }, tab: tab(results, 'jeju food - Search') }));
    expect(digestBrowserActivity([searched]).pages).toMatchObject([{ url: results, visits: 1 }]);
  });

  const contextFor = (names: Map<ToolCall, string>) => (tool: ToolCall) => ({ element: names.get(tool) });

  it('folds a search retried with the same query but not one with a different query', () => {
    const blocked = call('tab.search', { tabId: 'tab-1', query: 'jeju food' }, failure('TAB_NOT_ACTIVE'), 'error');
    const same = call('tab.search', { tabId: 'tab-1', query: 'jeju food' }, ok({ tab: tab(SEARCH, 'jeju') }));
    expect(foldBrowserRetries(items([blocked, same]), () => undefined).items).toMatchObject([{ kind: 'browser-retry', tool: same, retries: 1 }]);
    const other = call('tab.search', { tabId: 'tab-1', query: 'jeju hotels' }, ok({ tab: tab(SEARCH, 'jeju') }));
    expect(foldBrowserRetries(items([blocked, other]), () => undefined).items.map((item) => item.kind)).toEqual(['tool', 'tool']);
  });

  it('folds a stale click, the fresh snapshot and the successful click into one row', () => {
    const { tools, contextOf } = research();
    const run: ActivityItem[] = [
      ...items([tools.back]),
      { kind: 'tool', tool: tools.staleB, sourceIndex: 1 },
      { kind: 'thinking', thinking: 'refresh', sourceIndex: 2 },
      { kind: 'tool', tool: tools.relist, sourceIndex: 3 },
      { kind: 'tool', tool: tools.openB, sourceIndex: 4 },
      { kind: 'tool', tool: tools.shotB, sourceIndex: 5 },
    ];
    const folded = foldBrowserRetries(run, contextOf);
    expect(folded.items.map((item) => item.kind)).toEqual(['tool', 'browser-retry', 'tool']);
    expect(folded.items[1]).toMatchObject({ tool: tools.openB, retries: 1, sourceIndex: 4, attempts: run.slice(1, 5) });
    expect([...folded.recovered]).toEqual([tools.staleB]);
  });

  it('folds a navigation that needed control and a request that needed fixing', () => {
    const blocked = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, failure('TAB_NOT_ACTIVE'), 'error');
    const activate = call('browser.activate_tab', { tabId: 'tab-1' }, ok({ tab: tab(SEARCH, 'jeju') }));
    const navigate = call('tab.navigate', { tabId: 'tab-1', url: `${POST_A}#x` }, ok({ tab: tab(POST_A, 'A') }));
    const invalid: ToolCall = { ...call('page.visual.scroll', { tabId: 'tab-1', x: 1 }), status: 'error', output: ['Invalid kimi.browser/1.0.0 request. Missing required parameters: deltaX.'] };
    const scroll = call('page.visual.scroll', { tabId: 'tab-1', snapshotId: 'v', x: 1, y: 1, deltaX: 0, deltaY: 400 }, ok({ tab: tab(POST_A, 'A') }));
    const folded = foldBrowserRetries(items([blocked, activate, navigate, invalid, scroll]), () => undefined);
    expect(folded.items).toMatchObject([
      { kind: 'browser-retry', tool: navigate, retries: 1 },
      { kind: 'browser-retry', tool: scroll, retries: 1 },
    ]);
    expect(folded.recovered).toEqual(new Set([blocked, invalid]));
  });

  it('counts repeated failed attempts of the same intent', () => {
    const names = new Map<ToolCall, string>();
    const first = call('page.element.click', { tabId: 'tab-1', ref: 'a' }, failure('ELEMENT_NOT_INTERACTABLE'), 'error');
    const second = call('page.element.click', { tabId: 'tab-1', ref: 'b' }, failure('STALE_ELEMENT'), 'error');
    const done = call('page.element.click', { tabId: 'tab-1', ref: 'c' }, ok({ tab: tab(POST_A, 'A') }));
    for (const tool of [first, second, done]) names.set(tool, 'Book');
    const folded = foldBrowserRetries(items([first, second, done]), contextFor(names));
    expect(folded.items).toMatchObject([{ kind: 'browser-retry', tool: done, retries: 2 }]);
  });

  it('leaves failures alone when the retry is a different intent, unrelated or never came', () => {
    const names = new Map<ToolCall, string>();
    const failed = call('page.element.click', { tabId: 'tab-1', ref: 'a' }, failure('STALE_ELEMENT'), 'error');
    const other = call('page.element.click', { tabId: 'tab-1', ref: 'b' }, ok({ tab: tab(POST_A, 'A') }));
    names.set(failed, 'Book').set(other, 'Cancel');
    const unknown = call('page.element.click', { tabId: 'tab-1', ref: 'c' }, failure('STALE_ELEMENT'), 'error');
    const later = call('page.element.click', { tabId: 'tab-1', ref: 'd' }, ok({ tab: tab(POST_A, 'A') }));
    const bash: ToolCall = { id: 'bash', name: 'Bash', arg: '{}', status: 'ok' };
    const read = call('page.text.snapshot', { tabId: 'tab-1' }, ok({ text: { blocks: [] } }));
    const brokenBridge = call('browser.activate_tab', { tabId: 'tab-1' }, failure('TAB_NOT_FOUND'), 'error');
    const fatal = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, failure('NAVIGATION_FAILED'), 'error');
    const retryNavigate = call('tab.navigate', { tabId: 'tab-1', url: POST_A }, ok({ tab: tab(POST_A, 'A') }));
    const otherTab = call('tab.navigate', { tabId: 'tab-2', url: POST_A }, failure('TAB_NOT_ACTIVE'), 'error');
    const pending: ToolCall = { ...call('tab.navigate', { tabId: 'tab-2', url: POST_A }), status: 'running' };
    const cases: ToolCall[][] = [
      [failed, other],
      [unknown, later],
      [failed, bash, other],
      [failed, read, other],
      [otherTab, brokenBridge, retryNavigate],
      [fatal, retryNavigate],
      [otherTab, retryNavigate],
      [otherTab, pending],
      [otherTab],
    ];
    for (const list of cases) {
      const folded = foldBrowserRetries(items(list), contextFor(names));
      expect(folded.items.every((item) => item.kind === 'tool')).toBe(true);
      expect(folded.recovered.size).toBe(0);
    }
  });
  it('does not fold a read of one element into a read of another', () => {
    const scoped = (snapshotId: string, ref: string, result?: Record<string, unknown>, status: ToolCall['status'] = 'ok') =>
      call('page.text.snapshot', { tabId: 'tab-1', scope: { kind: 'element', snapshotId, ref } }, result, status);
    const failed = scoped('el-1', 'e1', failure('STALE_SNAPSHOT'), 'error');
    const other = scoped('el-2', 'e7', ok({ text: { blocks: [] } }));
    const same = scoped('el-1', 'e1', ok({ text: { blocks: [] } }));
    expect(foldBrowserRetries(items([failed, other]), () => undefined).items.every((item) => item.kind === 'tool')).toBe(true);
    expect(foldBrowserRetries(items([failed, same]), () => undefined).items).toMatchObject([{ kind: 'browser-retry', tool: same, retries: 1 }]);
  });

  it('does not fold a failure into another agent\'s success on the same tab id', () => {
    const names = new Map<ToolCall, string>();
    const failed = call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1' }, failure('STALE_ELEMENT'), 'error');
    const retried: ToolCall = { ...call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e2' }, ok({ tab: tab(POST_A, 'A') })), agentId: 'agent-2' };
    const bridged: ToolCall = { ...call('page.elements.snapshot', { tabId: 'tab-1' }, elements('el-2', { e2: 'Book' })), agentId: 'agent-2' };
    for (const tool of [failed, retried]) names.set(tool, 'Book');
    expect(foldBrowserRetries(items([failed, retried]), contextFor(names)).items.every((item) => item.kind === 'tool')).toBe(true);
    expect(foldBrowserRetries(items([failed, bridged, { ...retried, agentId: undefined }]), contextFor(names)).items.every((item) => item.kind === 'tool')).toBe(true);
  });

  it('does not fold across preparation steps that belong to another tab', () => {
    const names = new Map<ToolCall, string>();
    const failed = call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1' }, failure('STALE_ELEMENT'), 'error');
    const elsewhere = call('page.visual.snapshot', { tabId: 'tab-2' }, ok({ tab: { tabId: 'tab-2', url: POST_B, title: 'B', loading: false }, visual: { snapshotId: 'v-2', width: 10, height: 10 } }));
    const anywhere = call('browser.get_state', {}, ok({ browser: { tabs: [] } }));
    const retried = call('page.element.click', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e2' }, ok({ tab: tab(POST_A, 'A') }));
    for (const tool of [failed, retried]) names.set(tool, 'Book');
    expect(foldBrowserRetries(items([failed, elsewhere, retried]), contextFor(names)).items.every((item) => item.kind === 'tool')).toBe(true);
    expect(foldBrowserRetries(items([failed, anywhere, retried]), contextFor(names)).items).toMatchObject([{ kind: 'browser-retry', tool: retried, retries: 1 }]);
  });

  it('folds only retries that aim at the same keys, text and wait condition', () => {
    const names = new Map<ToolCall, string>();
    const notReady = failure('PAGE_NOT_READY');
    const done = ok({ tab: tab(POST_A, 'A') });
    const shot = call('page.visual.snapshot', { tabId: 'tab-1' }, ok({ tab: tab(POST_A, 'A'), visual: { snapshotId: 'v-2', width: 10, height: 10 } }));
    const enter = call('page.visual.press_key', { tabId: 'tab-1', keys: ['Enter'] }, notReady, 'error');
    const escape = call('page.visual.press_key', { tabId: 'tab-1', keys: ['Escape'] }, done);
    const enterAgain = call('page.visual.press_key', { tabId: 'tab-1', keys: ['Enter'] }, done);
    const typed = call('page.visual.type_text', { tabId: 'tab-1', text: 'jeju' }, notReady, 'error');
    const typedOther = call('page.visual.type_text', { tabId: 'tab-1', text: 'seoul' }, done);
    const fill = call('page.element.fill', { tabId: 'tab-1', snapshotId: 'el-1', ref: 'e1', text: 'jeju' }, failure('STALE_ELEMENT'), 'error');
    const fillOther = call('page.element.fill', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e7', text: 'seoul' }, done);
    const fillSame = call('page.element.fill', { tabId: 'tab-1', snapshotId: 'el-2', ref: 'e7', text: 'jeju' }, done);
    for (const tool of [fill, fillOther, fillSame]) names.set(tool, 'Destination');
    const waitJeju = call('page.wait_for', { tabId: 'tab-1', condition: { kind: 'text', text: 'Jeju', state: 'present' }, timeoutMs: 1000 }, notReady, 'error');
    const waitSeoul = call('page.wait_for', { tabId: 'tab-1', condition: { kind: 'text', text: 'Seoul', state: 'present' } }, done);
    const waitJejuAgain = call('page.wait_for', { tabId: 'tab-1', condition: { state: 'present', text: 'Jeju', kind: 'text' }, timeoutMs: 5000 }, done);
    for (const list of [[enter, shot, escape], [typed, typedOther], [fill, fillOther], [waitJeju, waitSeoul]]) {
      const folded = foldBrowserRetries(items(list), contextFor(names));
      expect(folded.items.every((item) => item.kind === 'tool')).toBe(true);
      expect(folded.recovered.size).toBe(0);
    }
    for (const [failed, retried] of [[enter, enterAgain], [fill, fillSame], [waitJeju, waitJejuAgain]]) {
      const folded = foldBrowserRetries(items([failed!, shot, retried!]), contextFor(names));
      expect(folded.items).toMatchObject([{ kind: 'browser-retry', tool: retried, retries: 1 }]);
    }
  });

  it('compares coordinates on the same screenshot and accepts new ones only after the screenshot expired', () => {
    const outcome = (code: string | undefined) => (code === undefined ? ok({ tab: tab(POST_A, 'A') }) : failure(code));
    const status = (code: string | undefined): ToolCall['status'] => (code === undefined ? 'ok' : 'error');
    const click = (code: string | undefined, snapshotId: string, x: number, extra: Record<string, unknown> = {}) =>
      call('page.visual.click', { tabId: 'tab-1', snapshotId, x, y: 40, ...extra }, outcome(code), status(code));
    const scroll = (code: string | undefined, deltaY: number) =>
      call('page.visual.scroll', { tabId: 'tab-1', snapshotId: 'v-1', x: 5, y: 5, deltaX: 0, deltaY }, outcome(code), status(code));
    const drag = (code: string | undefined, snapshotId: string, toX: number) =>
      call('page.visual.drag', { tabId: 'tab-1', snapshotId, from: { x: 1, y: 1 }, to: { x: toX, y: 1 } }, outcome(code), status(code));
    const shot = call('page.visual.snapshot', { tabId: 'tab-1' }, ok({ tab: tab(POST_A, 'A'), visual: { snapshotId: 'v-2', width: 10, height: 10 } }));
    const folds = (list: ToolCall[]) => foldBrowserRetries(items(list), () => undefined).items.some((item) => item.kind === 'browser-retry');
    expect(folds([click('PAGE_NOT_READY', 'v-1', 10), click(undefined, 'v-1', 10)])).toBe(true);
    expect(folds([click('PAGE_NOT_READY', 'v-1', 10), click(undefined, 'v-1', 200)])).toBe(false);
    expect(folds([click('PAGE_NOT_READY', 'v-1', 10), click(undefined, 'v-1', 10, { button: 'right' })])).toBe(false);
    expect(folds([click('STALE_SNAPSHOT', 'v-1', 10), shot, click(undefined, 'v-2', 60)])).toBe(true);
    expect(folds([click('SNAPSHOT_EXPIRED', 'v-1', 10), shot, click(undefined, 'v-2', 60)])).toBe(true);
    expect(folds([click('PAGE_NOT_READY', 'v-1', 10), shot, click(undefined, 'v-2', 60)])).toBe(false);
    expect(folds([scroll('PAGE_NOT_READY', 400), scroll(undefined, -400)])).toBe(false);
    expect(folds([scroll('PAGE_NOT_READY', 400), scroll(undefined, 400)])).toBe(true);
    expect(folds([drag('PAGE_NOT_READY', 'v-1', 30), drag(undefined, 'v-1', 90)])).toBe(false);
    expect(folds([drag('STALE_SNAPSHOT', 'v-1', 30), shot, drag(undefined, 'v-2', 90)])).toBe(true);
  });
});
