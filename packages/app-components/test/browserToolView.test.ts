import { encode } from '@toon-format/toon';
import { describe, expect, it } from 'vitest';
import { normalizeToolOutput, toolResultText } from '@moonshot-ai/app-core/client';
import type { ChatTurn, ToolCall, ToolMedia } from '@moonshot-ai/app-core/client/types';
import { browserToolContexts } from '../src/chat/tool-calls/browserToolPresentation';
import {
  browserToolView,
  type BrowserSection,
  type BrowserToolView,
} from '../src/chat/tool-calls/browserToolView';

const TAB = {
  tabId: 'panel-tab-3',
  browserId: 'browser-388b5752',
  active: true,
  visible: true,
  generation: 17,
  url: 'https://www.example.com/explore/6a62?token=AB-Kk&source=pc_search',
  title: 'Day trip - Example',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoomFactor: 1,
};

const SHOT_MEDIA: ToolMedia = {
  kind: 'image',
  url: 'http://daemon/sessions/session-1/media/f_mcp_abc',
  fileId: 'f_mcp_abc',
  sessionId: 'session-1',
  mimeType: 'image/png',
};

function tool(
  operation: string,
  args: Record<string, unknown> = {},
  result?: unknown,
  extra: Partial<ToolCall> = {},
): ToolCall {
  return {
    id: `${operation}-${Math.random()}`,
    name: 'mcp__desktop_browser__run',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, ...args }),
    status: 'ok',
    ...toolOutput(result === undefined || typeof result === 'string' || Array.isArray(result) ? result : JSON.stringify(result)),
    ...extra,
  };
}

function toolOutput(raw: unknown): Pick<ToolCall, 'output' | 'resultText'> {
  return { output: normalizeToolOutput(raw), resultText: toolResultText(raw) };
}

function turn(tools: ToolCall[], sessionId = 'session-1'): ChatTurn {
  return { id: `turn-${Math.random()}`, sessionId, role: 'assistant', no: 1, text: '', tools };
}

function viewOf(target: ToolCall, before: ToolCall[] = []): BrowserToolView {
  const contexts = browserToolContexts([turn([...before, target])]);
  const view = browserToolView(target, contexts.get(target) ?? {});
  if (view === undefined) throw new Error('expected a view');
  return view;
}

function section<K extends BrowserSection['kind']>(view: BrowserToolView, kind: K): Extract<BrowserSection, { kind: K }> {
  const found = view.sections.find((item) => item.kind === kind);
  if (found === undefined) throw new Error(`missing section ${kind}`);
  return found as Extract<BrowserSection, { kind: K }>;
}

function leaves(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) leaves(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) leaves(item, out);
  else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  return out;
}

function expectNothingLost(target: ToolCall, view: BrowserToolView, result: unknown): void {
  const shown = new Map<string, number>();
  for (const value of leaves(view)) shown.set(value, (shown.get(value) ?? 0) + 1);
  const lost: string[] = [];
  for (const value of [...leaves(JSON.parse(target.arg)), ...leaves(result)]) {
    const left = shown.get(value) ?? 0;
    if (left === 0) lost.push(value);
    else shown.set(value, left - 1);
  }
  expect(lost).toEqual([]);
}

const ELEMENTS_TOON = [
  'ok: true',
  'operation: page.elements.snapshot',
  'elements:',
  '  snapshotId: elements-ae18',
  '  elements[2]{ref,role,name,text,value,state}:',
  '    e1,link,Nagasaki day trip,null,null,offscreen',
  '    e2,checkbox,Remember me,Keep me signed in,on,checked disabled',
  '  scope: document',
  '  scanTruncated: false',
  '  truncated: false',
  '  total: 2',
  '  nextCursor: null',
  '  maxChars: 8000',
].join('\n');

const TEXT_TOON = [
  'ok: true',
  'operation: page.text.snapshot',
  'text:',
  '  snapshotId: text-9245',
  '  source: dom',
  '  scope: document',
  '  capturedAt: 1789633191843',
  '  blocks[3]{id,kind,text,part,continued}:',
  '    b1,heading,Nagasaki in one day,1,false',
  '    b2,list-item,Glover Garden,1,false',
  '    b3,paragraph,A long paragraph that,2,true',
  '  scanTruncated: false',
  '  truncated: true',
  '  nextCursor: cursor-2',
  '  maxChars: 16000',
].join('\n');

describe('browser tool view', () => {
  it('turns a TOON element snapshot into rows, state badges and request filters', () => {
    const target = tool('page.elements.snapshot', { tabId: 'panel-tab-3', scope: 'document', filter: { text: 'Nagasaki' } }, ELEMENTS_TOON);
    const view = viewOf(target);
    const elements = section(view, 'elements');
    expect(elements.rows).toEqual([
      { ref: 'e1', role: 'link', name: 'Nagasaki day trip', text: undefined, value: undefined, states: ['offscreen'] },
      { ref: 'e2', role: 'checkbox', name: 'Remember me', text: 'Keep me signed in', value: 'on', states: ['checked', 'disabled'] },
    ]);
    const request = section(view, 'request');
    expect(request.facts).toContainEqual({ key: 'filterText', value: { type: 'text', text: 'Nagasaki' } });
    expect(request.facts).toContainEqual({ key: 'scope', value: { type: 'code', text: 'document' } });
    expect(view.rest).toContainEqual({ source: 'result', path: 'elements.snapshotId', value: 'elements-ae18' });
    expect(view.rest).toContainEqual({ source: 'result', path: 'elements.maxChars', value: 8000 });
  });

  it('keeps every text block with its id, continuation and truncation state', () => {
    const view = viewOf(tool('page.text.snapshot', { tabId: 'panel-tab-3', scope: { kind: 'document' }, maxChars: 16000 }, TEXT_TOON));
    const text = section(view, 'text');
    expect(text.blocks).toEqual([
      { id: 'b1', kind: 'heading', text: 'Nagasaki in one day', part: 1, continued: false },
      { id: 'b2', kind: 'list-item', text: 'Glover Garden', part: 1, continued: false },
      { id: 'b3', kind: 'paragraph', text: 'A long paragraph that', part: 2, continued: true },
    ]);
    expect(text.facts).toContainEqual({ key: 'truncated', value: { type: 'bool', value: true } });
    expect(text.facts).toContainEqual({ key: 'nextCursor', value: { type: 'code', text: 'cursor-2' } });
  });

  it('shows the clicked element and the page change it caused', () => {
    const before = tool('tab.navigate', { tabId: 'panel-tab-3', url: 'https://www.example.com/search' }, {
      ok: true, operation: 'tab.navigate', tab: { ...TAB, url: 'https://www.example.com/search', title: 'Search' },
    });
    const snapshot = tool('page.elements.snapshot', { tabId: 'panel-tab-3' }, ELEMENTS_TOON);
    const result = { ok: true, operation: 'page.element.click', tab: TAB };
    const target = tool('page.element.click', { tabId: 'panel-tab-3', snapshotId: 'elements-ae18', ref: 'e1' }, result);
    const view = viewOf(target, [before, snapshot]);
    expect(section(view, 'request').facts).toContainEqual({
      key: 'target', value: { type: 'element', ref: 'e1', name: 'Nagasaki day trip' },
    });
    const page = section(view, 'page');
    expect(page).toMatchObject({ title: TAB.title, compared: true, facts: [] });
    expect(page.changes).toEqual([
      { key: 'pageTitle', before: { type: 'text', text: 'Search' }, after: { type: 'text', text: TAB.title } },
      { key: 'pageUrl', before: { type: 'url', url: 'https://www.example.com/search' }, after: { type: 'url', url: TAB.url } },
    ]);
    expect(view.rest).toContainEqual({ source: 'result', path: 'tab.canGoBack', value: true });
    expectNothingLost(target, view, result);
  });

  it('shows the whole page state the first time a tab is seen', () => {
    const result = { ok: true, operation: 'tab.get_state', tab: TAB };
    const target = tool('tab.get_state', { tabId: 'panel-tab-3' }, result);
    const page = section(viewOf(target), 'page');
    expect(page).toMatchObject({ title: TAB.title, url: TAB.url, compared: false, changes: [] });
    expect(page.facts.map((item) => item.key)).toEqual(['loading', 'canGoBack', 'canGoForward', 'controlled', 'visible']);
  });

  it('reports flag changes against the last known state of the same tab only', () => {
    const before = tool('tab.get_state', { tabId: 'panel-tab-3' }, { ok: true, operation: 'tab.get_state', tab: { ...TAB, loading: true, canGoForward: true } });
    const other = tool('tab.get_state', { tabId: 'panel-tab-9' }, { ok: true, operation: 'tab.get_state', tab: { ...TAB, tabId: 'panel-tab-9', title: 'Other' } });
    const target = tool('tab.wait_for_load', { tabId: 'panel-tab-3', state: 'complete' }, { ok: true, operation: 'tab.wait_for_load', tab: TAB });
    expect(section(viewOf(target, [before, other]), 'page').changes).toEqual([
      { key: 'loading', before: { type: 'bool', value: true }, after: { type: 'bool', value: false } },
      { key: 'canGoForward', before: { type: 'bool', value: true }, after: { type: 'bool', value: false } },
    ]);
  });

  it('names the page from earlier calls when the result itself carries no tab', () => {
    const before = tool('tab.reload', { tabId: 'panel-tab-3' }, { ok: true, operation: 'tab.reload', tab: TAB });
    const view = viewOf(tool('page.text.snapshot', { tabId: 'panel-tab-3' }, TEXT_TOON), [before]);
    expect(section(view, 'page')).toEqual({ kind: 'page', title: TAB.title, url: '', compared: false, changes: [], facts: [] });
  });

  it('reports no change and leaves the unchanged state under the remaining fields', () => {
    const before = tool('tab.reload', { tabId: 'panel-tab-3' }, { ok: true, operation: 'tab.reload', tab: TAB });
    const result = { ok: true, operation: 'tab.get_state', tab: TAB };
    const target = tool('tab.get_state', { tabId: 'panel-tab-3' }, result);
    const view = viewOf(target, [before]);
    expect(section(view, 'page')).toEqual({ kind: 'page', title: TAB.title, url: '', compared: true, changes: [], facts: [] });
    expect(view.rest).toContainEqual({ source: 'result', path: 'tab.url', value: TAB.url });
    expect(view.rest).toContainEqual({ source: 'result', path: 'tab.loading', value: false });
    expectNothingLost(target, view, result);
  });

  it('renders typed text, key chords, options and checkbox state as request facts', () => {
    const typed = viewOf(tool('page.visual.type_text', { tabId: 't', text: 'kimi code', replace: true }));
    expect(section(typed, 'request').facts).toEqual([
      { key: 'text', value: { type: 'text', text: 'kimi code' } },
      { key: 'replace', value: { type: 'bool', value: true } },
    ]);
    const pressed = viewOf(tool('page.visual.press_key', { tabId: 't', keys: ['ControlOrMeta', 'A'] }));
    expect(section(pressed, 'request').facts).toEqual([{ key: 'keys', value: { type: 'keys', keys: ['ControlOrMeta', 'A'] } }]);
    const selected = viewOf(tool('page.element.select_option', { tabId: 't', snapshotId: 's', ref: 'e4', index: 2 }));
    expect(section(selected, 'request').facts).toContainEqual({ key: 'optionIndex', value: { type: 'number', value: 2 } });
    const checked = viewOf(tool('page.element.set_checked', { tabId: 't', snapshotId: 's', ref: 'e4', checked: false }));
    expect(section(checked, 'request').facts).toContainEqual({ key: 'checked', value: { type: 'bool', value: false } });
  });

  it('describes wait conditions and the matched evidence', () => {
    const result = { ok: true, operation: 'page.wait_for', wait: { matched: true, elapsedMs: 5, evidence: { kind: 'text', value: 'All', count: 3, scanTruncated: false } } };
    const target = tool('page.wait_for', { tabId: 't', condition: { kind: 'element', locator: { role: 'button', name: 'Save', exact: true }, state: 'visible' }, timeoutMs: 8000, stableForMs: 200 }, result);
    const view = viewOf(target);
    expect(section(view, 'request').facts).toEqual([
      { key: 'conditionKind', value: { type: 'code', text: 'element' } },
      { key: 'locatorRole', value: { type: 'code', text: 'button' } },
      { key: 'locatorName', value: { type: 'text', text: 'Save' } },
      { key: 'locatorExact', value: { type: 'bool', value: true } },
      { key: 'conditionState', value: { type: 'code', text: 'visible' } },
      { key: 'timeout', value: { type: 'duration', ms: 8000 } },
      { key: 'stableFor', value: { type: 'duration', ms: 200 } },
    ]);
    expect(section(view, 'result').facts).toContainEqual({ key: 'elapsed', value: { type: 'duration', ms: 5 } });
    expect(section(view, 'result').facts).toContainEqual({ key: 'evidenceValue', value: { type: 'text', text: 'All' } });
    expectNothingLost(target, view, result);
  });

  it('exposes its own screenshot with geometry facts', () => {
    const result = { ok: true, operation: 'page.visual.snapshot', tab: TAB, visual: { snapshotId: 'visual-04f9', mimeType: 'image/png', cropAvailable: true, width: 1166, height: 2000, deviceScaleFactor: 2, viewport: { width: 765, height: 1312 } } };
    const target = tool('page.visual.snapshot', { tabId: 'panel-tab-3' }, result, { media: SHOT_MEDIA });
    const view = viewOf(target);
    const shot = section(view, 'shot');
    expect(shot).toMatchObject({ origin: 'result', media: SHOT_MEDIA, width: 1166, height: 2000, marks: [] });
    expect(shot.facts).toContainEqual({ key: 'imageSize', value: { type: 'size', width: 1166, height: 2000 } });
    expect(shot.facts).toContainEqual({ key: 'viewport', value: { type: 'size', width: 765, height: 1312 } });
    expectNothingLost(target, view, result);
  });

  it('marks a coordinate click on the screenshot it referred to', () => {
    const snapshot = tool('page.visual.snapshot', { tabId: 'panel-tab-3' }, {
      ok: true, operation: 'page.visual.snapshot', tab: TAB, visual: { snapshotId: 'visual-04f9', mimeType: 'image/png', width: 1166, height: 2000, deviceScaleFactor: 2, viewport: { width: 765, height: 1312 } },
    }, { media: SHOT_MEDIA });
    const target = tool('page.visual.click', { tabId: 'panel-tab-3', snapshotId: 'visual-04f9', x: 300, y: 420, button: 'right' }, { ok: true, operation: 'page.visual.click', tab: TAB });
    const view = viewOf(target, [snapshot]);
    const shot = section(view, 'shot');
    expect(shot).toMatchObject({ origin: 'snapshot', media: SHOT_MEDIA, width: 1166, height: 2000 });
    expect(shot.marks).toEqual([{ type: 'point', x: 300, y: 420 }]);
    expect(section(view, 'request').facts).toContainEqual({ key: 'point', value: { type: 'point', x: 300, y: 420 } });
    expect(section(view, 'request').facts).toContainEqual({ key: 'button', value: { type: 'code', text: 'right' } });
  });

  it('keeps coordinates as facts when the referenced screenshot is not loaded', () => {
    const view = viewOf(tool('page.visual.drag', { tabId: 't', snapshotId: 'gone', from: { x: 1, y: 2 }, to: { x: 30, y: 40 } }));
    expect(view.sections.some((item) => item.kind === 'shot')).toBe(false);
    expect(section(view, 'request').facts).toEqual([
      { key: 'from', value: { type: 'point', x: 1, y: 2 } },
      { key: 'to', value: { type: 'point', x: 30, y: 40 } },
    ]);
  });

  it('draws scroll, drag and crop marks in screenshot coordinates', () => {
    const snapshot = tool('page.visual.snapshot', { tabId: 't' }, {
      ok: true, operation: 'page.visual.snapshot', visual: { snapshotId: 'v1', mimeType: 'image/png', width: 800, height: 600, deviceScaleFactor: 1, viewport: { width: 800, height: 600 } },
    }, { media: SHOT_MEDIA });
    const scroll = viewOf(tool('page.visual.scroll', { tabId: 't', snapshotId: 'v1', x: 400, y: 300, deltaX: 0, deltaY: 480 }), [snapshot]);
    expect(section(scroll, 'shot').marks).toEqual([{ type: 'arrow', from: { x: 400, y: 300 }, to: { x: 400, y: 780 } }]);
    const drag = viewOf(tool('page.visual.drag', { tabId: 't', snapshotId: 'v1', from: { x: 10, y: 20 }, to: { x: 300, y: 40 } }), [snapshot]);
    expect(section(drag, 'shot').marks).toEqual([{ type: 'arrow', from: { x: 10, y: 20 }, to: { x: 300, y: 40 } }]);
    const cropResult = { ok: true, operation: 'page.visual.crop', crop: { sourceSnapshotId: 'v1', capturedAt: 1789633191843, region: { x: 10, y: 20, width: 200, height: 100 }, mimeType: 'image/png', width: 400, height: 200 } };
    const crop = viewOf(tool('page.visual.crop', { tabId: 't', snapshotId: 'v1', region: { x: 10, y: 20, width: 200, height: 100 } }, cropResult, { media: { ...SHOT_MEDIA, fileId: 'f_mcp_crop' } }), [snapshot]);
    const shots = crop.sections.filter((item): item is Extract<BrowserSection, { kind: 'shot' }> => item.kind === 'shot');
    expect(shots.map((item) => item.origin)).toEqual(['snapshot', 'result']);
    expect(shots[0]!.marks).toEqual([{ type: 'box', x: 10, y: 20, width: 200, height: 100, tone: 'primary' }]);
    expect(shots[1]!.media?.fileId).toBe('f_mcp_crop');
  });

  it('lists the guarded click target and nearby candidates and boxes them on the screenshot', () => {
    const snapshot = tool('page.visual.snapshot', { tabId: 't' }, {
      ok: true, operation: 'page.visual.snapshot', visual: { snapshotId: 'v1', mimeType: 'image/png', width: 800, height: 600, deviceScaleFactor: 1, viewport: { width: 800, height: 600 } },
    }, { media: SHOT_MEDIA });
    const candidate = (ref: string, name: string, x: number) => ({ ref, tagName: 'div', role: 'generic', name, id: `id-${ref}`, classes: ['slider', 'wide'], clickable: true, disabled: false, evidence: 'pointer', bounds: { x, y: 97.5, width: 120, height: 40 } });
    const result = { ok: true, operation: 'page.visual.click_if_interactive', tab: TAB, click: { outcome: 'clicked', target: candidate('e1', 'Next', 10), nearby: [candidate('e2', 'Previous', 200)], elementsSnapshotId: 'near-1', radius: 48, coordinateSpace: 'image', truncated: false, needsVisualConfirmation: true, message: 'Clicked the target.' } };
    const target = tool('page.visual.click_if_interactive', { tabId: 't', snapshotId: 'v1', x: 60, y: 110 }, result);
    const view = viewOf(target, [snapshot]);
    const candidates = section(view, 'candidates');
    expect(candidates.rows.map((row) => [row.relation, row.ref, row.name])).toEqual([['target', 'e1', 'Next'], ['nearby', 'e2', 'Previous']]);
    expect(candidates.rows[0]).toMatchObject({ tagName: 'div', role: 'generic', id: 'id-e1', classes: ['slider', 'wide'], evidence: 'pointer', clickable: true, disabled: false, bounds: { x: 10, y: 97.5, width: 120, height: 40 } });
    expect(section(view, 'shot').marks).toEqual([
      { type: 'box', x: 200, y: 97.5, width: 120, height: 40, tone: 'secondary', label: 'e2' },
      { type: 'box', x: 10, y: 97.5, width: 120, height: 40, tone: 'primary', label: 'e1' },
      { type: 'point', x: 60, y: 110 },
    ]);
    expect(section(view, 'result').facts).toContainEqual({ key: 'message', value: { type: 'text', text: 'Clicked the target.' } });
    expectNothingLost(target, view, result);
  });

  it('lists tabs with the controlled and visible markers', () => {
    const result = { ok: true, operation: 'browser.get_state', browser: { available: true, panelVisible: true, activeTabId: 'panel-tab-3', visibleTabId: 'panel-tab-1', tabs: [{ ...TAB, tabId: 'panel-tab-1', title: 'Home', active: false }, { ...TAB, visible: false }] } };
    const target = tool('browser.get_state', {}, result);
    const view = viewOf(target);
    const tabs = section(view, 'tabs');
    expect(tabs.rows.map((row) => [row.tabId, row.title, row.controlled, row.visible])).toEqual([
      ['panel-tab-1', 'Home', false, true],
      ['panel-tab-3', TAB.title, true, false],
    ]);
    expect(section(view, 'result').facts).toContainEqual({ key: 'panelVisible', value: { type: 'bool', value: true } });
    expectNothingLost(target, view, result);
  });

  it('shows history, downloads and device profiles as tables', () => {
    const history = viewOf(tool('browser.get_history', {}, { ok: true, operation: 'browser.get_history', history: [{ id: 'h1', url: 'https://a.example', title: 'A', visitedAt: 1789633191843 }] }));
    expect(section(history, 'table')).toMatchObject({ name: 'history', columns: ['title', 'url', 'visitedAt'] });
    expect(section(history, 'table').rows[0]).toEqual([
      { type: 'text', text: 'A' }, { type: 'url', url: 'https://a.example' }, { type: 'time', ms: 1789633191843 },
    ]);
    expect(history.rest).toContainEqual({ source: 'result', path: 'history[0].id', value: 'h1' });
    const downloads = viewOf(tool('browser.get_downloads', {}, { ok: true, operation: 'browser.get_downloads', downloads: [{ id: 'd1', url: 'https://a.example/f.zip', filename: 'f.zip', savePath: '/tmp/f.zip', state: 'completed', startedAt: 1789633191843, receivedBytes: 10, totalBytes: 10 }] }));
    expect(section(downloads, 'table').columns).toEqual(['filename', 'state', 'received', 'total', 'startedAt', 'url', 'savePath']);
    const devices = viewOf(tool('browser.get_device_profiles', {}, { ok: true, operation: 'browser.get_device_profiles', deviceProfiles: [{ profileId: 'iphone-se', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true, orientation: 'portrait' }] }));
    expect(section(devices, 'table').rows[0]).toEqual([
      { type: 'code', text: 'iphone-se' }, { type: 'size', width: 375, height: 667 }, { type: 'number', value: 2 },
      { type: 'bool', value: true }, { type: 'bool', value: true }, { type: 'code', text: 'portrait' },
    ]);
  });

  it('explains failures without dropping the original code, message or last observation', () => {
    const result = { ok: false, operation: 'page.wait_for', error: { code: 'WAIT_TIMEOUT', message: 'Timed out waiting.', lastObserved: { kind: 'url', value: 'https://a.example', count: 0 } } };
    const target = tool('page.wait_for', { tabId: 't', condition: { kind: 'url', value: 'https://b.example', match: 'prefix' } }, result, { status: 'error' });
    const view = viewOf(target);
    const error = section(view, 'error');
    expect(error).toMatchObject({ code: 'WAIT_TIMEOUT', message: 'Timed out waiting.' });
    expect(error.facts).toContainEqual({ key: 'evidenceValue', value: { type: 'text', text: 'https://a.example' } });
    expectNothingLost(target, view, result);
  });

  it('routes fields it does not understand to the remaining-fields list instead of hiding them', () => {
    const result = { ok: true, operation: 'tab.get_state', tab: { ...TAB, muted: true, device: { enabled: true, profileId: 'pixel-7' } }, futureField: { nested: [1, 2] } };
    const target = tool('tab.get_state', { tabId: 'panel-tab-3', futureArg: 'x' }, result);
    const view = viewOf(target);
    expect(view.rest).toContainEqual({ source: 'args', path: 'futureArg', value: 'x' });
    expect(view.rest).toContainEqual({ source: 'result', path: 'tab.muted', value: true });
    expect(view.rest).toContainEqual({ source: 'result', path: 'tab.device.profileId', value: 'pixel-7' });
    expect(view.rest).toContainEqual({ source: 'result', path: 'futureField.nested', value: [1, 2] });
    expectNothingLost(target, view, result);
  });

  it('does not lose any field for the remaining operations', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['browser.create_tab', { url: 'https://a.example' }, { tab: TAB, browser: { available: true, panelVisible: true, activeTabId: 'panel-tab-3', visibleTabId: 'panel-tab-3', tabs: [TAB] } }],
      ['browser.activate_panel', {}, { browser: { available: true, panelVisible: true, activeTabId: null, visibleTabId: null, tabs: [] } }],
      ['browser.close_tab', { tabId: 'panel-tab-3' }, { browser: { available: true, panelVisible: false, activeTabId: null, visibleTabId: null, tabs: [] } }],
      ['tab.wait_for_load', { tabId: 'panel-tab-3', state: 'dom_ready', timeoutMs: 15000 }, { tab: TAB }],
      ['tab.set_device_mode', { tabId: 'panel-tab-3', device: { enabled: true, orientation: 'portrait', profileId: 'pixel-7', scaleMode: 'fit' } }, { tab: TAB }],
      ['page.element.fill', { tabId: 'panel-tab-3', snapshotId: 's', ref: 'e9', text: 'hello' }, { tab: TAB }],
      ['page.element.press_key', { tabId: 'panel-tab-3', snapshotId: 's', ref: 'e9', keys: ['Enter'] }, { tab: TAB }],
      ['page.element.select_option', { tabId: 'panel-tab-3', snapshotId: 's', ref: 'e9', label: 'Tokyo' }, { tab: TAB }],
      ['page.text.snapshot', { tabId: 'panel-tab-3', scope: { kind: 'element', snapshotId: 's', ref: 'e9' } }, {}],
      ['page.elements.snapshot', { tabId: 'panel-tab-3', cursor: 'cursor-2' }, {}],
    ];
    for (const [operation, args, body] of cases) {
      const result = { ok: true, operation, ...body };
      const target = tool(operation, args, result);
      expectNothingLost(target, viewOf(target), result);
    }
  });

  it('shows the before-action receipt right after the request and keeps malformed ids as plain fields', () => {
    const result = { ok: true, operation: 'page.element.click', tab: TAB, receipt: 'r-0123456789ab' };
    const target = tool('page.element.click', { tabId: 'panel-tab-3', snapshotId: 's', ref: 'e1' }, result);
    const view = viewOf(target);
    expect(view.sections.map((item) => item.kind).slice(0, 2)).toEqual(['request', 'receipt']);
    expect(section(view, 'receipt')).toEqual({ kind: 'receipt', id: 'r-0123456789ab' });
    expectNothingLost(target, view, result);

    const odd = viewOf(tool('page.element.click', { tabId: 'panel-tab-3', snapshotId: 's', ref: 'e1' }, { ...result, receipt: '../x' }));
    expect(odd.sections.some((item) => item.kind === 'receipt')).toBe(false);
    expect(odd.rest).toContainEqual({ source: 'result', path: 'receipt', value: '../x' });
  });

  it('reads a result whose JSON is glued to a following attachment notice', () => {
    const json = JSON.stringify({ ok: true, operation: 'page.visual.snapshot', tab: TAB, visual: { snapshotId: 'v1', mimeType: 'image/png', width: 10, height: 20, deviceScaleFactor: 1, viewport: { width: 10, height: 20 } } });
    const target = tool('page.visual.snapshot', { tabId: 'panel-tab-3' }, `${json}Original attachment saved at: "/s/media/f_mcp_abc.png"\nAttachment reference: "kimi-file://f_mcp_abc"`);
    expect(section(viewOf(target), 'shot')).toMatchObject({ width: 10, height: 20 });
  });

  it('renders TOON results exactly like the equivalent JSON results', () => {
    const visual = { snapshotId: 'visual-1', mimeType: 'image/png', cropAvailable: true, width: 800, height: 600, deviceScaleFactor: 2, viewport: { width: 400, height: 300 } };
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, Partial<ToolCall>?]> = [
      ['browser.get_state', {}, { browser: { available: true, panelVisible: true, activeTabId: 'panel-tab-3', visibleTabId: 'panel-tab-3', tabs: [TAB, { ...TAB, tabId: 'panel-tab-4', active: false, visible: false }] } }],
      ['tab.navigate', { tabId: 'panel-tab-3', url: 'https://www.example.com/' }, { tab: TAB, receipt: 'r-0123456789ab' }],
      ['page.visual.snapshot', { tabId: 'panel-tab-3' }, { tab: TAB, visual }, { media: SHOT_MEDIA }],
      ['page.elements.snapshot', { tabId: 'panel-tab-3' }, { elements: { snapshotId: 'elements-1', scope: 'viewport', total: 2, maxChars: 8000, nextCursor: null, elements: [{ ref: 'e1', role: 'link', name: 'Home', text: null, value: null, state: null }, { ref: 'e2', role: 'checkbox', name: 'Remember', text: null, value: null, state: 'checked' }] } }],
      ['page.text.snapshot', { tabId: 'panel-tab-3' }, { text: { snapshotId: 'text-1', source: 'dom', scope: 'document', blocks: [{ id: 'b1', kind: 'heading', text: 'Title: with, commas', part: 1, continued: false }], truncated: false } }],
      ['page.visual.click', { tabId: 'panel-tab-3', snapshotId: 'visual-1', x: 30, y: 40 }, { tab: TAB, receipt: 'r-0123456789ab' }],
      ['page.visual.crop', { tabId: 'panel-tab-3', snapshotId: 'visual-1', region: { x: 1, y: 2, width: 30, height: 40 } }, { crop: { sourceSnapshotId: 'visual-1', capturedAt: 5, region: { x: 1, y: 2, width: 30, height: 40 }, mimeType: 'image/png', width: 30, height: 40 } }, { media: SHOT_MEDIA }],
      ['tab.navigate', { tabId: 'panel-tab-3', url: 'https://www.example.com/' }, { ok: false, error: { code: 'BROWSER_USER_TAKEOVER', message: 'The user took control.' } }, { status: 'error' }],
    ];
    const notice = 'Original attachment saved at: "/s/media/f_mcp_abc.png"\nAttachment reference: "kimi-file://f_mcp_abc"\nSession-relative attachment: "media/f_mcp_abc.png"\nMIME: "image/png"; size: 4 bytes';
    for (const [operation, args, body, extra] of cases) {
      const result = { ok: true, operation, ...body };
      const expected = viewOf(tool(operation, args, result, extra));
      const toon = encode(result);
      const image = { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } };
      const outputs: unknown[] = [
        toon,
        `${toon}${notice}`,
        `${toon}\n${notice}`,
        [{ type: 'text', text: toon }, image],
        [{ type: 'text', text: toon }, image, { type: 'text', text: notice }],
        [{ type: 'text', text: toon }, { type: 'text', text: `<system>Image compressed to fit model limits: 4 bytes</system>\n${notice}` }],
      ];
      for (const output of outputs) {
        const target = tool(operation, args, output, extra);
        const view = viewOf(target);
        expect(view.resultUnreadable).toBe(false);
        expect({ sections: view.sections, rest: view.rest }).toEqual({ sections: expected.sections, rest: expected.rest });
        expectNothingLost(target, view, result);
      }
    }
  });

  it('keeps malformed TOON as unreadable raw output', () => {
    for (const output of ['ok: true\nitems[3]: a,b', 'ok: maybe\noperation: tab.navigate', 'operation: tab.navigate\ntab:\n  tabId: x']) {
      expect(browserToolView(tool('tab.navigate', { tabId: 't' }, output), {})?.resultUnreadable).toBe(true);
    }
  });

  it('falls back to raw output when the request or the result cannot be understood', () => {
    expect(browserToolView({ ...tool('page.element.click'), arg: '{"operation":' }, {})).toBeUndefined();
    expect(browserToolView(tool('page.element.click', { protocol: 'other' }), {})).toBeUndefined();
    const unreadable = browserToolView(tool('tab.get_state', { tabId: 't' }, 'Tool execution was interrupted'), {});
    expect(unreadable?.resultUnreadable).toBe(true);
    const running = browserToolView({ ...tool('tab.get_state', { tabId: 't' }), status: 'running' }, {});
    expect(running?.resultUnreadable).toBe(false);
  });
});
