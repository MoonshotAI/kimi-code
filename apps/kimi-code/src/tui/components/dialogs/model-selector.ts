import { effectiveModelAlias, type ModelAlias, type ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import {
  DockSection,
  finishDialogLines,
  type DockLayout,
  type DockPart,
} from '#/tui/components/chrome/dock-section';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedMouse,
  handleSearchableListMouse,
  handleSearchableListWheel,
  handleSegmentedMouse,
  type MouseColRegion,
  type MouseRowRegion,
} from '#/tui/utils/mouse-hit-test';
import { SearchableList } from '#/tui/utils/searchable-list';

import type { ChoiceOption } from './choice-picker';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  readonly name: string;
  readonly provider: string;
  readonly label: string;
}

export interface ModelSelection {
  readonly alias: string;
  readonly thinking: ThinkingEffort;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? alias;
}

export type ProviderNames = Readonly<Record<string, { readonly displayName?: string }>>;

export function providerDisplayName(provider: string, providers?: ProviderNames): string {
  const displayName = providers?.[provider]?.displayName;
  if (displayName !== undefined && displayName !== '') return displayName;
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
  providers?: ProviderNames,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg);
    return {
      value: alias,
      label: `${modelDisplayName(alias, effective)} (${providerDisplayName(effective.provider, providers)})`,
    };
  });
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly providers?: ProviderNames;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingEffort: ThinkingEffort;
  readonly title?: string;
  readonly searchable?: boolean;
  readonly pageSize?: number;
  readonly layout?: DockLayout;
  readonly minBodyRows?: number;
  readonly providerSwitchHint?: boolean;
  readonly warning?: string;
  readonly thinkingControl?: boolean;
  readonly effortDescriptions?: Readonly<Record<string, string>>;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

function createModelChoices(models: Record<string, ModelAlias>, providers?: ProviderNames): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg);
    const name = modelDisplayName(alias, effective);
    const provider = providerDisplayName(effective.provider, providers);
    return { alias, model: effective, name, provider, label: `${name} (${provider})` };
  });
}

export function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

export function effortsOf(model: ModelAlias): readonly string[] {
  return model.supportEfforts ?? [];
}

export function segmentsFor(model: ModelAlias): readonly string[] {
  const efforts = effortsOf(model);
  const availability = thinkingAvailability(model);
  if (efforts.length > 0) {
    return availability === 'always-on' ? efforts : ['off', ...efforts];
  }
  if (availability === 'always-on') return ['on'];
  if (availability === 'unsupported') return ['off'];
  return ['on', 'off'];
}

export function effortLabel(effort: string): string {
  if (effort.length === 0) return effort;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function defaultThinkingEffortFor(model: ModelAlias): ThinkingEffort {
  if (thinkingAvailability(model) === 'unsupported') return 'off';
  const efforts = effortsOf(model);
  if (efforts.length > 0) {
    return model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

function commitEffort(choice: ModelChoice, draft: ThinkingEffort): ThinkingEffort {
  if (draft === 'on') return defaultThinkingEffortFor(choice.model);
  return draft;
}

export class ModelSelectorComponent extends DockSection implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  private readonly thinkingOverrides = new Map<string, string>();
  private readonly minBodyRows: number;
  private readonly shownAt = Date.now();
  private choiceRegions: readonly MouseRowRegion[] = [];
  private thinkingRow = -1;
  private thinkingRegions: readonly MouseColRegion[] = [];

  constructor(opts: ModelSelectorOptions) {
    super(opts.layout);
    this.opts = opts;
    const choices = createModelChoices(opts.models, opts.providers);
    this.minBodyRows =
      opts.minBodyRows ??
      (opts.layout !== undefined ? Math.min(opts.layout.maxBodyRows, choices.length) : 0);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    const initialIndex = Math.max(selectedIdx, 0);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex,
      searchable: opts.searchable === true,
    });
    this.ensureBodyVisible(initialIndex, initialIndex + 1);
  }

  selectedRowIndex(): number {
    return this.list.view().selectedIndex;
  }

  hasSearchQuery(): boolean {
    return this.opts.searchable === true && this.list.view().query.length > 0;
  }

  private draftFor(choice: ModelChoice): string {
    const override = this.thinkingOverrides.get(choice.alias);
    if (override !== undefined) return override;
    if (choice.alias === this.opts.currentValue) return this.opts.currentThinkingEffort;
    const efforts = effortsOf(choice.model);
    if (efforts.length > 0) {
      const def = choice.model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)];
      if (def !== undefined && efforts.includes(def)) return def;
      return efforts[0]!;
    }
    return thinkingAvailability(choice.model) !== 'unsupported' ? 'on' : 'off';
  }

  private effectiveEffort(choice: ModelChoice): string {
    const draft = this.draftFor(choice);
    const segments = segmentsFor(choice.model);
    return segments.includes(draft) ? draft : segments[0]!;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) {
        const idx = this.selectedRowIndex();
        this.ensureBodyVisible(idx, idx + 1);
        return;
      }
      this.opts.onCancel();
      return;
    }

    if (this.list.handleKey(data)) {
      const idx = this.selectedRowIndex();
      this.ensureBodyVisible(idx, idx + 1);
      return;
    }

    if (
      this.opts.thinkingControl !== false &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.right))
    ) {
      const selected = this.selectedChoice();
      if (selected !== undefined) {
        const segments = segmentsFor(selected.model);
        if (segments.length > 1) {
          const current = this.effectiveEffort(selected);
          const idx = segments.indexOf(current);
          let next: number;
          if (segments.length === 2) {
            next = idx === 0 ? 1 : 0;
          } else {
            const delta = matchesKey(data, Key.left) ? -1 : 1;
            next = Math.max(0, Math.min(segments.length - 1, idx + delta));
          }
          if (next !== idx) {
            this.thinkingOverrides.set(selected.alias, segments[next]!);
          }
        }
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedChoice();
      if (selected === undefined) return;
      this.commitChoice(selected, false);
      return;
    }

    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      const selected = this.selectedChoice();
      if (selected === undefined) return;
      this.commitChoice(selected, true);
    }
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedMouse(event);
    if (this.layout === undefined && event.type === 'wheel') {
      return this.handleWheelPaging(event);
    }
    if (part === 'body') {
      return this.handleBodyMouse(event, this.focused, this.shownAt);
    }
    if (part === 'foot') {
      return this.handleFootMouse(event, this.focused, this.shownAt);
    }
    return undefined;
  }

  handleWheelPaging(event: TuiMouseEvent): TuiMouseEventResult {
    return handleSearchableListWheel(this.list, event);
  }

  handleBodyMouse(
    event: TuiMouseEvent,
    focused: boolean,
    shownAt: number,
  ): TuiMouseEventResult | undefined {
    return handleSearchableListMouse(this.list, {
      event,
      focused,
      shownAt,
      regions: this.choiceRegions,
      activate: (choice, clickEvent) => {
        this.commitChoice(choice, clickEvent.alt);
      },
    });
  }

  handleFootMouse(
    event: TuiMouseEvent,
    focused: boolean,
    shownAt: number,
  ): TuiMouseEventResult | undefined {
    if (this.opts.thinkingControl === false || this.thinkingRegions.length === 0) {
      return undefined;
    }
    const selected = this.selectedChoice();
    if (selected === undefined) return undefined;
    const segments = segmentsFor(selected.model);
    if (segments.length <= 1) return undefined;

    return handleSegmentedMouse({
      event,
      focused,
      shownAt,
      row: this.thinkingRow,
      regions: this.thinkingRegions,
      select: (index) => {
        const target = segments[index];
        if (target === undefined) return false;
        const previous = this.effectiveEffort(selected);
        if (previous === target) return false;
        this.thinkingOverrides.set(selected.alias, target);
        return true;
      },
    });
  }

  protected renderPart(part: DockPart, width: number): string[] {
    const unpaged = this.layout !== undefined;
    switch (part) {
      case 'head':
        return this.renderHeadLines(width);
      case 'body':
        return this.renderBodyLines(width, unpaged);
      case 'foot':
        return this.renderFootLines(width, unpaged);
    }
  }

  renderHeadLines(width: number, extraBelowHeader?: readonly string[]): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();

    const titleSuffix =
      searchable && view.query.length === 0
        ? currentTheme.fg('textMuted', '  (type to search)')
        : '';

    const hintParts: string[] = [];
    if (this.opts.providerSwitchHint) hintParts.push('Tab toggle provider');
    hintParts.push('↑↓ navigate');
    if (searchable && view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select');
    if (this.opts.onSessionOnlySelect !== undefined) hintParts.push('Alt+S session-only');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', this.opts.title ?? ' Select a model') + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
    ];
    if (this.opts.warning !== undefined) {
      for (const line of wrapTextWithAnsi(this.opts.warning, Math.max(1, width - 1))) {
        lines.push(currentTheme.fg('warning', ` ${line}`));
      }
    }
    lines.push('');
    if (extraBelowHeader !== undefined) {
      lines.push(...extraBelowHeader);
    }
    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }
    return finishDialogLines(lines, width, this.focused);
  }

  renderBodyLines(width: number, unpaged: boolean): string[] {
    const view = this.list.view();
    if (view.items.length === 0) {
      this.choiceRegions = [];
      const emptyLines = [currentTheme.fg('textMuted', '   No matches')];
      if (unpaged) {
        while (emptyLines.length < this.minBodyRows) emptyLines.push('');
      }
      return finishDialogLines(emptyLines, width, this.focused);
    }

    const start = unpaged ? 0 : view.page.start;
    const end = unpaged ? view.items.length : view.page.end;

    const nameCap = Math.max(8, Math.floor(width * 0.5));
    let nameWidth = 0;
    for (let i = start; i < end; i++) {
      const choice = view.items[i];
      if (choice !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(choice.name));
    }
    nameWidth = Math.min(nameWidth, nameCap);

    const lines: string[] = [];
    const regions: MouseRowRegion[] = [];
    for (let i = start; i < end; i++) {
      const choice = view.items[i];
      if (choice === undefined) continue;
      const row = lines.length;
      const isSelected = i === view.selectedIndex;
      const isCurrent = choice.alias === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
      const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line +=
        (isSelected
          ? currentTheme.boldFg('primary', truncatedName)
          : currentTheme.fg('text', truncatedName)) + namePad;
      line += '  ' + currentTheme.fg('textMuted', choice.provider);
      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', CURRENT_MARK);
      }
      lines.push(line);
      regions.push({ start: row, end: lines.length, index: i });
    }
    this.choiceRegions = regions;
    if (unpaged) {
      while (lines.length < this.minBodyRows) lines.push('');
    }
    return finishDialogLines(lines, width, this.focused);
  }

  renderFootLines(width: number, unpaged: boolean): string[] {
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;
    const lines: string[] = [];

    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalCount)}`),
      );
    } else if (!unpaged) {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    const selected = this.selectedChoice();
    if (selected !== undefined && this.opts.thinkingControl !== false) {
      const canSwitch = segmentsFor(selected.model).length > 1;
      const thinkingHeader = canSwitch ? ' Thinking  (←→ to switch)' : ' Thinking';
      lines.push(currentTheme.fg('textMuted', thinkingHeader));
      const { line: controlLine, regions } = this.renderThinkingControl(selected);
      this.thinkingRow = canSwitch ? lines.length : -1;
      this.thinkingRegions = canSwitch ? regions : [];
      lines.push(controlLine);
      if (this.hasEffortDescriptions()) {
        const description =
          selected.model.provider === DEFAULT_OAUTH_PROVIDER_NAME
            ? this.opts.effortDescriptions?.[this.effectiveEffort(selected)]
            : undefined;
        lines.push(
          description !== undefined && description.length > 0
            ? currentTheme.fg('textMuted', ` ${description}`)
            : '',
        );
      }
      lines.push('');
    } else {
      this.thinkingRow = -1;
      this.thinkingRegions = [];
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return finishDialogLines(lines, width, this.focused);
  }

  private hasEffortDescriptions(): boolean {
    return (
      this.opts.effortDescriptions !== undefined &&
      Object.keys(this.opts.effortDescriptions).length > 0
    );
  }

  private commitChoice(choice: ModelChoice, sessionOnly: boolean): void {
    const payload: ModelSelection = {
      alias: choice.alias,
      thinking: commitEffort(choice, this.effectiveEffort(choice)),
    };
    if (sessionOnly && this.opts.onSessionOnlySelect !== undefined) {
      this.opts.onSessionOnlySelect(payload);
      return;
    }
    this.opts.onSelect(payload);
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  private renderThinkingControl(choice: ModelChoice): {
    readonly line: string;
    readonly regions: readonly MouseColRegion[];
  } {
    const segment = (label: string, active: boolean): string =>
      active
        ? currentTheme.boldFg('primary', `[ ${label} ]`)
        : currentTheme.fg('text', `  ${label}  `);
    const unavailable = (label: string): string =>
      currentTheme.fg('textMuted', `  ${label} (Unsupported)  `);

    const efforts = effortsOf(choice.model);
    const availability = thinkingAvailability(choice.model);
    if (efforts.length === 0 && availability === 'always-on') {
      return { line: `  ${segment('On', true)} ${unavailable('Off')}`, regions: [] };
    }
    if (efforts.length === 0 && availability === 'unsupported') {
      return { line: `  ${unavailable('On')} ${segment('Off', true)}`, regions: [] };
    }

    const segments = segmentsFor(choice.model);
    const active = this.effectiveEffort(choice);
    const regions: MouseColRegion[] = [];
    let col = 2;
    const rendered = segments.map((effort, index) => {
      const label = effortLabel(effort);
      const isActive = effort === active;
      const rawText = isActive ? `[ ${label} ]` : `  ${label}  `;
      const segWidth = visibleWidth(rawText);
      regions.push({ start: col, end: col + segWidth, index });
      col += segWidth + 2;
      return segment(label, isActive);
    });
    return { line: `  ${rendered.join('  ')}`, regions };
  }
}
