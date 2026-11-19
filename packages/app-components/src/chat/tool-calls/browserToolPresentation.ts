import { decode } from '@toon-format/toon';
import type { ChatTurn, ToolCall, ToolMedia } from '@moonshot-ai/app-core/client/types';
import { BROWSER_TOOL_NAME } from '@moonshot-ai/app-core/lib';
import { num, parseArgRecord, str, urlHost } from './toolArgs';
import { BrowserPageTracker, browserPageKey } from './browserPages';

export interface BrowserToolShot {
  media: ToolMedia;
  width: number;
  height: number;
}

export interface BrowserToolContext {
  sessionId?: string;
  element?: string;
  page?: string;
  url?: string;
  address?: string;
  title?: string;
  previousTab?: Record<string, unknown>;
  shot?: BrowserToolShot;
}

export interface BrowserToolData {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

type BrowserToolSource = Pick<ToolCall, 'arg' | 'output' | 'resultText'> & { id?: string };

type Translate = (key: string, params?: Record<string, string | number>) => string;

const BROWSER_PROTOCOL = 'kimi.browser/1.0.0';

const actions: Record<string, string> = {
  'page.wait_for': 'waitCondition',
  'page.visual.crop': 'crop',
  'page.text.snapshot': 'readText',
  'browser.get_history': 'listHistory',
  'browser.get_downloads': 'listDownloads',
  'browser.get_device_profiles': 'listDevices',
  'tab.set_device_mode': 'setDevice',
  'browser.get_state': 'inspectBrowser',
  'browser.activate_panel': 'showBrowser',
  'browser.create_tab': 'createTab',
  'browser.activate_tab': 'activateTab',
  'browser.switch_tab': 'switchTab',
  'browser.release_tab': 'releaseTab',
  'browser.close_tab': 'closeTab',
  'tab.get_state': 'inspectPage',
  'tab.navigate': 'navigate',
  'tab.search': 'search',
  'tab.go_back': 'back',
  'tab.go_forward': 'forward',
  'tab.reload': 'reload',
  'tab.stop_loading': 'stop',
  'tab.wait_for_load': 'wait',
  'page.visual.snapshot': 'screenshot',
  'page.visual.click': 'click',
  'page.visual.click_if_interactive': 'guardedClick',
  'page.visual.hover': 'hover',
  'page.visual.scroll': 'scroll',
  'page.visual.drag': 'drag',
  'page.visual.type_text': 'type',
  'page.visual.press_key': 'press',
  'page.elements.snapshot': 'elements',
  'page.element.click': 'click',
  'page.element.hover': 'hover',
  'page.element.fill': 'fill',
  'page.element.type_text': 'type',
  'page.element.press_key': 'press',
  'page.element.select_option': 'select',
  'page.element.set_checked': 'check',
  'page.element.scroll_into_view': 'reveal',
};

export function isBrowserTool(tool: Pick<ToolCall, 'name'>): boolean {
  return tool.name === BROWSER_TOOL_NAME;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

function leadingJsonRecord(source: string): Record<string, unknown> | null {
  const input = source.trimStart();
  if (!input.startsWith('{')) return null;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) return parseArgRecord(input.slice(0, i + 1));
  }
  return null;
}

function parseBrowserToolResult(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split('\n')) {
    const parsed = leadingJsonRecord(line);
    if (typeof parsed?.ok === 'boolean') return parsed;
  }
  const parsed = leadingJsonRecord(text);
  if (typeof parsed?.ok === 'boolean') return parsed;
  try {
    const decoded = record(decode(text));
    return typeof decoded?.ok === 'boolean' ? decoded : undefined;
  } catch { return undefined; }
}

const DATA_CACHE_LIMIT = 512;

interface BrowserToolDataEntry {
  arg: string;
  output: readonly string[] | undefined;
  resultText: string | undefined;
  lines: number;
  data: BrowserToolData;
}

const dataByTool = new WeakMap<object, BrowserToolDataEntry>();
const dataById = new Map<string, BrowserToolDataEntry>();

function current(entry: BrowserToolDataEntry | undefined, tool: BrowserToolSource): entry is BrowserToolDataEntry {
  if (entry === undefined || entry.arg !== tool.arg || entry.resultText !== tool.resultText || entry.lines !== (tool.output?.length ?? -1)) return false;
  if (entry.output === tool.output) return true;
  return entry.output !== undefined && tool.output !== undefined && entry.output.every((line, index) => line === tool.output![index]);
}

export function browserToolData(tool: BrowserToolSource): BrowserToolData {
  const known = dataByTool.get(tool);
  if (current(known, tool)) return known.data;
  const id = tool.id;
  const kept = id === undefined ? undefined : dataById.get(id);
  let data: BrowserToolData;
  if (current(kept, tool)) {
    data = kept.data;
  } else {
    const args = parseArgRecord(tool.arg);
    data = { args: args?.protocol === BROWSER_PROTOCOL ? args : undefined, result: parseBrowserToolResult(tool.resultText ?? tool.output?.join('\n')) };
  }
  const entry: BrowserToolDataEntry = { arg: tool.arg, output: tool.output, resultText: tool.resultText, lines: tool.output?.length ?? -1, data };
  if (id !== undefined) {
    dataById.delete(id);
    dataById.set(id, entry);
    if (dataById.size > DATA_CACHE_LIMIT) dataById.delete(dataById.keys().next().value!);
  }
  dataByTool.set(tool, entry);
  return data;
}

export const BROWSER_RECEIPT_ID = /^r-[0-9a-f]{12}$/;

export function browserToolReceipt(tool: BrowserToolSource): string | undefined {
  const receipt = browserToolData(tool).result?.receipt;
  return typeof receipt === 'string' && BROWSER_RECEIPT_ID.test(receipt) ? receipt : undefined;
}

export function browserToolFailed(tool: BrowserToolSource & Pick<ToolCall, 'name' | 'status'>): boolean {
  return tool.status === 'error' || (isBrowserTool(tool) && browserToolData(tool).result?.ok === false);
}

export function browserToolTab(tool: BrowserToolSource): string | undefined {
  const { args, result } = browserToolData(tool);
  return str(record(result?.tab)?.tabId) ?? str(args?.tabId);
}

function pageName(value: unknown): string {
  const page = record(value);
  return text(page?.title) || (str(page?.url) ? text(urlHost(str(page?.url)!)) : '');
}

export function browserToolClickName(result: Record<string, unknown> | undefined): string | undefined {
  const click = record(result?.click);
  return click?.outcome === 'clicked' ? text(record(click.target)?.name) || undefined : undefined;
}

export function browserToolContexts(turns: readonly ChatTurn[]): ReadonlyMap<ToolCall, BrowserToolContext> {
  const contexts = new Map<ToolCall, BrowserToolContext>();
  const elements = new Map<string, string>();
  const pages = new Map<string, string>();
  const urls = new Map<string, string>();
  const addresses = new Map<string, string>();
  const trackers = new Map<string, BrowserPageTracker>();
  const tabStates = new Map<string, Record<string, unknown>>();
  const shots = new Map<string, BrowserToolShot>();
  for (const turn of turns) {
    const tools = turn.blocks
      ? turn.blocks.flatMap((block) => block.kind === 'tool' ? [block.tool] : [])
      : turn.tools ?? [];
    for (const tool of tools) {
      if (!isBrowserTool(tool)) continue;
      const { args, result } = browserToolData(tool);
      if (args === undefined) continue;
      const scope = [turn.sessionId ?? '', tool.agentId ?? 'main'];
      const scopeKey = JSON.stringify(scope);
      const tracker = trackers.get(scopeKey) ?? new BrowserPageTracker();
      trackers.set(scopeKey, tracker);
      const pageKey = (tabId: unknown) => JSON.stringify([...scope, tabId]);
      const elementKey = (snapshotId: unknown, ref: unknown) =>
        JSON.stringify([...scope, args.tabId, snapshotId, ref]);
      const elementName = elements.get(elementKey(args.snapshotId, args.ref));
      const previousTab = tabStates.get(pageKey(args.tabId));
      const succeeded = tool.status === 'ok' && result?.ok === true;
      const tab = succeeded ? record(result.tab) : undefined;
      const remember = (entry: Record<string, unknown> | undefined, via?: string) => {
        const tabId = str(entry?.tabId);
        if (tabId === undefined) return;
        const url = browserPageKey(entry!.url);
        if (url !== undefined) tracker.observe(tabId, url, str(entry!.title), via);
        if (url === undefined) {
          urls.delete(pageKey(tabId));
          addresses.delete(pageKey(tabId));
        } else {
          urls.set(pageKey(tabId), url);
          addresses.set(pageKey(tabId), str(entry!.url) ?? url);
        }
        pages.set(pageKey(tabId), url === undefined ? pageName(entry) : tracker.label(url) ?? text(urlHost(url)));
        tabStates.set(pageKey(tabId), entry!);
      };
      remember(tab, args.operation === 'page.element.click' ? elementName : browserToolClickName(result));
      const tabs = succeeded ? record(result.browser)?.tabs : undefined;
      if (Array.isArray(tabs)) for (const item of tabs) remember(record(item));
      const pageTab = str(tab?.tabId) ?? str(args.tabId);
      const pageUrl = pageTab === undefined ? undefined : urls.get(pageKey(pageTab));
      contexts.set(tool, {
        sessionId: turn.sessionId,
        element: elementName,
        page: (pageTab === undefined ? undefined : pages.get(pageKey(pageTab))) || pageName(result?.tab) || undefined,
        url: pageUrl,
        address: pageTab === undefined ? undefined : addresses.get(pageKey(pageTab)),
        title: pageUrl === undefined ? undefined : tracker.label(pageUrl),
        previousTab,
        shot: shots.get(elementKey(args.snapshotId, 'visual')),
      });
      if (!succeeded) continue;
      const visual = record(result.visual);
      if (tool.media?.kind === 'image' && str(visual?.snapshotId) && num(visual?.width) && num(visual?.height)) {
        shots.set(elementKey(visual!.snapshotId, 'visual'), { media: tool.media, width: num(visual!.width)!, height: num(visual!.height)! });
      }
      const click = record(result.click);
      const snapshot = args.operation === 'page.elements.snapshot' ? record(result.elements)
        : args.operation === 'page.visual.click_if_interactive' && click ? { snapshotId: click.elementsSnapshotId, elements: [...(Array.isArray(click.nearby) ? click.nearby : []), ...(click.target ? [click.target] : [])] } : undefined;
      if (!str(snapshot?.snapshotId) || !Array.isArray(snapshot?.elements)) continue;
      for (const item of snapshot.elements) {
        const element = record(item);
        const name = text(element?.name) || text(element?.text);
        if (!str(element?.ref) || !name) continue;
        elements.set(elementKey(snapshot.snapshotId, element!.ref), name);
      }
    }
  }
  return contexts;
}

function point(value: unknown): string {
  const p = record(value);
  return typeof p?.x === 'number' && Number.isFinite(p.x) &&
    typeof p.y === 'number' && Number.isFinite(p.y)
    ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '';
}

const icons: Record<string, string> = {
  waitCondition: 'clock', wait: 'clock', crop: 'zoom-scan', readText: 'file-text', listHistory: 'history',
  listDownloads: 'download', listDevices: 'device-desktop', setDevice: 'device-desktop', createTab: 'tab-new-right',
  closeTab: 'tab-close', inspectPage: 'eye', navigate: 'globe', search: 'search', back: 'arrow-left', forward: 'arrow-right',
  reload: 'refresh', stop: 'stop', screenshot: 'screenshot', click: 'pointer', doubleClick: 'pointer',
  rightClick: 'pointer', guardedClick: 'pointer', hover: 'pointer', drag: 'hand', type: 'pencil', fill: 'pencil',
  press: 'key-command', elements: 'tree-view', select: 'list', check: 'checkbox-checked', uncheck: 'checkbox-checked', reveal: 'eye',
};

const quietOperations = new Set([
  'browser.get_state', 'browser.activate_panel', 'browser.activate_tab', 'browser.release_tab', 'browser.get_device_profiles',
  'tab.get_state', 'tab.wait_for_load', 'page.element.scroll_into_view',
]);

export function browserToolAction(args: Record<string, unknown> | undefined): { operation: string; action: string } {
  const operation = str(args?.operation) ?? '';
  let action = Object.hasOwn(actions, operation) ? actions[operation]! : 'other';
  if (operation === 'browser.create_tab' && str(args?.query) !== undefined) action = 'search';
  if (operation === 'page.element.set_checked' && args?.checked === false) action = 'uncheck';
  if (operation === 'page.visual.click' && args?.clickCount === 2) action = 'doubleClick';
  else if (operation === 'page.visual.click' && args?.button === 'right') action = 'rightClick';
  return { operation, action };
}

function scrollDirection(args: Record<string, unknown> | undefined): 'up' | 'down' | 'left' | 'right' | undefined {
  const deltaX = typeof args?.deltaX === 'number' ? args.deltaX : 0;
  const deltaY = typeof args?.deltaY === 'number' ? args.deltaY : 0;
  if (!deltaX && !deltaY) return undefined;
  return Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY < 0 ? 'up' : 'down' : deltaX < 0 ? 'left' : 'right';
}

export function browserToolGlyph(tool: BrowserToolSource & Pick<ToolCall, 'status'>): { icon: string; quiet: boolean } {
  const { args, result } = browserToolData(tool);
  const { operation, action } = browserToolAction(args);
  const icon = action === 'scroll' ? `arrow-${scrollDirection(args) ?? 'down'}` : Object.hasOwn(icons, action) ? icons[action]! : 'browser';
  return { icon, quiet: tool.status === 'ok' && result?.ok !== false && quietOperations.has(operation) };
}

export function browserToolPresentation(
  tool: Pick<ToolCall, 'arg' | 'output' | 'status'>,
  context: BrowserToolContext,
  t: Translate,
  phase?: 'approval',
): { label: string; detail: string; status: ToolCall['status'] } {
  const { args, result } = browserToolData(tool);
  const { operation, action } = browserToolAction(args);
  const status = tool.status === 'error' || result?.ok === false ? 'error' : tool.status;
  const target = context.element || t('tools.browser.element');
  const page = context.page || pageName(result?.tab) || '';
  let detail = page;
  if (operation.startsWith('page.element.')) detail = target;
  if (action === 'search') {
    detail = (phase === 'approval' ? str(args?.query)?.trim() : text(args?.query)) || page;
  } else if (action === 'navigate' || action === 'createTab') {
    detail = str(args?.url) ? phase === 'approval' ? str(args?.url)! : text(urlHost(str(args?.url)!)) : page;
  } else if (action === 'type' || action === 'fill') {
    const entered = text(args?.text);
    detail = operation.startsWith('page.element.')
      ? t('tools.browser.textInElement', { text: entered, target })
      : t('tools.browser.text', { text: entered });
  } else if (action === 'press') {
    detail = Array.isArray(args?.keys) ? args.keys.filter((key) => typeof key === 'string').map(text).join(' + ') : '';
    if (context.element) detail = t('tools.browser.keysOnElement', { keys: detail, target });
  } else if (action === 'select') {
    const option = text(args?.label) || text(args?.value) ||
      (typeof args?.index === 'number' ? t('tools.browser.option', { index: args.index + 1 }) : '');
    detail = option ? t('tools.browser.optionInElement', { option, target }) : target;
  } else if (operation === 'page.visual.click_if_interactive') {
    const click = record(result?.click);
    detail = text(record(click?.target)?.name) || point(args);
    if (click?.outcome === 'no_target' && Array.isArray(click.nearby)) detail = `${point(args)} · ${t('tools.browser.nearbyCount', { count: click.nearby.length })}`;
  } else if (operation === 'page.visual.click' || operation === 'page.visual.hover') {
    detail = point(args);
  } else if (action === 'drag') {
    detail = [point(args?.from), point(args?.to)].filter(Boolean).join(' → ');
  } else if (action === 'scroll') {
    const direction = scrollDirection(args);
    detail = direction ? t(`tools.browser.${direction}`) : page;
  } else if (action === 'elements') {
    const snapshot = record(result?.elements);
    if (status === 'ok' && Array.isArray(snapshot?.elements)) {
      const count = snapshot.elements.length;
      detail = t(snapshot.truncated === true ? 'tools.browser.elementsAtLeast' : 'tools.browser.elementsCount', { count });
      if (page) detail = `${page} · ${detail}`;
    }
  } else if (action === 'inspectBrowser') {
    const tabs = record(result?.browser)?.tabs;
    if (Array.isArray(tabs)) detail = t('tools.browser.tabsCount', { count: tabs.length });
  }
  const label = phase === undefined && status === 'ok' && operation === 'page.visual.click_if_interactive' && record(result?.click)?.outcome === 'no_target'
    ? t('tools.browser.noClickTarget') : t(`tools.browser.actions.${action}.${phase ?? status}`);
  return { label, detail, status };
}


export function browserApprovalPresentation(input: Record<string, unknown>, t: Translate) {
  const { label, detail } = browserToolPresentation({ arg: JSON.stringify(input), status: 'running' }, {}, t, 'approval');
  return { label, detail };
}
