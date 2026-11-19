import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import type { ActivityItem } from '../../chatTurnRendering';
import { browserPageKey } from './browserPages';
import { browserToolData, isBrowserTool, type BrowserToolContext } from './browserToolPresentation';
import { str } from './toolArgs';

export interface BrowserRetryItem {
  kind: 'browser-retry';
  tool: ToolCall;
  attempts: ActivityItem[];
  retries: number;
  sourceIndex: number;
}

export type ActivityRunItem = ActivityItem | BrowserRetryItem;

export interface BrowserRetryFold {
  items: ActivityRunItem[];
  recovered: ReadonlySet<ToolCall>;
}

const RECOVERABLE = new Set([
  'TAB_NOT_ACTIVE', 'STALE_ELEMENT', 'STALE_SNAPSHOT', 'SNAPSHOT_EXPIRED',
  'ELEMENT_NOT_INTERACTABLE', 'PAGE_NOT_READY', 'INVALID_REQUEST',
]);

const BRIDGES = new Set([
  'browser.get_state', 'browser.activate_tab', 'browser.activate_panel', 'tab.get_state',
  'tab.wait_for_load', 'page.wait_for', 'page.elements.snapshot', 'page.visual.snapshot',
  'page.element.scroll_into_view',
]);

const INVALID_REQUEST_PREFIX = 'Invalid kimi.browser/1.0.0 request';

const SNAPSHOT_FAILURES = new Set(['STALE_SNAPSHOT', 'SNAPSHOT_EXPIRED']);

const POSITIONS: Record<string, readonly string[]> = {
  'page.visual.click': ['x', 'y'],
  'page.visual.click_if_interactive': ['x', 'y'],
  'page.visual.hover': ['x', 'y'],
  'page.visual.scroll': ['x', 'y'],
  'page.visual.drag': ['from', 'to'],
  'page.visual.crop': ['region'],
};

const INCIDENTAL = new Set(['protocol', 'operation', 'tabId', 'snapshotId', 'ref', 'url', 'cursor', 'timeoutMs', 'stableForMs', 'maxChars', 'limit']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = record(value);
  if (object !== undefined) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function intent(args: Record<string, unknown>, positions: readonly string[]): string {
  return stable(Object.fromEntries(Object.entries(args).flatMap(([key, value]): [string, unknown][] => {
    if (INCIDENTAL.has(key) || positions.includes(key)) return [];
    return [[key, value]];
  })));
}

function recoverableCode(tool: ToolCall): string | undefined {
  if (!isBrowserTool(tool)) return undefined;
  const { args, result } = browserToolData(tool);
  if (args === undefined) return undefined;
  let code: string | undefined;
  if (result?.ok === false) code = str(record(result.error)?.code);
  else if (tool.status === 'error' && result === undefined && (tool.output ?? []).join('\n').trimStart().startsWith(INVALID_REQUEST_PREFIX)) code = 'INVALID_REQUEST';
  return code !== undefined && RECOVERABLE.has(code) ? code : undefined;
}

function succeeded(tool: ToolCall): boolean {
  return isBrowserTool(tool) && tool.status === 'ok' && browserToolData(tool).result?.ok === true;
}

function sameIntent(
  failed: ToolCall,
  retry: ToolCall,
  code: string,
  loose: boolean,
  contextOf: (tool: ToolCall) => BrowserToolContext | undefined,
): boolean {
  if (failed.agentId !== retry.agentId) return false;
  const a = browserToolData(failed).args;
  const b = browserToolData(retry).args;
  const operation = str(a?.operation);
  if (a === undefined || b === undefined || operation === undefined || operation !== str(b.operation)) return false;
  const tabA = str(a.tabId);
  const tabB = str(b.tabId);
  if (tabA !== undefined && tabB !== undefined && tabA !== tabB) return false;
  if (loose) return true;
  if (operation.startsWith('page.element.')) {
    const name = contextOf(failed)?.element;
    if (name === undefined || name !== contextOf(retry)?.element) return false;
  }
  if ((operation === 'tab.navigate' || operation === 'browser.create_tab') && (browserPageKey(a.url) ?? str(a.url)) !== (browserPageKey(b.url) ?? str(b.url))) return false;
  if ((operation === 'tab.search' || operation === 'browser.create_tab') && str(a.query)?.trim() !== str(b.query)?.trim()) return false;
  const positions = POSITIONS[operation] ?? [];
  if (intent(a, positions) !== intent(b, positions)) return false;
  if (positions.length === 0) return true;
  if (str(a.snapshotId) === str(b.snapshotId)) return positions.every((key) => stable(a[key]) === stable(b[key]));
  return SNAPSHOT_FAILURES.has(code);
}

function bridge(failed: ToolCall, tool: ToolCall): boolean {
  if (failed.agentId !== tool.agentId) return false;
  if (!succeeded(tool) || !BRIDGES.has(str(browserToolData(tool).args?.operation) ?? '')) return false;
  const tab = str(browserToolData(tool).args?.tabId);
  return tab === undefined || tab === str(browserToolData(failed).args?.tabId);
}

export function foldBrowserRetries(
  items: readonly ActivityItem[],
  contextOf: (tool: ToolCall) => BrowserToolContext | undefined,
): BrowserRetryFold {
  const folded: ActivityRunItem[] = [];
  const recovered = new Set<ToolCall>();
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    const code = item.kind === 'tool' ? recoverableCode(item.tool) : undefined;
    if (item.kind !== 'tool' || code === undefined) {
      folded.push(item);
      index++;
      continue;
    }
    const attempts = [item.tool];
    let end = -1;
    for (let next = index + 1; next < items.length; next++) {
      const candidate = items[next]!;
      if (candidate.kind === 'thinking') continue;
      const tool = candidate.tool;
      const retryCode = recoverableCode(tool);
      const loose = code === 'INVALID_REQUEST' || retryCode === 'INVALID_REQUEST';
      if (succeeded(tool) && sameIntent(item.tool, tool, code, code === 'INVALID_REQUEST', contextOf)) {
        end = next;
        break;
      }
      if (retryCode !== undefined && sameIntent(item.tool, tool, code, loose, contextOf)) {
        attempts.push(tool);
        continue;
      }
      if (!bridge(item.tool, tool)) break;
    }
    const last = end < 0 ? undefined : items[end];
    if (last?.kind !== 'tool') {
      folded.push(item);
      index++;
      continue;
    }
    for (const tool of attempts) recovered.add(tool);
    folded.push({ kind: 'browser-retry', tool: last.tool, attempts: items.slice(index, end + 1), retries: attempts.length, sourceIndex: last.sourceIndex });
    index = end + 1;
  }
  return { items: folded, recovered };
}
