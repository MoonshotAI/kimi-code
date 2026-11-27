// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({
      name: 'Markdown',
      props: { text: { type: String, default: '' } },
      setup: (props) => () => vue.h('div', { class: 'md-stub' }, props.text),
    }),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import ActivityRun from '../src/chat/ActivityRun.vue';
import GenericTool from '../src/chat/tool-calls/GenericTool.vue';
import GrepTool from '../src/chat/tool-calls/GrepTool.vue';
import WebFetchTool from '../src/chat/tool-calls/WebFetchTool.vue';
import { resolveToolRenderer } from '../src/chat/tool-calls/toolRegistry';

let app: App | null = null;
let host: HTMLDivElement;

function mount(tool: Partial<ToolCall>, locale: 'en' | 'zh', component: Component = GenericTool) {
  const i18n = createKimiI18n({ locale });
  setKimiClientDeps({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? i18n.global.t(key) : i18n.global.t(key, params),
  } as never);
  app = createApp({
    setup: () => () =>
      h(component, {
        tool: { id: 'call_1', name: '', arg: '', status: 'ok', startedAt: new Date().toISOString(), ...tool } as ToolCall,
      }),
  });
  app.use(i18n);
  app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(panelApiKey, { openFile: vi.fn() } as never);
  app.mount(host);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  resetKimiClientDeps();
});

describe('MCP authorization card', () => {
  it.each(['failed', 'reconnectFailed'] as const)('keeps %s diagnostics behind a closed disclosure', (phase) => {
    const output = ['Provider request failed', 'Reason: invalid_client'];
    const tool: ToolCall = { id: 'call', name: 'mcp__example__authenticate', arg: '{}', status: 'error', output, mcpAuth: { phase, serverName: 'example' } };
    mount(tool, 'zh', resolveToolRenderer(tool));
    const details = host.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toContain('错误详情');
    summary.click();
    expect(details.open).toBe(true);
    expect([...details.querySelectorAll('.op > div')].map(line => line.textContent)).toEqual(output);
    expect(host.querySelector('a, button')).toBeNull();
  });

  it('omits the error disclosure when no diagnostic was returned', () => {
    const tool: ToolCall = { id: 'call', name: 'mcp__example__authenticate', arg: '{}', status: 'error', output: [], mcpAuth: { phase: 'failed', serverName: 'example' } };
    mount(tool, 'zh', resolveToolRenderer(tool));
    expect(host.querySelector('details')).toBeNull();
  });

  it('links directly to the existing authorization URL without opening a blank popup and removes it at expiry', async () => {
    vi.useFakeTimers();
    const request = { serverName: 'example', waitId: 'wait-1', expiresAt: Date.now() + 1000, authorizationUrl: 'https://auth.example.test/authorize?state=test' };
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const copy = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
    vi.stubGlobal('kimiDesktop', { writeClipboardText: copy });
    try {
      const tool: ToolCall = { id: 'call', name: 'mcp__example__authenticate', arg: '{}', status: 'running', mcpAuth: { serverName: 'example', phase: 'waiting', request } };
      mount(tool, 'zh', resolveToolRenderer(tool));
      expect(open).not.toHaveBeenCalled();
      const link = host.querySelector('a')!;
      expect(link.textContent).toBe(request.authorizationUrl);
      expect(link.href).toBe(request.authorizationUrl);
      expect(link.rel).toContain('noopener');
      const [primary, secondary] = host.querySelectorAll('button');
      expect(primary!.textContent?.trim()).toBe('打开授权页');
      expect(secondary!.textContent?.trim()).toBe('复制链接');
      primary!.click();
      expect(open).toHaveBeenCalledWith(request.authorizationUrl, '_blank', 'noopener,noreferrer');
      secondary!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(copy).toHaveBeenCalledExactlyOnceWith(request.authorizationUrl);
      expect(secondary!.textContent).toContain('已复制');
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.querySelector('a, button')).toBeNull();
      expect(host.textContent).not.toContain(request.authorizationUrl);
      expect(host.textContent).toContain('已过期');
    } finally {
      vi.unstubAllGlobals();
      open.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('GenericTool computer use row', () => {
  const tool = { name: 'mcp__kimi-cu__get_app_state', arg: '{"mode":"image","app":"com.google.Chrome"}' };

  it.each([
    ['en', 'Screenshot app'],
    ['zh', '截取应用画面'],
  ] as const)('passes arg to the label in %s', (locale, label) => {
    mount(tool, locale);
    expect(host.querySelector('.tl-name')?.textContent).toBe(label);
    expect(host.querySelector('.tl-dim')?.textContent).toBe('com.google.Chrome');
    expect(host.textContent).not.toContain('mcp__');
  });

  it.each([
    ['en', 'App', 'com.google.Chrome', 'Mode', 'Screenshot'],
    ['zh', '应用', 'com.google.Chrome', '模式', '截图'],
  ] as const)('shows translated argument fields when expanded in %s', async (locale, appLabel, appValue, modeLabel, modeValue) => {
    mount(tool, locale);
    host.querySelector<HTMLElement>('[aria-expanded="false"]')?.click();
    await nextTick();
    const text = [...host.querySelectorAll('.gt-fields dt, .gt-fields dd')].map((n) => n.textContent);
    expect(text).toEqual([appLabel, appValue, modeLabel, modeValue]);
    expect(host.textContent).not.toContain('{"');
  });

  const realCalls = [
    { name: 'mcp__plugin-kimi-cu_mac__list_windows', arg: '{"app":"com.anysphere.sand"}', label: 'List windows', dim: 'com.anysphere.sand' },
    { name: 'mcp__plugin-kimi-cu_mac__activate_window', arg: '{"pid":67483,"window_id":120281}', label: 'Activate window', dim: undefined },
    { name: 'mcp__plugin-kimi-cu_mac__get_window_state', arg: '{"pid":67483,"window_id":120281,"include_screenshot":true}', label: 'Get window state', dim: undefined },
  ];

  it.each(realCalls)('shows $label collapsed without raw args', ({ name, arg, label, dim }) => {
    mount({ name, arg }, 'en');
    expect(host.querySelector('.tl-name')?.textContent).toBe(label);
    expect(host.querySelector('.tl-dim')?.textContent).toBe(dim);
    expect(host.textContent).not.toMatch(/[{}"]/);
  });

  it.each([
    ['en', ['Process ID', '67483', 'Window ID', '120281', 'Include screenshot', 'Yes']],
    ['zh', ['进程 ID', '67483', '窗口 ID', '120281', '包含截图', '是']],
  ] as const)('translates unlisted tool fields when expanded in %s', async (locale, expected) => {
    mount(realCalls[2]!, locale);
    host.querySelector<HTMLElement>('[aria-expanded="false"]')?.click();
    await nextTick();
    expect([...host.querySelectorAll('.gt-fields dt, .gt-fields dd')].map((n) => n.textContent)).toEqual(expected);
    expect(host.textContent).not.toContain('{"');
  });

  it('translates window tool labels and their remaining argument keys in zh', async () => {
    mount({ name: 'mcp__kimi-cu__get_window_state', arg: '{"include_text":true,"rect":"r"}' }, 'zh');
    expect(host.querySelector('.tl-name')?.textContent).toBe('获取窗口状态');
    host.querySelector<HTMLElement>('[aria-expanded="false"]')?.click();
    await nextTick();
    expect([...host.querySelectorAll('.gt-fields dt')].map((n) => n.textContent)).toEqual(['包含文本', '区域']);
  });

  it('merges the group header and hides raw args in the mounted activity run', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const i18n = createKimiI18n({ locale: 'en' });
    setKimiClientDeps({
      t: (key: string, params?: Record<string, unknown>) =>
        params === undefined ? i18n.global.t(key) : i18n.global.t(key, params),
    } as never);
    const items = realCalls.map(({ name, arg }, index) => ({
      kind: 'tool' as const,
      tool: { id: `call_${index}`, name, arg, status: 'ok' } as ToolCall,
    }));
    app = createApp({ setup: () => () => h(ActivityRun, { items, forceOpen: true }) });
    app.use(i18n);
    app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.mount(host);
    await nextTick();
    expect(host.querySelector('.ar-sum')?.textContent).toBe('3 tool calls');
    expect([...host.querySelectorAll('.tl-name')].map((n) => n.textContent)).toEqual(realCalls.map((c) => c.label));
    expect([...host.querySelectorAll('.tl-dim')].map((n) => n.textContent)).toEqual(['com.anysphere.sand']);
    expect(host.textContent).not.toMatch(/[{}"]/);
    vi.unstubAllGlobals();
  });

  it('keeps the activity run open between steps and folds when the run settles', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const i18n = createKimiI18n({ locale: 'en' });
    setKimiClientDeps({
      t: (key: string, params?: Record<string, unknown>) =>
        params === undefined ? i18n.global.t(key) : i18n.global.t(key, params),
    } as never);
    const state = reactive({ live: true, streaming: true });
    const items = realCalls.map(({ name, arg }, index) => ({
      kind: 'tool' as const,
      tool: { id: `call_${index}`, name, arg, status: 'ok' } as ToolCall,
      sourceIndex: index,
    }));
    app = createApp({ setup: () => () => h(ActivityRun, { items, live: state.live, streaming: state.streaming }) });
    app.use(i18n);
    app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.mount(host);
    await nextTick();
    expect(host.querySelector('.ar-head')?.getAttribute('aria-expanded')).toBe('true');

    state.streaming = false;
    await nextTick();
    expect(host.querySelector('.ar-head')?.getAttribute('aria-expanded')).toBe('true');

    state.streaming = true;
    await nextTick();
    expect(host.querySelector('.ar-head')?.getAttribute('aria-expanded')).toBe('true');

    state.live = false;
    state.streaming = false;
    await nextTick();
    expect(host.querySelector('.ar-head')?.getAttribute('aria-expanded')).toBe('false');
    vi.unstubAllGlobals();
  });

  it('renders other MCP tools with the raw name and args', () => {
    mount({ name: 'mcp__other__click', arg: '{"x":1}' }, 'en');
    expect(host.querySelector('.tl-name')?.textContent).toBe('mcp__other__click');
    expect(host.querySelector('.tl-dim')?.textContent).toBe('{"x":1}');
  });
});

describe('Write and Edit streaming rows', () => {
  it.each([
    ['Write', 'content'],
    ['Edit', 'old_string'],
  ])('shows the completed path of %s before later content finishes', (name, field) => {
    const tool = {
      name,
      arg: `{"path":"/Users/moonshot/project/docs/new.md","${field}":"unfinished`,
      status: 'running',
    } as ToolCall;
    mount(tool, 'zh', resolveToolRenderer(tool));
    expect(host.querySelector('.tl-file')?.textContent).toBe('new.md');
    expect(host.querySelector('.tl-lead')?.textContent).not.toContain('/Users/moonshot');
    expect(host.querySelector('.tl-lead')?.textContent).not.toContain('{"path"');
  });

  it('shows only the filename for Read and keeps the full path in its tooltip', async () => {
    const path = '/Users/moonshot/project/docs/new.md';
    const tool = { name: 'Read', arg: JSON.stringify({ path }), status: 'running' } as ToolCall;
    mount(tool, 'zh', resolveToolRenderer(tool));
    await nextTick();
    const button = host.querySelector<HTMLButtonElement>('.tl-file')!;
    expect(button.textContent).toBe('new.md');
    expect(host.querySelector('.tl-lead')?.textContent).not.toContain('/Users/moonshot');
    vi.useFakeTimers();
    try {
      document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      button.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 24, clientY: 18 }));
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      await nextTick();
    }
    expect(document.querySelector('.ui-tip__bubble')?.textContent).toBe(path);
  });
});

describe('FetchURL row', () => {
  it('uses the web fetch renderer and shows the URL host instead of raw JSON', () => {
    const tool = {
      name: 'FetchURL',
      arg: '{"url":"https://api.npmjs.org/downloads/point/last-week/partial-json"}',
      status: 'error',
    } as ToolCall;
    const renderer = resolveToolRenderer(tool);
    expect(renderer).toBe(WebFetchTool);
    mount(tool, 'zh', renderer);
    expect(host.querySelector('.tl-name')?.textContent).toBe('抓取');
    expect(host.querySelector('.tl-lead')?.textContent).toContain('api.npmjs.org/downloads');
    expect(host.querySelector('.tl-lead')?.textContent).not.toContain('{"url"');
  });
});

describe('GrepTool result count', () => {
  it('keeps the trailing count out of the truncatable content', () => {
    mount({
      name: 'Grep',
      arg: JSON.stringify({ pattern: 'tools\\.label\\.(read|write|edit)', path: 'packages/app-i18n/src/locales/zh/tools.ts' }),
      output: Array.from({ length: 51 }, (_, index) => `packages/app-i18n/src/locales/zh/tools.ts:${index + 1}:match`),
    }, 'zh', GrepTool);
    expect(host.querySelector('.tl-lead > .tl-chip')?.textContent).toBe('51 结果');
  });
});
