import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Key,
  matchesKey,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { currentTheme } from '#/tui/theme';
import { focusOnUnfocusedMouse, handleSegmentedMouse } from '#/tui/utils/mouse-hit-test';
import { layoutTabStrip, type TabStripHitRange } from '#/tui/utils/tab-strip';

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
  readonly title?: string;
  readonly initialTabId?: string;
  readonly layout?: DockLayout;
  readonly warning?: string;
  readonly thinkingControl?: boolean;
  readonly effortDescriptions?: Readonly<Record<string, string>>;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

interface ModelTab {
  readonly id: string;
  readonly label: string;
  readonly selector: ModelSelectorComponent;
}

export class TabbedModelSelectorComponent extends DockSection implements Focusable {
  private _focused = false;
  private readonly tabs: readonly ModelTab[];
  private activeIndex: number;
  private readonly shownAt = Date.now();
  private tabStripRow = -1;
  private tabHitRanges: readonly TabStripHitRange[] = [];

  constructor(readonly opts: TabbedModelSelectorOptions) {
    super(opts.layout);
    this.tabs = buildTabs(opts);

    const initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    this.activeIndex = Math.max(initialTabIdx, 0);
    this.syncFocusToActive();
    this.ensureActiveSelectionVisible();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocusToActive();
  }

  handleInput(data: string): void {
    if (this.tabs.length > 1) {
      if (matchesKey(data, Key.tab)) {
        this.switchToTab((this.activeIndex + 1) % this.tabs.length);
        return;
      }
      if (matchesKey(data, Key.shift('tab'))) {
        this.switchToTab((this.activeIndex - 1 + this.tabs.length) % this.tabs.length);
        return;
      }
    }
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return;
    active.selector.handleInput(data);
    this.ensureActiveSelectionVisible();
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedMouse(event);
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return undefined;

    if (this.layout === undefined && event.type === 'wheel') {
      return active.selector.handleWheelPaging(event);
    }

    if (part === 'head') {
      if (this.tabs.length <= 1) return undefined;
      if (event.type === 'wheel' && event.y === this.tabStripRow && event.wheelDelta !== undefined) {
        if (event.wheelDelta === 0) return { handled: true };
        const next =
          (this.activeIndex + (event.wheelDelta > 0 ? 1 : -1) + this.tabs.length) %
          this.tabs.length;
        if (next === this.activeIndex) return { handled: true, render: false };
        this.switchToTab(next);
        return { handled: true, render: true };
      }
      return handleSegmentedMouse({
        event,
        focused: this.focused,
        shownAt: this.shownAt,
        row: this.tabStripRow,
        regions: this.tabHitRanges,
        select: (index) => {
          if (index === this.activeIndex) return false;
          this.switchToTab(index);
          return true;
        },
      });
    }

    if (part === 'body') {
      return active.selector.handleBodyMouse(event, this.focused, this.shownAt);
    }

    if (part === 'foot') {
      return active.selector.handleFootMouse(event, this.focused, this.shownAt);
    }

    return undefined;
  }

  protected renderPart(part: DockPart, width: number): string[] {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return [];
    const unpaged = this.layout !== undefined;

    switch (part) {
      case 'head': {
        if (this.tabs.length <= 1) {
          this.tabStripRow = -1;
          this.tabHitRanges = [];
          return active.selector.renderHeadLines(width);
        }
        const strip = layoutTabStrip({
          labels: this.tabs.map((tab) => tab.label),
          activeIndex: this.activeIndex,
          width,
          colors: currentTheme.palette,
        });
        const baseHead = active.selector.renderHeadLines(width, [strip.line, '']);
        this.tabStripRow = baseHead.length - (active.selector.hasSearchQuery() ? 3 : 2);
        this.tabHitRanges = strip.hitRanges;
        return baseHead;
      }
      case 'body':
        return active.selector.renderBodyLines(width, unpaged);
      case 'foot':
        return active.selector.renderFootLines(width, unpaged);
    }
  }

  override invalidate(): void {
    super.invalidate();
    for (const tab of this.tabs) {
      tab.selector.invalidate();
    }
  }

  private switchToTab(nextIndex: number): void {
    this.activeIndex = nextIndex;
    this.syncFocusToActive();
    this.scrollBodyToTop();
    this.ensureActiveSelectionVisible();
  }

  private ensureActiveSelectionVisible(): void {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return;
    const idx = active.selector.selectedRowIndex();
    this.ensureBodyVisible(idx, idx + 1);
  }

  private syncFocusToActive(): void {
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i]!;
      tab.selector.focused = this._focused && i === this.activeIndex;
    }
  }
}

function buildTabs(opts: TabbedModelSelectorOptions): readonly ModelTab[] {
  const entries = Object.entries(opts.models);
  const minBodyRows =
    opts.layout !== undefined ? Math.min(opts.layout.maxBodyRows, entries.length) : undefined;
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
      selector: makeSelector(opts, opts.models, minBodyRows),
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
      selector: makeSelector(opts, subset, minBodyRows),
    });
  }
  return tabs;
}

function makeSelector(
  opts: TabbedModelSelectorOptions,
  subset: Record<string, ModelAlias>,
  minBodyRows: number | undefined,
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
    minBodyRows,
    providerSwitchHint: true,
    warning: opts.warning,
    thinkingControl: opts.thinkingControl,
    effortDescriptions: opts.effortDescriptions,
    onSelect: opts.onSelect,
    onSessionOnlySelect: opts.onSessionOnlySelect,
    onCancel: opts.onCancel,
  };
  return new ModelSelectorComponent(inner);
}
