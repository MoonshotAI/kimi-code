import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import {
  BETA_MASTER_CONFIG_KEY,
  MASTER_ENV,
  type BetaMasterSwitchState,
  type ExperimentalFeatureState,
} from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { renderSearchableListStatus, SearchableList } from '#/tui/utils/searchable-list';

const ELLIPSIS = '…';
const DEFAULT_BETA_STATE: BetaMasterSwitchState = {
  profile: 'cli',
  enabled: false,
  source: 'default',
  env: MASTER_ENV,
};

export interface ExperimentalFeatureDraftChange {
  readonly id: string;
  readonly enabled: boolean;
}

export interface ExperimentsSelectorOptions {
  readonly features: readonly ExperimentalFeatureState[];
  readonly betaState?: BetaMasterSwitchState;
  readonly onApply: (changes: readonly ExperimentalFeatureDraftChange[]) => void;
  readonly onCancel: () => void;
}

type SelectorGroup = 'beta' | 'experimental';

type SelectorItem =
  | {
      readonly kind: 'beta-master';
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly group: 'beta';
      readonly state: BetaMasterSwitchState;
    }
  | {
      readonly kind: 'feature';
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly group: SelectorGroup;
      readonly feature: ExperimentalFeatureState;
    };

export class ExperimentsSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: ExperimentsSelectorOptions;
  private readonly betaState: BetaMasterSwitchState;
  private readonly items: readonly SelectorItem[];
  private readonly list: SearchableList<SelectorItem>;
  private readonly draft = new Map<string, boolean>();

  constructor(opts: ExperimentsSelectorOptions) {
    super();
    this.opts = opts;
    this.betaState = opts.betaState ?? DEFAULT_BETA_STATE;
    const visibleFeatures = opts.features.filter((feature) => feature.stage !== 'ga');
    const betaItems: SelectorItem[] = [
      {
        kind: 'beta-master',
        id: BETA_MASTER_CONFIG_KEY,
        title: 'Enable all Beta features',
        description:
          'Try upcoming features being polished before release.',
        group: 'beta',
        state: this.betaState,
      },
      ...visibleFeatures
        .filter((feature) => feature.stage === 'beta')
        .map(
          (feature): SelectorItem => ({
            kind: 'feature',
            id: feature.id,
            title: feature.title,
            description: feature.description,
            group: 'beta',
            feature,
          }),
        ),
    ];
    const experimentalItems: SelectorItem[] = visibleFeatures
      .filter((feature) => feature.stage === 'experimental')
      .map(
        (feature): SelectorItem => ({
          kind: 'feature',
          id: feature.id,
          title: feature.title,
          description: feature.description,
          group: 'experimental',
          feature,
        }),
      );
    this.items = [...betaItems, ...experimentalItems];
    this.list = new SearchableList({
      items: this.items,
      toSearchText: (item) => `${item.title} ${item.id} ${item.description} ${item.group}`,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const changes = this.draftChanges();
      if (changes.length > 0) this.opts.onApply(changes);
      return;
    }
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      const selected = this.list.selected();
      if (selected !== undefined) this.toggleDraft(selected);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('PgUp/PgDn page');
    hintParts.push('Space toggle', 'Enter apply', 'Esc cancel');
    if (view.query.length > 0) hintParts.push('Backspace clear');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Lab') + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    lines.push(...renderSearchableListStatus(view));

    let currentGroup: SelectorGroup | undefined;
    for (let i = view.page.start; i < view.page.end; i++) {
      const item = view.items[i]!;
      if (item.group !== currentGroup) {
        if (currentGroup !== undefined) lines.push('');
        currentGroup = item.group;
        const heading = item.group === 'beta' ? ' Beta' : ' Experimental';
        lines.push(currentTheme.boldFg('textStrong', heading));
      }
      const selected = i === view.selectedIndex;
      lines.push(...this.renderItem(item, selected, width));
    }

    lines.push('');
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${String(view.items.length)} / ${String(this.items.length)}`,
        ),
      );
    } else if (view.page.end < view.items.length) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ▼ ${String(view.items.length - view.page.end)} more`,
        ),
      );
    }
    lines.push(this.renderApplyButton());
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private effectiveBetaMasterEnabled(): boolean {
    if (this.betaState.source === 'env') return true;
    return this.draft.get(BETA_MASTER_CONFIG_KEY) ?? this.betaState.enabled;
  }

  private baselineItemEnabled(item: SelectorItem): boolean {
    if (item.kind === 'beta-master') return item.state.enabled;
    const { feature } = item;
    if (feature.source === 'env') return feature.enabled;
    if (feature.stage === 'beta' && this.effectiveBetaMasterEnabled()) return true;
    if (feature.configValue !== undefined) return feature.configValue;
    if (feature.source === 'master-env' || feature.source === 'beta-config') return false;
    return feature.enabled;
  }

  private isItemLocked(item: SelectorItem): boolean {
    if (item.kind === 'beta-master') return item.state.source === 'env';
    if (item.feature.source === 'env') return true;
    if (item.feature.stage === 'beta' && this.effectiveBetaMasterEnabled()) return true;
    return false;
  }

  private toggleDraft(item: SelectorItem): void {
    if (this.isItemLocked(item)) return;
    const next = !this.effectiveItemEnabled(item);
    const initial =
      item.kind === 'beta-master'
        ? item.state.enabled
        : (item.feature.configValue ??
          (item.feature.source === 'master-env' || item.feature.source === 'beta-config'
            ? false
            : item.feature.enabled));
    if (next === initial) {
      this.draft.delete(item.id);
      return;
    }
    this.draft.set(item.id, next);
  }

  private effectiveItemEnabled(item: SelectorItem): boolean {
    if (item.kind === 'beta-master') return this.effectiveBetaMasterEnabled();
    if (item.feature.source === 'env') return item.feature.enabled;
    if (item.feature.stage === 'beta' && this.effectiveBetaMasterEnabled()) return true;
    if (this.draft.has(item.id)) return this.draft.get(item.id)!;
    return this.baselineItemEnabled(item);
  }

  private isDraftChanged(item: SelectorItem): boolean {
    if (this.isItemLocked(item)) return false;
    return this.draft.has(item.id);
  }

  private draftChanges(): ExperimentalFeatureDraftChange[] {
    const changes: ExperimentalFeatureDraftChange[] = [];
    for (const item of this.items) {
      if (this.isDraftChanged(item)) {
        changes.push({ id: item.id, enabled: this.draft.get(item.id)! });
      }
    }
    return changes;
  }

  private renderApplyButton(): string {
    const changes = this.draftChanges();
    const count = changes.length;
    const label = '[ Apply changes and reload ]';
    const summary =
      count === 0 ? 'no changes' : `${String(count)} ${count === 1 ? 'change' : 'changes'}`;
    const button =
      count === 0
        ? currentTheme.fg('textDim', label)
        : currentTheme.boldFg('primary', label);
    const summaryText =
      count === 0 ? currentTheme.fg('textMuted', summary) : currentTheme.fg('success', summary);
    return ` ${button}  ${summaryText}`;
  }

  private renderItem(item: SelectorItem, selected: boolean, width: number): string[] {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = selected
      ? currentTheme.boldFg('primary', item.title)
      : currentTheme.fg('text', item.title);
    const enabled = this.effectiveItemEnabled(item);
    const status = enabled ? 'enabled' : 'disabled';
    const statusText = enabled
      ? currentTheme.fg('success', status)
      : currentTheme.fg('textDim', status);
    const baseDetail = this.itemDetail(item);
    const detail = this.isDraftChanged(item) ? `${baseDetail} · modified` : baseDetail;
    const lines = [
      `${prefix}${label}  ${statusText}`,
      currentTheme.fg('textMuted', `    ${detail}`),
    ];
    const descriptionWidth = Math.max(1, width - 4);
    for (const line of wrapText(item.description, descriptionWidth)) {
      lines.push(currentTheme.fg('textMuted', `    ${line}`));
    }
    return lines;
  }

  private itemDetail(item: SelectorItem): string {
    if (item.kind === 'beta-master') {
      if (item.state.source === 'env') {
        return `id ${item.id} · locked by ${item.state.env}`;
      }
      return `id ${item.id} · ${item.state.source} · ${item.state.env}`;
    }
    const { feature } = item;
    const timingSuffix = effectTimingLabel(feature.effectTiming);
    if (feature.source === 'env') {
      return `id ${feature.id} · locked by ${feature.env}${timingSuffix}`;
    }
    if (feature.stage === 'beta' && this.effectiveBetaMasterEnabled()) {
      const lockLabel =
        this.betaState.source === 'env'
          ? `locked by ${this.betaState.env}`
          : 'locked by Enable all Beta features';
      return `id ${feature.id} · ${lockLabel}${timingSuffix}`;
    }
    const baseSource = feature.configValue !== undefined ? 'config' : 'default';
    return `id ${feature.id} · ${baseSource} · ${feature.env}${timingSuffix}`;
  }
}

function effectTimingLabel(timing: ExperimentalFeatureState['effectTiming']): string {
  switch (timing) {
    case 'immediate':
      return '';
    case 'next-session':
      return ' · new sessions';
    case 'restart':
      return ' · restart required';
  }
}

function wrapText(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
