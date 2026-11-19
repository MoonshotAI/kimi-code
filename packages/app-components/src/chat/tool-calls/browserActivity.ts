import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import type { ActivityClauseProvider, ActivitySummaryTool, SummaryClause, SummaryFragment } from '@moonshot-ai/app-core/lib';
import { BrowserPageTracker, browserPageKey, readableBrowserUrl } from './browserPages';
import { browserToolAction, browserToolClickName, browserToolData, type BrowserToolContext } from './browserToolPresentation';
import { str, urlHost } from './toolArgs';

type Translate = (key: string, params?: Record<string, unknown>) => string;

type BrowserActivitySource = Pick<ToolCall, 'arg' | 'output' | 'status'> & { id?: string; agentId?: string };

export type BrowserActionCategory = 'click' | 'fill' | 'select' | 'check' | 'screenshot' | 'scroll' | 'press' | 'drag' | 'hover';

const CATEGORIES: Record<string, BrowserActionCategory> = {
  'page.element.click': 'click',
  'page.visual.click': 'click',
  'page.visual.click_if_interactive': 'click',
  'page.element.fill': 'fill',
  'page.element.type_text': 'fill',
  'page.visual.type_text': 'fill',
  'page.element.select_option': 'select',
  'page.element.set_checked': 'check',
  'page.visual.snapshot': 'screenshot',
  'page.visual.scroll': 'scroll',
  'page.element.press_key': 'press',
  'page.visual.press_key': 'press',
  'page.visual.drag': 'drag',
  'page.element.hover': 'hover',
  'page.visual.hover': 'hover',
};

const CATEGORY_ORDER: readonly BrowserActionCategory[] = ['click', 'fill', 'select', 'check', 'screenshot', 'scroll', 'press', 'drag', 'hover'];

const READS = new Set(['page.text.snapshot', 'page.visual.snapshot']);

const PAGE_SUBJECTS = new Set([
  'page.text.snapshot', 'page.elements.snapshot', 'page.visual.snapshot', 'page.visual.crop',
  'page.wait_for', 'tab.wait_for_load', 'tab.get_state',
]);

const SHOWN_ACTIONS = 2;
const SUBJECT_LIMIT = 20;

export interface BrowserVisitedPage {
  url: string;
  label: string;
  titled: boolean;
  read: boolean;
  visits: number;
}

export interface BrowserActionCount {
  category: BrowserActionCategory;
  count: number;
  failed: number;
}

export interface BrowserOperationCount {
  action: string;
  count: number;
  failed: number;
}

export interface BrowserActivityDigest {
  total: number;
  failed: number;
  retried: number;
  pages: BrowserVisitedPage[];
  actions: BrowserActionCount[];
  operations: BrowserOperationCount[];
  currentPage(tool: BrowserActivitySource, tabId: string | undefined): string | undefined;
}

export interface BrowserActivityOptions {
  context?: (tool: BrowserActivitySource) => BrowserToolContext | undefined;
  recovered?: ReadonlySet<object>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function failed(tool: BrowserActivitySource, result: Record<string, unknown> | undefined): boolean {
  return tool.status === 'error' || result?.ok === false;
}

function agentTab(tool: BrowserActivitySource, tabId: string): string {
  return JSON.stringify([tool.agentId ?? 'main', tabId]);
}

function category(operation: string, result: Record<string, unknown> | undefined): BrowserActionCategory | undefined {
  if (operation === 'page.visual.click_if_interactive' && record(result?.click)?.outcome === 'no_target') return undefined;
  return CATEGORIES[operation];
}

export function digestBrowserActivity(tools: readonly BrowserActivitySource[], options: BrowserActivityOptions = {}): BrowserActivityDigest {
  const tracker = new BrowserPageTracker();
  const titles = new Map<string, string>();
  const visited = new Map<string, { read: boolean; visits: number; address?: string }>();
  const categories = new Map<BrowserActionCategory, BrowserActionCount>();
  const operations = new Map<string, BrowserOperationCount>();
  let total = 0;
  let failures = 0;
  let retried = 0;
  const visit = (url: string) => {
    const entry = visited.get(url) ?? { read: false, visits: 0 };
    visited.set(url, entry);
    return entry;
  };
  for (const tool of tools) {
    total++;
    const { args, result } = browserToolData(tool);
    const didFail = failed(tool, result);
    const recovered = didFail && options.recovered?.has(tool) === true;
    if (recovered) retried++;
    else if (didFail) failures++;
    if (args === undefined) continue;
    const context = options.context?.(tool);
    if (context?.url !== undefined && context.title !== undefined) titles.set(context.url, context.title);
    const { operation, action } = browserToolAction(args);
    const counted = operations.get(action) ?? { action, count: 0, failed: 0 };
    operations.set(action, counted);
    counted.count++;
    if (didFail) counted.failed++;
    const counts = recovered ? undefined : category(operation, result);
    if (counts !== undefined) {
      const entry = categories.get(counts) ?? { category: counts, count: 0, failed: 0 };
      categories.set(counts, entry);
      entry.count++;
      if (didFail) entry.failed++;
    }
    const tab = tool.status === 'ok' && result?.ok === true ? record(result.tab) : undefined;
    const tabId = str(tab?.tabId) ?? str(args.tabId);
    const key = tabId === undefined ? undefined : agentTab(tool, tabId);
    const previous = browserPageKey(context?.previousTab?.url);
    if (key !== undefined && previous !== undefined) tracker.seed(key, previous, str(context!.previousTab!.title));
    if (tool.status !== 'ok' || result?.ok !== true) continue;
    const url = browserPageKey(tab?.url);
    if (url !== undefined && key !== undefined) {
      const before = tracker.current(key);
      const via = operation === 'page.element.click' ? context?.element : browserToolClickName(result);
      tracker.observe(key, url, str(tab!.title), via);
      const entry = visit(url);
      entry.address = str(tab!.url) ?? url;
      if (before !== url) entry.visits++;
    }
    if (READS.has(operation)) {
      const at = url ?? (key === undefined ? undefined : tracker.current(key)) ?? context?.url;
      if (at !== undefined) {
        const entry = visit(at);
        entry.read = true;
        if (at === context?.url) entry.address ??= context.address;
      }
    }
  }
  const pages = [...visited].map(([url, { address, ...entry }]) => {
    const label = titles.get(url) ?? tracker.label(url);
    return { url: address ?? url, label: label ?? readableBrowserUrl(address ?? url), titled: label !== undefined, ...entry };
  });
  const actions = [...categories.values()].sort((a, b) =>
    b.count - a.count || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  return {
    total,
    failed: failures,
    retried,
    pages,
    actions,
    operations: [...operations.values()],
    currentPage: (tool, tabId) => {
      const url = tabId === undefined ? undefined : tracker.current(agentTab(tool, tabId));
      return url === undefined ? undefined : titles.get(url) ?? tracker.label(url) ?? urlHost(url);
    },
  };
}

export const BROWSER_DIALOG_RECORD_ICONS: Readonly<Record<string, string>> = {
  alert: 'info', confirm: 'help-circle', prompt: 'keyboard', beforeunload: 'log-out', file: 'file', upload: 'attachment', download: 'download',
  'external-app': 'external-link', print: 'printer', 'screen-capture': 'device-desktop', bluetooth: 'bolt', 'file-picker': 'folder',
};

const DIALOG_OUTCOMES = new Set(['accepted', 'dismissed', 'left', 'stayed', 'uploaded', 'saved', 'denied', 'timed-out', 'cancelled', 'blocked', 'too-large']);
const DIALOG_ANSWERERS = new Set(['agent', 'user', 'auto']);

export interface BrowserHandledDialog {
  id: string;
  kind: string;
  origin: string;
  message?: string;
  text?: string;
  outcome: string;
  answerer: string;
  settledAt: number;
  files: string[];
}

function handledDialog(value: unknown): BrowserHandledDialog | undefined {
  const item = record(value);
  const id = str(item?.id);
  const kind = str(item?.kind);
  const outcome = str(item?.outcome);
  const answerer = str(item?.answerer);
  if (id === undefined || kind === undefined || !(kind in BROWSER_DIALOG_RECORD_ICONS) || outcome === undefined || !DIALOG_OUTCOMES.has(outcome) || answerer === undefined || !DIALOG_ANSWERERS.has(answerer)) return undefined;
  const files = Array.isArray(item!.files) ? item!.files.filter((file): file is string => typeof file === 'string') : [];
  const message = str(item!.message);
  const text = typeof item!.text === 'string' ? item!.text : undefined;
  return {
    id, kind, outcome, answerer, origin: str(item!.origin) ?? '', files,
    ...(message === undefined ? {} : { message }),
    ...(text === undefined ? {} : { text }),
    settledAt: typeof item!.settledAt === 'number' ? item!.settledAt : 0,
  };
}

export function browserHandledDialogs(tools: readonly BrowserActivitySource[]): BrowserHandledDialog[] {
  const byId = new Map<string, BrowserHandledDialog>();
  for (const tool of tools) {
    const handled = browserToolData(tool).result?.handledDialogs;
    if (!Array.isArray(handled)) continue;
    for (const value of handled) {
      const dialog = handledDialog(value);
      if (dialog === undefined) continue;
      byId.delete(dialog.id);
      byId.set(dialog.id, dialog);
    }
  }
  return [...byId.values()].sort((a, b) => a.settledAt - b.settledAt);
}

let graphemeSegmenter: Intl.Segmenter | undefined;

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function clipped(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  const parts = graphemes(text);
  return parts.length > SUBJECT_LIMIT ? `${parts.slice(0, SUBJECT_LIMIT).join('')}…` : text;
}

function subject(tool: BrowserActivitySource, context: BrowserToolContext | undefined, digest: BrowserActivityDigest): string | undefined {
  const { args } = browserToolData(tool);
  const operation = str(args?.operation) ?? '';
  if (operation.startsWith('page.element.')) return context?.element;
  if (operation === 'tab.search' || (operation === 'browser.create_tab' && str(args?.query) !== undefined)) return str(args?.query);
  if (operation === 'tab.navigate' || operation === 'browser.create_tab') {
    const url = str(args?.url);
    return url === undefined ? undefined : urlHost(url) || url;
  }
  if (operation === 'page.visual.press_key' && Array.isArray(args?.keys)) {
    return args.keys.filter((key): key is string => typeof key === 'string').join(' + ') || undefined;
  }
  if (PAGE_SUBJECTS.has(operation)) return digest.currentPage(tool, str(args?.tabId)) ?? context?.page;
  return undefined;
}

export function browserClauseProvider(
  t: Translate,
  options: { contextOf?: (tool: ToolCall) => BrowserToolContext | undefined; recovered?: ReadonlySet<object> } = {},
): ActivityClauseProvider {
  const digests = new WeakMap<readonly ActivitySummaryTool[], BrowserActivityDigest>();
  const digest = (tools: readonly ActivitySummaryTool[]) => {
    const known = digests.get(tools);
    if (known !== undefined) return known;
    const next = digestBrowserActivity(tools as readonly ToolCall[], {
      context: (tool) => options.contextOf?.(tool as ToolCall),
      recovered: options.recovered,
    });
    digests.set(tools, next);
    return next;
  };
  const failedFragment = (count: number, tone: SummaryFragment['tone']): SummaryFragment =>
    ({ text: t('tools.activity.failedClause', { count }), tone });
  return {
    kind: 'browser',
    done(tools, live) {
      const summary = digest(tools);
      const visited = summary.pages.filter((page) => page.visits > 0);
      const read = summary.pages.filter((page) => page.read);
      const tone: SummaryFragment['tone'] = live ? 'faint' : 'normal';
      if (live) {
        const text = visited.length > 0
          ? t('tools.browser.activity.livePages', { count: visited.length })
          : read.length > 0
            ? t('tools.browser.activity.liveRead', { count: read.length })
            : `${t('tools.activity.liveDonePrefix')}${t('tools.group.typed.browser.done', { count: tools.length })}`;
        const fragments: SummaryFragment[] = [{ text, tone }];
        if (summary.failed > 0) fragments.push(failedFragment(summary.failed, tone));
        return [{ fragments }];
      }
      const clauses: SummaryClause[] = [];
      if (visited.length > 0) {
        const combined = read.length > 0 && read.every((page) => page.visits > 0);
        clauses.push({ fragments: [{
          text: combined
            ? t('tools.browser.activity.pagesRead', { count: visited.length, read: read.length })
            : t('tools.browser.activity.pages', { count: visited.length }),
          tone,
        }] });
        if (read.length > 0 && !combined) clauses.push({ fragments: [{ text: t('tools.browser.activity.read', { count: read.length }), tone }] });
      } else if (read.length > 0) {
        clauses.push({ fragments: [{ text: t('tools.browser.activity.read', { count: read.length }), tone }] });
      }
      const shown = summary.actions.slice(0, SHOWN_ACTIONS);
      for (const entry of shown) {
        const fragments: SummaryFragment[] = [{ text: t(`tools.browser.activity.actions.${entry.category}`, { count: entry.count }), tone }];
        if (entry.failed > 0) fragments.push(failedFragment(entry.failed, tone));
        clauses.push({ fragments });
      }
      const others = summary.failed - shown.reduce((sum, entry) => sum + entry.failed, 0);
      if (clauses.length === 0) {
        const fragments: SummaryFragment[] = [{ text: t('tools.group.typed.browser.done', { count: tools.length }), tone }];
        if (others > 0) fragments.push(failedFragment(others, tone));
        return [{ fragments }];
      }
      if (others > 0) clauses.push({ fragments: [{ text: t('tools.browser.activity.otherFailed', { count: others }), tone }] });
      return clauses;
    },
    doing(summaryTool, finished) {
      const tool = summaryTool as ToolCall;
      const { args } = browserToolData(tool);
      if (args === undefined) return undefined;
      const label = t(`tools.browser.actions.${browserToolAction(args).action}.running`);
      const target = subject(tool, options.contextOf?.(tool), digest(finished));
      return target ? t('tools.browser.activity.doing', { action: label, target: clipped(target) }) : label;
    },
    tail(tools) {
      const retried = digest(tools).retried;
      return retried > 0 ? { fragments: [{ text: t('tools.browser.activity.retried', { count: retried }), tone: 'faint' }] } : undefined;
    },
    detail(tools) {
      const summary = digest(tools);
      const items = summary.operations.map((entry) => {
        const action = t(`tools.browser.actions.${entry.action}.approval`);
        return entry.failed > 0
          ? t('tools.browser.activity.breakdownFailed', { action, count: entry.count, failed: entry.failed })
          : t('tools.browser.activity.breakdownItem', { action, count: entry.count });
      });
      return t('tools.browser.activity.breakdown', { count: summary.total, items: items.join(t('tools.browser.activity.breakdownSeparator')) });
    },
  };
}
