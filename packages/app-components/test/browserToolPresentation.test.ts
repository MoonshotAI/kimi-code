import { describe, expect, it } from 'vitest';
import { encode } from '@toon-format/toon';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import zh from '../../app-i18n/src/locales/zh/tools';
import en from '../../app-i18n/src/locales/en/tools';
import { getIcon, type IconName } from '@moonshot-ai/app-ui/icons';
import {
  browserToolContexts,
  browserApprovalPresentation,
  browserToolData,
  browserToolGlyph,
  browserToolReceipt,
  browserToolPresentation,
  isBrowserTool,
} from '../src/chat/tool-calls/browserToolPresentation';

function translate(locale = zh) {
  return (key: string, params: Record<string, string | number> = {}) => {
    let value: unknown = { tools: locale };
    for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
    if (typeof value !== 'string') throw new Error(`Missing translation: ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));
  };
}

function tool(operation: string, args: Record<string, unknown> = {}, result?: unknown): ToolCall {
  return {
    id: operation,
    name: 'mcp__desktop_browser__run',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, tabId: 'tab-1', ...args }),
    status: 'ok',
    output: result === undefined ? undefined : [JSON.stringify(result)],
  };
}

function turn(tools: ToolCall[], sessionId = 'session-1'): ChatTurn {
  return { id: 'turn-1', sessionId, role: 'assistant', no: 1, text: '', tools };
}

function snapshot(name = 'Search', args: Record<string, unknown> = {}): ToolCall {
  return tool('page.elements.snapshot', args, {
    ok: true,
    tab: { tabId: 'tab-1', title: 'Google' },
    elements: { snapshotId: 'snapshot-1', elements: [{ ref: 'e12', name, role: 'combobox' }] },
  });
}

describe('browser tool presentation', () => {
  it('recognizes only the desktop browser MCP tool', () => {
    expect(isBrowserTool({ name: 'mcp__desktop_browser__run' })).toBe(true);
    expect(isBrowserTool({ name: 'mcp__another_browser__run' })).toBe(false);
    expect(isBrowserTool({ name: 'run' })).toBe(false);
  });

  it('recovers an element name from an earlier snapshot across turns', () => {
    const input = tool('page.element.type_text', { snapshotId: 'snapshot-1', ref: 'e12', text: 'Kimi Code' });
    const contexts = browserToolContexts([turn([snapshot()]), turn([input])]);
    expect(contexts.get(input)).toMatchObject({ element: 'Search', page: 'Google' });
    expect(browserToolPresentation(input, contexts.get(input)!, translate())).toEqual({
      label: '已输入', detail: '“Kimi Code” · Search', status: 'ok',
    });
  });

  it('keeps references scoped to their session, agent, tab and snapshot', () => {
    const args = { snapshotId: 'snapshot-1', ref: 'e12' };
    const anotherSession = tool('page.element.click', args);
    const anotherAgent = { ...tool('page.element.click', args), agentId: 'child' };
    const anotherTab = tool('page.element.click', { ...args, tabId: 'tab-2' });
    const anotherSnapshot = tool('page.element.click', { ...args, snapshotId: 'snapshot-2' });
    const contexts = browserToolContexts([
      turn([snapshot(), anotherAgent, anotherTab, anotherSnapshot]),
      turn([anotherSession], 'session-2'),
    ]);
    for (const action of [anotherSession, anotherAgent, anotherTab, anotherSnapshot]) {
      expect(contexts.get(action)?.element).toBeUndefined();
    }
  });

  it('does not resolve an earlier action from a later snapshot', () => {
    const click = tool('page.element.click', { snapshotId: 'snapshot-1', ref: 'e12' });
    const context = browserToolContexts([turn([click, snapshot()])]).get(click)!;
    expect(browserToolPresentation(click, context, translate()).detail).toBe('页面元素');
  });

  it('uses ordered blocks and ignores unsuccessful snapshots', () => {
    const failed = { ...snapshot(), status: 'error' as const };
    const click = tool('page.element.click', { snapshotId: 'snapshot-1', ref: 'e12' });
    const t = { ...turn([snapshot()]), blocks: [{ kind: 'tool' as const, tool: failed }, { kind: 'tool' as const, tool: click }] };
    expect(browserToolContexts([t]).get(click)?.element).toBeUndefined();
  });

  it('preserves the historical target name after a later snapshot changes it', () => {
    const first = tool('page.element.click', { snapshotId: 'snapshot-1', ref: 'e12' });
    const second = tool('page.element.click', { snapshotId: 'snapshot-1', ref: 'e12' });
    const contexts = browserToolContexts([turn([snapshot('Search'), first, snapshot('Submit'), second])]);
    expect(contexts.get(first)?.element).toBe('Search');
    expect(contexts.get(second)?.element).toBe('Submit');
  });

  it('renders key combinations and distinguishes a failed operation from success', () => {
    const press = tool('page.element.press_key', { keys: ['Control', 'Enter'] }, { ok: false });
    expect(browserToolPresentation(press, { element: 'Search' }, translate())).toEqual({
      label: '按键失败', detail: 'Control + Enter · Search', status: 'error',
    });
    press.status = 'running';
    press.output = undefined;
    expect(browserToolPresentation(press, {}, translate()).label).toBe('正在按键');
  });

  it('shows a lower bound when the element snapshot is truncated', () => {
    const inspected = tool('page.elements.snapshot', {}, { ok: true, elements: { elements: [{}, {}], truncated: true } });
    expect(browserToolPresentation(inspected, {}, translate()).detail).toBe('至少 2 个元素');
  });

  it('distinguishes checkbox states, double clicks, coordinates and scroll directions', () => {
    expect(browserToolPresentation(tool('page.element.set_checked', { checked: false }), {}, translate()).label).toBe('已取消勾选');
    expect(browserToolPresentation(tool('page.visual.click', { x: 45, y: 90, clickCount: 2 }), {}, translate())).toMatchObject({ label: '已双击', detail: '(45, 90)' });
    expect(browserToolPresentation(tool('page.visual.scroll', { deltaX: 0, deltaY: -400 }), {}, translate()).detail).toBe('向上');
  });

  it('handles partial arguments and unknown operations without showing raw JSON in the summary', () => {
    const partial = { ...tool('page.element.fill'), arg: '{"operation":' };
    expect(browserToolPresentation(partial, {}, translate()).label).toBe('浏览器操作已完成');
    expect(browserToolPresentation(tool('__proto__'), {}, translate()).label).toBe('浏览器操作已完成');
    expect(browserToolPresentation(tool('page.element.click', { protocol: 'other' }), {}, translate()).label).toBe('浏览器操作已完成');
  });

  it('provides matching translations for each operation state', () => {
    expect(Object.keys(en.browser.actions)).toEqual(Object.keys(zh.browser.actions));
    for (const locale of [zh, en]) {
      for (const action of Object.values(locale.browser.actions)) {
        expect(Object.keys(action)).toEqual(['approval', 'running', 'ok', 'error']);
        expect(Object.values(action).every(Boolean)).toBe(true);
      }
    }
  });
});

it('distinguishes visible tab switching from taking control in both locales', () => {
  expect(browserToolPresentation(tool('browser.switch_tab'), { page: 'Example' }, translate()).label).toBe('已切换标签页');
  expect(browserToolPresentation(tool('browser.switch_tab'), { page: 'Example' }, translate(en)).label).toBe('Switched tab');
});


describe('browser approval presentation', () => {
  it.each([zh, en])('provides approval wording for every browser action in both languages', locale => {
    for (const action of Object.values(locale.browser.actions)) {
      expect(action.approval).toBeTruthy();
      expect(action.approval).not.toBe(action.running);
    }
  });

  it('shows a prospective action and the complete destination URL', () => {
    const input = { protocol: 'kimi.browser/1.0.0', operation: 'tab.navigate', url: 'https://example.com/settings?tab=privacy' };
    expect(browserApprovalPresentation(input, translate(zh))).toMatchObject({ label: '打开页面', detail: input.url });
    expect(browserApprovalPresentation(input, translate(en))).toMatchObject({ label: 'Open page', detail: input.url });
  });

  it('shows the search text for tab.search and create_tab with a query', () => {
    for (const operation of ['tab.search', 'browser.create_tab']) {
      const input = { protocol: 'kimi.browser/1.0.0', operation, query: 'biomap company' };
      expect(browserApprovalPresentation(input, translate(en))).toMatchObject({ label: 'Search the web', detail: 'biomap company' });
      expect(browserApprovalPresentation(input, translate(zh))).toMatchObject({ label: '搜索网页', detail: 'biomap company' });
    }
    const searched = tool('tab.search', { query: 'biomap company' }, { ok: true, operation: 'tab.search', search: { engine: 'bing' }, tab: { tabId: 'tab-1', url: 'https://www.bing.com/search?q=biomap+company' } });
    expect(browserToolPresentation(searched, {}, translate(en))).toMatchObject({ label: 'Searched', detail: 'biomap company' });
  });

  it('shows the exact query that will be sent before approval', () => {
    const query = `  first line\n  secret   ${'x'.repeat(200)} tail  `;
    const input = { protocol: 'kimi.browser/1.0.0', operation: 'tab.search', tabId: 'tab-1', query };
    expect(browserApprovalPresentation(input, translate(en)).detail).toBe(query.trim());
    expect(browserApprovalPresentation({ ...input, operation: 'browser.create_tab' }, translate(zh)).detail).toBe(query.trim());
    const running = { ...tool('tab.search', { query }), status: 'running' as const };
    expect(browserToolPresentation(running, {}, translate(en)).detail).toHaveLength(160);
  });

  it('distinguishes right clicks and unchecked state before approval', () => {
    expect(browserApprovalPresentation({ protocol: 'kimi.browser/1.0.0', operation: 'page.visual.click', button: 'right', x: 20, y: 30 }, translate(en)))
      .toMatchObject({ label: 'Right-click page element', detail: '(20, 30)' });
    expect(browserApprovalPresentation({ protocol: 'kimi.browser/1.0.0', operation: 'page.element.set_checked', checked: false }, translate(zh)))
      .toMatchObject({ label: '取消勾选选项' });
  });

  it('uses a localized browser label when operation data is unavailable', () => {
    expect(browserApprovalPresentation({}, translate(zh)).label).toBe('使用浏览器');
    expect(browserApprovalPresentation({}, translate(en)).label).toBe('Use browser');
  });
});

it.each([zh, en])('does not present a guarded-click miss as a successful click', locale => {
  const missed = tool('page.visual.click_if_interactive', { x: 30, y: 40 }, { ok: true, click: { outcome: 'no_target', nearby: [{ ref: 'e1', name: 'Save' }] } });
  const presentation = browserToolPresentation(missed, {}, translate(locale));
  expect(presentation.label).toBe(locale.browser.noClickTarget);
  expect(browserApprovalPresentation({ protocol: 'kimi.browser/1.0.0', operation: 'page.visual.click_if_interactive', x: 30, y: 40 }, translate(locale)).label).toBe(locale.browser.actions.guardedClick.approval);
});

it('carries nearby candidate names into the subsequent refined click', () => {
  const missed = tool('page.visual.click_if_interactive', {}, { ok: true, click: { outcome: 'no_target', elementsSnapshotId: 'nearby-1', nearby: [{ ref: 'e1', name: 'Save' }] } });
  const refined = tool('page.element.click', { snapshotId: 'nearby-1', ref: 'e1' });
  expect(browserToolContexts([turn([missed, refined])]).get(refined)?.element).toBe('Save');
});

it('preserves element context from bounded TOON snapshots', () => {
  const observed = tool('page.elements.snapshot');
  observed.output = ['ok: true\noperation: page.elements.snapshot\nelements:\n  snapshotId: elements-toon\n  elements[1]{ref,role,name,text,value,state}:\n    e1,link,新闻,null,null,null'];
  const clicked = tool('page.element.click', { snapshotId: 'elements-toon', ref: 'e1' });
  expect(browserToolContexts([turn([observed, clicked])]).get(clicked)?.element).toBe('新闻');
});

it('parses a long TOON history result', () => {
  const history = Array.from({ length: 200 }, (_, index) => ({ url: `https://example.com/${index}/${'a'.repeat(200)}`, title: `Page ${index}`, visitedAt: index }));
  const result = tool('browser.get_history');
  result.output = [encode({ ok: true, operation: 'browser.get_history', history })];
  expect(result.output[0]!.length).toBeGreaterThan(30000);
  expect(browserToolData(result).result?.history).toHaveLength(200);
});

describe('browser tool parsing cache', () => {
  it('reuses the parsed result for an unchanged tool, even when the turn projection recreates the object', () => {
    const first = snapshot();
    const parsed = browserToolData(first);
    expect(browserToolData(first)).toBe(parsed);
    expect(browserToolData({ ...first, output: [...first.output!] })).toBe(parsed);
  });

  it('parses again when the arguments or the output change, including in-place updates', () => {
    const running: ToolCall = { ...tool('tab.reload'), status: 'running' };
    expect(browserToolData(running).result).toBeUndefined();
    running.output = [JSON.stringify({ ok: true, operation: 'tab.reload', tab: { tabId: 'tab-1', title: 'Reloaded' } })];
    expect(browserToolData(running).result).toMatchObject({ tab: { title: 'Reloaded' } });
    const changed = { ...running, arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation: 'tab.go_back', tabId: 'tab-1' }) };
    expect(browserToolData(changed).args?.operation).toBe('tab.go_back');
  });
});

it('keeps the browser detail labels identical across locales', () => {
  const keys = (value: unknown, prefix = ''): string[] => value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => keys(item, `${prefix}${key}.`))
    : [prefix];
  expect(keys(en.browser.detail)).toEqual(keys(zh.browser.detail));
});

describe('browser tool glyph', () => {
  it('gives each kind of action its own registered icon', () => {
    const icons: Array<[ToolCall, string]> = [
      [tool('page.element.click'), 'pointer'],
      [tool('page.visual.click_if_interactive'), 'pointer'],
      [tool('page.element.fill'), 'pencil'],
      [tool('page.visual.type_text'), 'pencil'],
      [tool('page.visual.press_key'), 'key-command'],
      [tool('page.text.snapshot'), 'file-text'],
      [tool('page.elements.snapshot'), 'tree-view'],
      [tool('page.visual.snapshot'), 'screenshot'],
      [tool('page.visual.crop'), 'zoom-scan'],
      [tool('tab.navigate'), 'globe'],
      [tool('tab.search', { query: 'biomap' }), 'search'],
      [tool('browser.create_tab', { query: 'biomap' }), 'search'],
      [tool('tab.go_back'), 'arrow-left'],
      [tool('tab.go_forward'), 'arrow-right'],
      [tool('tab.reload'), 'refresh'],
      [tool('page.wait_for'), 'clock'],
      [tool('page.visual.scroll', { deltaX: 0, deltaY: -40 }), 'arrow-up'],
      [tool('page.visual.scroll', { deltaX: 90, deltaY: 10 }), 'arrow-right'],
      [tool('page.visual.drag'), 'hand'],
      [tool('browser.get_downloads'), 'download'],
      [tool('__proto__'), 'browser'],
    ];
    for (const [item, icon] of icons) {
      expect(browserToolGlyph(item).icon, item.id).toBe(icon);
      expect(getIcon(icon as IconName), icon).toBeDefined();
    }
  });

  it('quiets bookkeeping steps only once they have succeeded', () => {
    for (const operation of ['browser.get_state', 'browser.activate_panel', 'browser.activate_tab', 'browser.release_tab', 'tab.get_state', 'tab.wait_for_load', 'page.element.scroll_into_view', 'browser.get_device_profiles']) {
      expect(browserToolGlyph(tool(operation)).quiet, operation).toBe(true);
    }
    expect(browserToolGlyph({ ...tool('tab.wait_for_load'), status: 'running' }).quiet).toBe(false);
    expect(browserToolGlyph(tool('tab.wait_for_load', {}, { ok: false })).quiet).toBe(false);
    expect(browserToolGlyph({ ...tool('browser.get_state'), status: 'error' }).quiet).toBe(false);
    expect(browserToolGlyph(tool('page.element.click')).quiet).toBe(false);
    expect(browserToolGlyph(tool('tab.navigate')).quiet).toBe(false);
  });
});

describe('browser tool receipts', () => {
  it('finds a well-formed receipt id and the session it belongs to', () => {
    const clicked = tool('page.element.click', { snapshotId: 's', ref: 'e1' }, { ok: false, receipt: 'r-0123456789ab', error: { code: 'STALE_ELEMENT', message: 'x' } });
    expect(browserToolReceipt(clicked)).toBe('r-0123456789ab');
    expect(browserToolContexts([turn([clicked], 'session-9')]).get(clicked)?.sessionId).toBe('session-9');
    for (const receipt of [undefined, 42, '', 'r-0123', '../r-0123456789ab', 'R-0123456789AB']) {
      expect(browserToolReceipt(tool('page.element.click', {}, { ok: true, receipt })), String(receipt)).toBeUndefined();
    }
    expect(browserToolReceipt(tool('page.element.click'))).toBeUndefined();
  });
});
