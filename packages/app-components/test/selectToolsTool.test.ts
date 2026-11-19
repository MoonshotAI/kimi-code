// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import SelectToolsTool from '../src/chat/tool-calls/SelectToolsTool.vue';
import { parseSelectToolsNames, parseSelectToolsResult } from '../src/chat/tool-calls/selectToolsTool';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
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

function tool(over: Partial<ToolCall> = {}, names = ['mcp__demo__alpha']): ToolCall {
  return {
    id: 'select-1',
    name: 'select_tools',
    arg: JSON.stringify({ names }),
    status: 'ok',
    ...over,
  };
}

function mount(target: ToolCall, locale: 'en' | 'zh' = 'en', history = new Map<string, unknown>()): HTMLElement {
  app = createApp({ render: () => h(SelectToolsTool, { tool: target }) });
  app.use(createKimiI18n({ locale }));
  app.provide(HistoryStateKey, history);
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return host;
}

function headline(root: HTMLElement): string {
  return ['.tl-name', '.sts-requested']
    .map((selector) => root.querySelector(selector)?.textContent?.trim() ?? '')
    .filter((text) => text.length > 0)
    .join(' ');
}

async function expand(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('button.tl-car')!.click();
  await nextTick();
}

describe('select_tools result parsing', () => {
  it('accepts only a nonempty array of nonempty tool names', () => {
    expect(parseSelectToolsNames('{"names":["alpha","beta"]}')).toEqual(['alpha', 'beta']);
    expect(parseSelectToolsNames('{"names":[]}')).toEqual([]);
    expect(parseSelectToolsNames('{"names":["alpha",2]}')).toEqual([]);
    expect(parseSelectToolsNames('{"names":["alp')).toEqual([]);
  });

  it('separates recognized names from lines that add explanation', () => {
    const result = parseSelectToolsResult([
      'Loaded: alpha, beta',
      'Already available: gamma',
      'Unknown tool: missing.tool. This name is not loadable. Did you mean: alpha?',
      '"select_tools" is already available — call it directly',
      '"stale" was previously selected or loaded',
      '"denied" is disabled by the current tool policy',
    ].join('\n'));
    expect(result.loaded).toEqual(['alpha', 'beta']);
    expect(result.alreadyAvailable).toEqual(['gamma']);
    expect(result.unknown).toEqual(['missing.tool']);
    expect(result.notes).toEqual([
      'Unknown tool: missing.tool. This name is not loadable. Did you mean: alpha?',
      '"select_tools" is already available — call it directly',
      '"stale" was previously selected or loaded',
      '"denied" is disabled by the current tool policy',
    ]);
  });
});

describe('SelectToolsTool', () => {
  it('shows only loading and requested names while running, ignoring projected result text', () => {
    const root = mount(tool({
      status: 'running',
      resultText: 'Loaded: must_not_be_claimed',
      output: ['Loaded: must_not_be_claimed'],
    }, ['alpha', 'beta']));
    expect(headline(root)).toBe('Loading 2 tools… alpha, beta');
    expect(root.textContent).not.toContain('must_not_be_claimed');
    expect(root.textContent).not.toContain('Loaded 2 tools');
  });

  it('uses the generic loading copy while arguments are incomplete', () => {
    const root = mount(tool({ status: 'running', arg: '{"names":["alp' }));
    expect(headline(root)).toBe('Loading tools…');
  });

  it('makes no result claim for forced ok without resultText', () => {
    const root = mount(tool({ status: 'ok', output: ['Loaded: output_only'] }));
    expect(headline(root)).toBe('Select tools');
  });

  it.each([
    ['alpha', 'Loaded 1 tool'],
    ['alpha, beta', 'Loaded 2 tools'],
  ])('titles a fully loaded call and expands to one row from %s', async (loaded, expected) => {
    const root = mount(tool({ resultText: `Loaded: ${loaded}` }, loaded.split(', ').reverse()));
    expect(headline(root)).toBe(expected);
    expect(root.textContent).not.toContain('Select tools');
    await expand(root);
    expect([...root.querySelectorAll('.sts-fields dt')].map((el) => el.textContent)).toEqual(['Loaded']);
    expect(root.querySelector('.sts-fields dd.mono')?.textContent).toBe(loaded.split(', ').join('\n'));
    expect(root.querySelector('.sts-raw')).toBeNull();
  });

  it('keeps the requested row when a partial load differs from the request', async () => {
    const root = mount(tool({ resultText: 'Loaded: alpha' }, ['alpha', 'beta']));
    expect(headline(root)).toBe('Loaded 1 tool');
    await expand(root);
    expect([...root.querySelectorAll('.sts-fields dt')].map((el) => el.textContent)).toEqual([
      'Requested tools', 'Loaded',
    ]);
    expect(root.querySelector('.sts-raw')).toBeNull();
  });

  it.each([
    ['an unknown tool suggestion', 'Unknown tool: missing. Did you mean: alpha?'],
    ['a policy-disabled tool', '"denied" is disabled by the current tool policy'],
  ])('keeps the explanation for %s in a mixed result without restating rows', async (_, explanation) => {
    const root = mount(tool({
      resultText: `Loaded: alpha\nAlready available: beta\n${explanation}`,
    }, ['alpha', 'beta', 'missing']));
    await expand(root);
    expect(root.querySelector('.sts-raw')?.textContent).toContain(explanation);
    expect(root.querySelector('.sts-raw')?.textContent).not.toContain('Loaded:');
    expect(root.querySelector('.sts-raw')?.textContent).not.toContain('Already available:');
  });

  it('does not count already-available tools as newly loaded', () => {
    const root = mount(tool({ resultText: 'Already available: alpha, beta' }));
    expect(root.querySelector('.tl-name')?.textContent).toBe('2 tools already available');
    expect(root.querySelector('.tl-name')?.textContent).not.toContain('Loaded');
  });

  it('reports unknown-only errors without calling them loaded or a generic success', () => {
    const root = mount(tool({
      status: 'error',
      resultText: 'Unknown tool: missing. This name is not loadable. Did you mean: alpha? Use an exact listed name.\nUnknown tool: absent. This name is not loadable.',
    }));
    expect(root.querySelector('.tl-name')?.textContent).toBe('2 unknown tools');
    expect(root.querySelector('.tool-line')?.classList.contains('err')).toBe(true);
    expect(root.querySelector('.tl-name')?.textContent).not.toContain('Loaded');
  });

  it('combines loaded, already-available, and unknown counts in mixed results', () => {
    const root = mount(tool({
      resultText: 'Loaded: alpha\nAlready available: beta\nUnknown tool: missing. This name is not loadable.',
    }));
    expect(root.querySelector('.tl-name')?.textContent).toBe(
      'Loaded 1 tool · 1 tool already available · 1 unknown tool',
    );
  });

  it.each(['', ' \n'])('shows no result for empty output without a Loaded 0 claim', (resultText) => {
    const root = mount(tool({ resultText }));
    expect(root.querySelector('.tl-name')?.textContent).toBe('No result');
    expect(root.textContent).not.toContain('Loaded 0');
  });

  it('keeps failures and their raw output honest', async () => {
    const root = mount(tool({ status: 'error', output: ['Tool execution failed'] }));
    expect(root.querySelector('.tl-name')?.textContent).toBe('Couldn’t load tools');
    await expand(root);
    expect(root.querySelector('.sts-raw')?.textContent).toBe('Tool execution failed');
  });

  it('uses the generic fallback for unrecognized output and preserves raw details', async () => {
    const root = mount(tool({ resultText: 'select_tools is not available for the current model.' }));
    expect(headline(root)).toBe('Select tools');
    await expand(root);
    expect(root.querySelector('.sts-raw')?.textContent).toContain('not available for the current model');
  });

  it('retains policy, stale, escalation, and suggestion text in raw details on error', async () => {
    const raw = [
      'Loaded: alpha',
      '"select_tools" is already available — call it directly',
      '"stale" was previously selected or loaded but is no longer registered',
      '"denied" is disabled by the current tool policy',
      'Unknown tool: missing. Did you mean: alpha? Use an exact listed name.',
      '"missing" has already failed selection 2 times',
      '3 consecutive select_tools calls failed without making any tool available',
    ].join('\n');
    const root = mount(tool({ status: 'error', resultText: raw }));
    await expand(root);
    for (const text of ['already available — call it directly', 'no longer registered', 'disabled by the current tool policy', 'Did you mean: alpha?', 'failed selection 2 times', '3 consecutive select_tools calls']) {
      expect(root.querySelector('.sts-raw')?.textContent).toContain(text);
    }
  });

  it('expands structured details without raw text and saves collapsed state in history', async () => {
    const history = new Map<string, unknown>();
    const root = mount(tool({
      resultText: 'Loaded: alpha\nAlready available: beta\nUnknown tool: missing.',
    }, ['alpha', 'beta', 'missing']), 'en', history);
    const line = root.querySelector('.tool-line')!;
    expect(line.classList.contains('open')).toBe(false);
    await expand(root);
    expect(line.classList.contains('open')).toBe(true);
    expect(history.get('tool:select-1:open')).toBe(true);
    expect([...root.querySelectorAll('.sts-fields dt')].map((el) => el.textContent)).toEqual([
      'Requested tools', 'Loaded', 'Already available', 'Unknown tools',
    ]);
    expect([...root.querySelectorAll('.sts-fields dd.mono')].map((el) => el.textContent)).toEqual([
      'alpha\nbeta\nmissing', 'alpha', 'beta', 'missing',
    ]);
    expect(root.querySelector('.sts-raw')).toBeNull();
    root.querySelector<HTMLButtonElement>('button.tl-car')!.click();
    await nextTick();
    expect(line.classList.contains('open')).toBe(false);
    expect(history.get('tool:select-1:open')).toBe(false);
  });

  it('restores an expanded call from history', () => {
    const history = new Map<string, unknown>([['tool:select-1:open', true]]);
    const root = mount(tool({ resultText: 'Loaded: alpha' }, ['alpha']), 'en', history);
    expect(root.querySelector('.tool-line')?.classList.contains('open')).toBe(true);
    expect(root.querySelector('.sts-fields dd.mono')?.textContent).toBe('alpha');
  });

  it('reacts to completion without parsing results before completion', async () => {
    const target = reactive(tool({ status: 'running', resultText: 'Loaded: alpha' }));
    const root = mount(target);
    expect(root.querySelector('.tl-name')?.textContent).toBe('Loading 1 tool…');
    target.status = 'ok';
    await nextTick();
    expect(root.querySelector('.tl-name')?.textContent).toBe('Loaded 1 tool');
  });

  it('renders Chinese loading, mixed, empty, failure, and detail copy', async () => {
    const target = reactive(tool({ status: 'running' }, ['alpha', 'beta']));
    const root = mount(target, 'zh');
    expect(root.querySelector('.tl-name')?.textContent).toBe('正在加载 2 个工具…');
    target.status = 'ok';
    target.resultText = 'Loaded: alpha\nAlready available: beta\nUnknown tool: missing. Not loadable.';
    await nextTick();
    expect(root.querySelector('.tl-name')?.textContent).toBe('已加载 1 个工具 · 1 个工具已可用 · 1 个未知工具');
    await expand(root);
    expect([...root.querySelectorAll('.sts-fields dt')].map((el) => el.textContent)).toEqual([
      '请求的工具', '已加载', '已可用', '未知工具',
    ]);
    expect(root.textContent).not.toContain('选择工具');
    target.resultText = '';
    await nextTick();
    expect(root.querySelector('.tl-name')?.textContent).toBe('暂无结果');
    target.status = 'error';
    target.resultText = 'failure';
    await nextTick();
    expect(root.querySelector('.tl-name')?.textContent).toBe('工具加载失败');
  });

  it('uses Chinese generic loading copy without a count', () => {
    const root = mount(tool({ status: 'running', arg: '' }), 'zh');
    expect(root.querySelector('.tl-name')?.textContent).toBe('正在加载工具…');
  });
});
