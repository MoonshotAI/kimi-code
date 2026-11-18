// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { normalizeToolOutput, toolResultText } from '@moonshot-ai/app-core/client';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import BrowserToolDetails from '../src/chat/tool-calls/browser/BrowserToolDetails.vue';
import type { BrowserToolContext } from '../src/chat/tool-calls/browserToolPresentation';
import { browserToolView } from '../src/chat/tool-calls/browserToolView';

const TAB = {
  tabId: 'panel-tab-3', browserId: 'browser-388b', active: true, visible: true, generation: 17,
  url: 'https://www.example.com/explore/6a62a71000000000402a040?xsec_token=AB-KkNPhqrNDHhW8rAUUpScX0uIIS_fkVAA0dWQUtSLhU=&xsec_source=pc_search',
  title: 'Day trip - Example', loading: false, canGoBack: true, canGoForward: false, zoomFactor: 1,
};

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function tool(operation: string, args: Record<string, unknown>, output: string | undefined, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: operation,
    name: 'mcp__desktop_browser__run',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, ...args }),
    status: 'ok',
    output: output?.split('\n'),
    ...extra,
  };
}

function mount(target: ToolCall, context: BrowserToolContext = {}, locale: 'zh' | 'en' = 'zh'): HTMLElement {
  app = createApp({
    render: () => h(BrowserToolDetails, { tool: target, view: browserToolView(target, context), running: target.status === 'running' }),
  });
  app.use(createKimiI18n({ locale }));
  app.mount(host);
  return host;
}

async function toggle(root: HTMLElement, label: string): Promise<void> {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button.bfold-head')].find((item) => item.textContent?.includes(label));
  if (button === undefined) throw new Error(`missing fold ${label}`);
  button.click();
  await nextTick();
}

describe('browser tool details', () => {
  it('shows the action, keeps the full URL and leaves noise behind a fold that still opens', async () => {
    const result = JSON.stringify({ ok: true, operation: 'page.element.click', tab: TAB });
    const target = tool('page.element.click', { tabId: 'panel-tab-3', snapshotId: 'elements-ae18', ref: 'e1' }, result);
    const root = mount(target, { element: 'Nagasaki day trip', previousTab: { ...TAB, url: 'https://www.example.com/search', canGoBack: false } });
    expect(root.textContent).toContain('Nagasaki day trip');
    expect(root.textContent).toContain('e1');
    for (const part of ['https://', 'www.example.com', '/explore/6a62a71000000000402a040', 'xsec_source', 'pc_search', 'xsec_token', '/search']) {
      expect(root.textContent).toContain(part);
    }
    const token = 'AB-KkNPhqrNDHhW8rAUUpScX0uIIS_fkVAA0dWQUtSLhU=';
    expect(root.textContent).not.toContain(token);
    root.querySelector<HTMLButtonElement>('button.burl-toggle')!.click();
    await nextTick();
    expect(root.textContent).toContain(token);
    expect(root.textContent).toContain('可后退');
    expect(root.textContent).not.toContain('可前进');
    expect(root.textContent).not.toContain('browser-388b');
    await toggle(root, '其他字段');
    expect(root.textContent).toContain('tab.browserId');
    expect(root.textContent).toContain('browser-388b');
    expect(root.textContent).toContain('snapshotId');
    expect(root.textContent).toContain('elements-ae18');
    expect(root.textContent).toContain('tab.canGoForward');
  });

  it('decodes a readable URL without dropping any part and leaves odd URLs untouched', () => {
    const url = 'https://user@travel.example.com:8443/search/%E9%95%BF%E5%B4%8E?q=%E4%B8%80%E6%97%A5%E6%B8%B8&flag&plus=a+b#top';
    const root = mount(tool('tab.navigate', { tabId: 'panel-tab-3', url }, undefined, { status: 'running' }));
    for (const part of ['https://', 'user@travel.example.com:8443', '/search/长崎', 'q', '一日游', 'flag', 'plus', 'a+b', '#top']) {
      expect(root.textContent).toContain(part);
    }
    app?.unmount();
    host.replaceChildren();
    const odd = mount(tool('tab.navigate', { tabId: 'panel-tab-3', url: 'about:blank#%E0%A4%A' }, undefined, { status: 'running' }));
    expect(odd.textContent).toContain('about:blank#%E0%A4%A');
  });

  it('always offers the verbatim request and result', async () => {
    const result = JSON.stringify({ ok: true, operation: 'tab.get_state', tab: TAB });
    const target = tool('tab.get_state', { tabId: 'panel-tab-3' }, result);
    const root = mount(target);
    expect(root.textContent).not.toContain(result);
    await toggle(root, '原始数据');
    expect(root.textContent).toContain(target.arg);
    expect(root.textContent).toContain(result);
  });

  it('shows raw data directly when the request cannot be understood', () => {
    const target = { ...tool('tab.get_state', {}, 'plain failure text'), arg: '{"operation":' };
    const root = mount(target);
    expect(root.querySelector('button.bfold-head')).toBeNull();
    expect(root.textContent).toContain('{"operation":');
    expect(root.textContent).toContain('plain failure text');
  });

  it('opens the raw data and says so when the result cannot be parsed', () => {
    const root = mount(tool('tab.get_state', { tabId: 'panel-tab-3' }, 'Tool execution was interrupted'));
    expect(root.textContent).toContain('无法解析结果');
    expect(root.textContent).toContain('Tool execution was interrupted');
  });

  it('renders a TOON visual snapshot followed by its image part and attachment notice as a readable card', async () => {
    const toon = ['ok: true', 'operation: page.visual.snapshot', 'tab:', '  tabId: panel-tab-16', '  title: Nagasaki travel guide', '  url: "https://www.example.com/nagasaki"', 'visual:', '  snapshotId: visual-16', '  mimeType: image/png', '  width: 800', '  height: 600'].join('\n');
    const notice = 'Attachment reference: "kimi-file://f_mcp_abc"\nSession-relative attachment: "media/f_mcp_abc.png"\nMIME: "image/png"; size: 4 bytes';
    const raw = [{ type: 'text', text: toon }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: notice }];
    const target = { ...tool('page.visual.snapshot', { tabId: 'panel-tab-16' }, undefined), output: normalizeToolOutput(raw), resultText: toolResultText(raw) };
    const root = mount(target, {}, 'en');
    expect(root.textContent).not.toContain('could not be parsed');
    expect(root.textContent).toContain('Nagasaki travel guide');
    expect(root.textContent).toContain('example.com');
    await toggle(root, 'Raw data');
    expect(root.textContent).toContain('[image]');
    expect(root.textContent).toContain('kimi-file://f_mcp_abc');
  });

  it('renders every element row without truncating the list', () => {
    const rows = Array.from({ length: 300 }, (_, index) => `    e${index + 1},link,Item ${index + 1},null,null,${index % 2 ? 'offscreen' : 'null'}`);
    const output = ['ok: true', 'operation: page.elements.snapshot', 'elements:', '  snapshotId: s1', `  elements[300]{ref,role,name,text,value,state}:`, ...rows, '  truncated: true', '  total: 300'].join('\n');
    const root = mount(tool('page.elements.snapshot', { tabId: 'panel-tab-3' }, output));
    expect(root.querySelectorAll('tbody tr')).toHaveLength(300);
    expect(root.textContent).toContain('Item 300');
    expect(root.textContent).toContain('屏幕外');
    expect([...root.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['引用', '角色', '名称', '状态']);
  });

  it('renders every text block with its id, kind and continuation markers', () => {
    const output = ['ok: true', 'operation: page.text.snapshot', 'text:', '  snapshotId: t1', '  blocks[2]{id,kind,text,part,continued}:', '    b1,heading,Nagasaki in one day,1,false', '    b2,paragraph,A long paragraph that,2,true', '  truncated: true', '  nextCursor: cursor-2'].join('\n');
    const root = mount(tool('page.text.snapshot', { tabId: 'panel-tab-3' }, output));
    for (const expected of ['b1', 'heading', 'Nagasaki in one day', 'b2', 'paragraph', 'A long paragraph that', '第 2 部分', '未完', 'cursor-2']) {
      expect(root.textContent).toContain(expected);
    }
  });

  it('places marks on the referenced screenshot by percentage', () => {
    const target = tool('page.visual.click', { tabId: 'panel-tab-3', snapshotId: 'v1', x: 200, y: 150 }, JSON.stringify({ ok: true, operation: 'page.visual.click', tab: TAB }));
    const root = mount(target, { shot: { media: { kind: 'image', url: 'data:image/png;base64,AAAA' }, width: 800, height: 600 } });
    const point = root.querySelector<HTMLElement>('.bshot-point');
    expect(point?.style.left).toBe('25%');
    expect(point?.style.top).toBe('25%');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('explains an error while keeping the original code and message', () => {
    const result = JSON.stringify({ ok: false, operation: 'page.element.click', error: { code: 'STALE_ELEMENT', message: 'The element snapshot is stale.' } });
    const root = mount(tool('page.element.click', { tabId: 'panel-tab-3', snapshotId: 's', ref: 'e1' }, result, { status: 'error' }));
    expect(root.textContent).toContain('STALE_ELEMENT');
    expect(root.textContent).toContain('元素快照已失效');
    expect(root.textContent).toContain('The element snapshot is stale.');
  });

  it.each(['zh', 'en'] as const)('has a %s label for everything it renders', async (locale) => {
    const candidate = { ref: 'e1', tagName: 'div', role: 'generic', name: 'Next', id: 'next', classes: ['a'], clickable: true, disabled: false, evidence: 'pointer', bounds: { x: 1, y: 2, width: 3, height: 4 } };
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['page.wait_for', { tabId: 't', condition: { kind: 'element', locator: { role: 'button', name: 'Save', exact: true }, state: 'visible' }, timeoutMs: 1, stableForMs: 1 }, { wait: { matched: true, elapsedMs: 5, evidence: { kind: 'text', value: 'x', count: 1, scanTruncated: false } } }],
      ['page.wait_for', { tabId: 't', condition: { kind: 'text', text: 'x', match: 'contains', state: 'present' } }, { ok: false, error: { code: 'WAIT_TIMEOUT', message: 'm', lastObserved: { kind: 'url', value: 'u', count: 0, scanTruncated: true } } }],
      ['page.wait_for', { tabId: 't', condition: { kind: 'url', value: 'https://a.example', match: 'prefix' } }, {}],
      ['page.visual.click_if_interactive', { tabId: 't', snapshotId: 'v', x: 1, y: 2, radius: 48 }, { tab: TAB, click: { outcome: 'clicked', target: candidate, nearby: [candidate], elementsSnapshotId: 'n', radius: 48, coordinateSpace: 'image', truncated: false, needsVisualConfirmation: false, message: 'ok' } }],
      ['page.visual.click', { tabId: 't', snapshotId: 'v', x: 1, y: 2, button: 'left', clickCount: 2 }, { tab: TAB }],
      ['page.element.click', { tabId: 't', snapshotId: 's', ref: 'e1' }, { tab: TAB, receipt: 'r-0123456789ab' }],
      ['page.visual.scroll', { tabId: 't', snapshotId: 'v', x: 1, y: 2, deltaX: 0, deltaY: 10 }, { tab: TAB }],
      ['page.visual.drag', { tabId: 't', snapshotId: 'v', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, { tab: TAB }],
      ['page.visual.type_text', { tabId: 't', text: 'x', replace: true }, { tab: TAB }],
      ['page.visual.press_key', { tabId: 't', keys: ['Enter'] }, { tab: TAB }],
      ['page.visual.snapshot', { tabId: 't' }, { tab: TAB, visual: { snapshotId: 'v', mimeType: 'image/png', cropAvailable: true, width: 10, height: 20, deviceScaleFactor: 2, viewport: { width: 5, height: 10 } } }],
      ['page.visual.crop', { tabId: 't', snapshotId: 'v', region: { x: 1, y: 2, width: 3, height: 4 } }, { crop: { sourceSnapshotId: 'v', capturedAt: 1, region: { x: 1, y: 2, width: 3, height: 4 }, mimeType: 'image/png', width: 6, height: 8 } }],
      ['page.element.select_option', { tabId: 't', snapshotId: 's', ref: 'e1', value: 'v' }, { tab: TAB }],
      ['page.element.select_option', { tabId: 't', snapshotId: 's', ref: 'e1', label: 'l' }, { tab: TAB }],
      ['page.element.select_option', { tabId: 't', snapshotId: 's', ref: 'e1', index: 1 }, { tab: TAB }],
      ['page.element.set_checked', { tabId: 't', snapshotId: 's', ref: 'e1', checked: true }, { tab: TAB }],
      ['page.text.snapshot', { tabId: 't', scope: { kind: 'element', snapshotId: 's', ref: 'e1' }, cursor: 'c' }, { text: { snapshotId: 'x', source: 'dom', scope: 'element', capturedAt: 1, blocks: [{ id: 'b1', kind: 'paragraph', text: 'x', part: 1, continued: false }], scanTruncated: false, truncated: false, nextCursor: 'c2', maxChars: 1 } }],
      ['page.elements.snapshot', { tabId: 't', scope: 'viewport', filter: { role: 'link', text: 'x' } }, { elements: { snapshotId: 'x', elements: [{ ref: 'e1', role: 'link', name: 'n', text: 't', value: 'v', disabled: true, checked: false, selected: true, expanded: false, inViewport: false, bounds: { x: 1, y: 2, width: 3, height: 4 } }], truncated: false, scanTruncated: false, scope: 'viewport', total: 1, nextCursor: 'c' } }],
      ['tab.wait_for_load', { tabId: 't', state: 'complete', timeoutMs: 1 }, { tab: TAB }],
      ['tab.set_device_mode', { tabId: 't', device: { enabled: true, orientation: 'portrait', profileId: 'pixel-7', scaleMode: 'fit' } }, { tab: TAB }],
      ['browser.create_tab', { url: 'https://a.example' }, { tab: TAB, browser: { available: true, panelVisible: true, activeTabId: 'a', visibleTabId: 'b', tabs: [TAB] } }],
      ['browser.get_history', {}, { history: [{ id: 'h', url: 'u', title: 't', visitedAt: 1 }] }],
      ['browser.get_downloads', {}, { downloads: [{ id: 'd', url: 'u', filename: 'f', savePath: '/p', state: 'completed', startedAt: 1, receivedBytes: 2048, totalBytes: 4096 }] }],
      ['browser.get_device_profiles', {}, { deviceProfiles: [{ profileId: 'p', width: 1, height: 2, deviceScaleFactor: 2, mobile: true, touch: true, orientation: 'portrait' }] }],
    ];
    const shot = { media: { kind: 'image' as const, url: 'data:image/png;base64,AAAA' }, width: 800, height: 600 };
    for (const [operation, args, body] of cases) {
      const root = mount(tool(operation, args, JSON.stringify({ ok: true, operation, ...body }), { media: shot.media }), { element: 'Target', page: 'Page', previousTab: { ...TAB, title: 'Old', url: 'https://old.example/', loading: true }, shot }, locale);
      await toggle(root, locale === 'zh' ? '其他字段' : 'Other fields');
      await toggle(root, locale === 'zh' ? '原始数据' : 'Raw data');
      expect(root.textContent, operation).not.toMatch(/tools\.[a-zA-Z.]+/);
      app?.unmount();
      app = null;
      host.replaceChildren();
    }
  });
});
