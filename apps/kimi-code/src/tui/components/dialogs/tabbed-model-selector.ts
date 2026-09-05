/**
 * TabbedModelSelectorComponent — a thin wrapper around ModelSelectorComponent
 * that splits the model list into per-provider tabs.
 *
 * Tabs are derived from the `models` passed at construction time:
 *   ['all', ...uniqueProviderIds]   (insertion order, deduplicated)
 *
 * When `favoriteAliases` is provided (the `/model` picker does this), a
 * `favorites` tab is prepended before `all`; it lists only available models
 * whose alias is a favorite, in the favorites array order (add-order), so the
 * Alt+M rotation order and the tab order agree. The tab is opt-in: pickers
 * that don't pass favorites (visual / compaction / substitute / secondary)
 * keep the plain `all` + provider layout.
 *
 * Each tab owns its own inner ModelSelectorComponent built from the filtered
 * subset of models. ↑/↓/Enter/Esc/←/→ (thinking) and typing (filter) are
 * forwarded to the active inner selector; Tab / Shift-Tab cycle between tabs.
 * Shift+A adds the highlighted model to Favorites and Shift+R removes it in
 * every tab, live-refreshing the tab layout via {@link setFavoriteAliases}.
 *
 * The active tab is highlighted with a filled background (matching the
 * AskUserQuestion dialog's tab strip) — see .agents/skills/write-tui/DESIGN.md.
 */

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { renderTabStrip } from '#/tui/utils/tab-strip';

import {
  ModelSelectorComponent,
  providerDisplayName,
  type ModelSelection,
  type ModelSelectorOptions,
} from './model-selector';

const ALL_TAB_ID = 'all';
const ALL_TAB_LABEL = 'All';
const FAVORITES_TAB_ID = 'favorites';
const FAVORITES_TAB_LABEL = 'Favorites';
const FAVORITES_EMPTY_MESSAGE =
  'No favorites yet — highlight a model and press Shift+A to add it';

export interface TabbedModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingEffort: string;
  /** Forwarded to each inner selector; overrides the default ' Select a model'
   * title line. */
  readonly title?: string;
  /** When set, the tab for this provider id is initially active instead of the
   * tab derived from `currentValue`. */
  readonly initialTabId?: string;
  /** When set, warning-colored lines are rendered directly below the key-hint
   * line, wrapping as needed (e.g. the mid-conversation switch cost notice). */
  readonly warning?: string;
  /** Forwarded to each inner selector; set to false to hide the Thinking
   * footer and disable ←/→ effort switching. */
  readonly thinkingControl?: boolean;
  /** Favorite aliases (add-order). When provided, a Favorites tab is prepended
   * and every list row carries a ★ for favorited models. */
  readonly favoriteAliases?: readonly string[];
  /** When set, Shift+A adds the highlighted model to Favorites and Shift+R
   * removes it inside any tab; the host persists the change and calls
   * {@link setFavoriteAliases} to refresh the layout live. */
  readonly onToggleFavorite?: (alias: string) => void;
  readonly onSelect: (selection: ModelSelection) => void;
  /** Forwarded to each inner selector; when set, Shift+S applies the choice to
   * the current session only without persisting it as the default. */
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

interface ModelTab {
  readonly id: string;
  readonly label: string;
  readonly selector: ModelSelectorComponent;
}

export class TabbedModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TabbedModelSelectorOptions;
  private tabs: readonly ModelTab[];
  private activeIndex: number;
  private favoriteAliases: readonly string[];

  constructor(opts: TabbedModelSelectorOptions) {
    super();
    this.opts = opts;
    this.favoriteAliases = opts.favoriteAliases ?? [];
    this.tabs = buildTabs(opts, this.favoriteAliases);

    // Default to the "All" tab. Only an explicit initialTabId (e.g. the
    // provider just added via /provider) opens on a specific provider tab —
    // the current model is still highlighted inside whichever tab is active.
    // With usable favorites present, the picker opens on the Favorites tab
    // instead: the curated list is the whole point of having it.
    let initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    if (initialTabIdx === -1) {
      initialTabIdx = defaultTabIndex(opts, this.favoriteAliases, this.tabs);
    }
    this.activeIndex = Math.max(initialTabIdx, 0);
    this.syncFocusToActive();
  }

  /**
   * Live-refresh the favorites: rebuilds the tab layout (Favorites membership
   * and every tab's ★ markers) while preserving the active tab. When the
   * active tab is Favorites and it becomes empty, the empty-state hint stays
   * in place — the tab itself is never removed while favorites are enabled.
   */
  setFavoriteAliases(favorites: readonly string[]): void {
    const activeId = this.tabs[this.activeIndex]?.id;
    this.favoriteAliases = favorites;
    this.tabs = buildTabs(this.opts, favorites);
    const nextIndex = this.tabs.findIndex((tab) => tab.id === activeId);
    this.activeIndex = nextIndex === -1 ? Math.max(defaultTabIndex(this.opts, favorites, this.tabs), 0) : nextIndex;
    this.syncFocusToActive();
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.tabs.length > 1) {
      if (matchesKey(data, Key.tab)) {
        this.activeIndex = (this.activeIndex + 1) % this.tabs.length;
        this.syncFocusToActive();
        return;
      }
      if (matchesKey(data, Key.shift('tab'))) {
        this.activeIndex = (this.activeIndex - 1 + this.tabs.length) % this.tabs.length;
        this.syncFocusToActive();
        return;
      }
    }
    this.tabs[this.activeIndex]?.selector.handleInput(data);
  }

  override render(width: number): string[] {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return [];
    const inner = active.selector.render(width);
    if (this.tabs.length <= 1) {
      return inner.map((line) => truncateToWidth(line, width));
    }
    // Layout: divider, title, hint, optional warning, blank, tab strip, blank,
    // then the model list. The header ends at its first blank line — keep that
    // blank above the strip, and separate the tabs from the list with another
    // blank.
    const stripLine = renderTabStrip({
      labels: this.tabs.map((tab) => tab.label),
      activeIndex: this.activeIndex,
      width,
      colors: currentTheme.palette,
    });
    const headerEnd = inner.findIndex((line) => line === '');
    const splitAt = headerEnd === -1 ? 3 : headerEnd;
    const out: string[] = [...inner.slice(0, splitAt + 1), stripLine, ''];
    for (let i = splitAt + 1; i < inner.length; i++) out.push(inner[i]!);
    return out.map((line) => truncateToWidth(line, width));
  }

  override invalidate(): void {
    super.invalidate();
    for (const tab of this.tabs) {
      tab.selector.invalidate();
    }
  }

  private syncFocusToActive(): void {
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i]!;
      tab.selector.focused = this.focused && i === this.activeIndex;
    }
  }
}

/** Favorites that still resolve in the available model catalog, in add-order. */
function usableFavorites(
  favorites: readonly string[],
  models: Record<string, ModelAlias>,
): readonly string[] {
  return favorites.filter((alias) => models[alias] !== undefined);
}

/** Index of the tab the picker should open on: Favorites when it has usable
 * entries (favorites enabled), else All. */
function defaultTabIndex(
  opts: TabbedModelSelectorOptions,
  favorites: readonly string[],
  tabs: readonly ModelTab[],
): number {
  if (opts.favoriteAliases !== undefined && usableFavorites(favorites, opts.models).length > 0) {
    const idx = tabs.findIndex((tab) => tab.id === FAVORITES_TAB_ID);
    if (idx !== -1) return idx;
  }
  return tabs.findIndex((tab) => tab.id === ALL_TAB_ID);
}

function buildTabs(
  opts: TabbedModelSelectorOptions,
  favorites: readonly string[],
): readonly ModelTab[] {
  const entries = Object.entries(opts.models);
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const [, model] of entries) {
    const provider = model.provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      providerIds.push(provider);
    }
  }

  const favoriteSet = new Set(favorites);
  const tabs: ModelTab[] = [];

  if (opts.favoriteAliases !== undefined) {
    // Favorites first, in add-order (only models still present in the catalog;
    // stale entries are retained in tui.toml but hidden here).
    const subset: Record<string, ModelAlias> = {};
    for (const alias of favorites) {
      const model = opts.models[alias];
      if (model !== undefined) subset[alias] = model;
    }
    tabs.push({
      id: FAVORITES_TAB_ID,
      label: FAVORITES_TAB_LABEL,
      selector: makeSelector(opts, subset, favoriteSet, FAVORITES_EMPTY_MESSAGE),
    });
  }

  tabs.push({
    id: ALL_TAB_ID,
    label: ALL_TAB_LABEL,
    selector: makeSelector(opts, opts.models, favoriteSet),
  });
  for (const providerId of providerIds) {
    const subset: Record<string, ModelAlias> = {};
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model;
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      selector: makeSelector(opts, subset, favoriteSet),
    });
  }
  return tabs;
}

function makeSelector(
  opts: TabbedModelSelectorOptions,
  subset: Record<string, ModelAlias>,
  favoriteSet: ReadonlySet<string>,
  emptyMessage?: string,
): ModelSelectorComponent {
  const candidate = opts.selectedValue ?? opts.currentValue;
  const selectedValue = subset[candidate] !== undefined ? candidate : undefined;
  const inner: ModelSelectorOptions = {
    models: subset,
    currentValue: opts.currentValue,
    ...(selectedValue !== undefined ? { selectedValue } : {}),
    currentThinkingEffort: opts.currentThinkingEffort,
    title: opts.title,
    searchable: true,
    providerSwitchHint: true,
    warning: opts.warning,
    thinkingControl: opts.thinkingControl,
    favoriteAliases: favoriteSet,
    ...(emptyMessage !== undefined ? { emptyMessage } : {}),
    ...(opts.onToggleFavorite !== undefined ? { onToggleFavorite: opts.onToggleFavorite } : {}),
    onSelect: opts.onSelect,
    onSessionOnlySelect: opts.onSessionOnlySelect,
    onCancel: opts.onCancel,
  };
  return new ModelSelectorComponent(inner);
}
