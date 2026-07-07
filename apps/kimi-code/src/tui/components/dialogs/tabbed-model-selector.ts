/**
 * TabbedModelSelectorComponent — a thin wrapper around ModelSelectorComponent
 * that splits the model list into per-provider tabs.
 *
 * Tabs are derived from the `models` passed at construction time:
 *   ['all', ...uniqueProviderIds]   (insertion order, deduplicated)
 *
 * Each tab owns its own inner ModelSelectorComponent built from the filtered
 * subset of models. ↑/↓/Enter/Esc/←/→ (thinking) and typing (filter) are
 * forwarded to the active inner selector; Tab / Shift-Tab cycle between tabs.
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

export interface TabbedModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingEffort: string;
  /** When set, the tab for this provider id is initially active instead of the
   * tab derived from `currentValue`. */
  readonly initialTabId?: string;
  readonly onSelect: (selection: ModelSelection) => void;
  /** Forwarded to each inner selector; when set, Alt+S applies the choice to
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
  private readonly tabs: readonly ModelTab[];
  private activeIndex: number;

  constructor(opts: TabbedModelSelectorOptions) {
    super();
    this.opts = opts;
    this.tabs = buildTabs(opts);

    // Default to the "All" tab. Only an explicit initialTabId (e.g. the
    // provider just added via /provider) opens on a specific provider tab —
    // the current model is still highlighted inside whichever tab is active.
    const initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    this.activeIndex = Math.max(initialTabIdx, 0);
    this.syncFocusToActive();
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
    // Layout: divider, title, hint, blank, tab strip, blank, then the model
    // list. The inner selector's blank line (inner[3]) separates the hint from
    // the tab strip; an extra blank separates the tabs from their list.
    const stripLine = renderTabStrip({
      labels: this.tabs.map((tab) => tab.label),
      activeIndex: this.activeIndex,
      width,
      colors: currentTheme.palette,
    });
    const out: string[] = [
      inner[0] ?? '',
      inner[1] ?? '',
      inner[2] ?? '',
      inner[3] ?? '',
      stripLine,
      '',
    ];
    for (let i = 4; i < inner.length; i++) out.push(inner[i]!);
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

function buildTabs(opts: TabbedModelSelectorOptions): readonly ModelTab[] {
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

  const tabs: ModelTab[] = [
    {
      id: ALL_TAB_ID,
      label: ALL_TAB_LABEL,
      selector: makeSelector(opts, opts.models),
    },
  ];
  for (const providerId of providerIds) {
    const subset: Record<string, ModelAlias> = {};
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model;
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      selector: makeSelector(opts, subset),
    });
  }
  return tabs;
}

function makeSelector(
  opts: TabbedModelSelectorOptions,
  subset: Record<string, ModelAlias>,
): ModelSelectorComponent {
  const candidate = opts.selectedValue ?? opts.currentValue;
  const selectedValue = subset[candidate] !== undefined ? candidate : undefined;
  const inner: ModelSelectorOptions = {
    models: subset,
    currentValue: opts.currentValue,
    ...(selectedValue !== undefined ? { selectedValue } : {}),
    currentThinkingEffort: opts.currentThinkingEffort,
    searchable: true,
    providerSwitchHint: true,
    onSelect: opts.onSelect,
    onSessionOnlySelect: opts.onSessionOnlySelect,
    onCancel: opts.onCancel,
  };
  return new ModelSelectorComponent(inner);
}
