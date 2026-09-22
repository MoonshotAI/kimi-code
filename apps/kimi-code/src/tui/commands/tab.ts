import { formatSessionTabLabel, type SessionTabView } from '../utils/session-tab-label';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /tab — session tabs (experimental: KIMI_CODE_EXPERIMENTAL_TUI_TABS)
// ---------------------------------------------------------------------------

export type TabCommandAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'new' }
  | { readonly kind: 'next' }
  | { readonly kind: 'prev' }
  | { readonly kind: 'select'; readonly index: number }
  | { readonly kind: 'close'; readonly index?: number; readonly force: boolean }
  | { readonly kind: 'invalid'; readonly input: string };

export const TAB_COMMAND_USAGE =
  'Usage: /tab [list | <n> | next | prev | new | close [<n>] [--force]]';

/** Parse `/tab` arguments. Tab numbers are 1-based as shown in the strip. */
export function parseTabCommand(args: string): TabCommandAction {
  const tokens = args.trim().split(/\s+/);
  const head = tokens[0] ?? '';
  const rest = tokens.slice(1);
  const sub = head.toLowerCase();
  if (sub === '' || sub === 'list') return { kind: 'list' };
  if (sub === 'new') return { kind: 'new' };
  if (sub === 'next') return { kind: 'next' };
  if (sub === 'prev' || sub === 'previous') return { kind: 'prev' };
  if (sub === 'close') {
    const force = rest.some((token) => token === '--force' || token === '-f');
    const numeric = rest.find((token) => /^\d+$/.test(token));
    const index = numeric === undefined ? undefined : Number.parseInt(numeric, 10) - 1;
    if (index !== undefined && index < 0) return { kind: 'invalid', input: args };
    return { kind: 'close', index, force };
  }
  if (/^\d+$/.test(sub)) {
    const index = Number.parseInt(sub, 10) - 1;
    return index < 0 ? { kind: 'invalid', input: args } : { kind: 'select', index };
  }
  return { kind: 'invalid', input: args };
}

export function formatTabList(views: readonly SessionTabView[], activeIndex: number): string {
  if (views.length === 0) return 'No tabs open.';
  const lines = views.map((view, index) => {
    const marker = index === activeIndex ? '▸' : ' ';
    return `${marker} ${formatSessionTabLabel(index, view)}`;
  });
  return [`Tabs (${String(views.length)}):`, ...lines].join('\n');
}

export async function handleTabCommand(host: SlashCommandHost, args: string): Promise<void> {
  const action = parseTabCommand(args);
  switch (action.kind) {
    case 'list':
      host.showStatus(formatTabList(host.tabViews(), host.tabs.activeTabIndex));
      return;
    case 'new':
      await host.createNewSession('tab');
      return;
    case 'next':
      await host.switchTab(1);
      return;
    case 'prev':
      await host.switchTab(-1);
      return;
    case 'select':
      await host.activateTabAt(action.index);
      return;
    case 'close': {
      if (action.index === undefined) {
        await host.closeActiveTab({ force: action.force });
        return;
      }
      const tab = host.tabs.at(action.index);
      if (tab === undefined) {
        host.showError(`No tab ${String(action.index + 1)}.`);
        return;
      }
      await host.closeTab(tab, { force: action.force });
      return;
    }
    case 'invalid':
      host.showError(TAB_COMMAND_USAGE);
      return;
  }
}
