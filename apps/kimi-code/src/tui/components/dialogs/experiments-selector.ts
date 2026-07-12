import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { t } from '#/i18n';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

const ELLIPSIS = '…';

export interface ExperimentalFeatureDraftChange {
  readonly id: ExperimentalFeatureState['id'];
  readonly enabled: boolean;
}

export interface ExperimentsSelectorOptions {
  readonly features: readonly ExperimentalFeatureState[];
  readonly onApply: (changes: readonly ExperimentalFeatureDraftChange[]) => void;
  readonly onCancel: () => void;
}

export class ExperimentsSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: ExperimentsSelectorOptions;
  private readonly list: SearchableList<ExperimentalFeatureState>;
  private readonly draft = new Map<ExperimentalFeatureState['id'], boolean>();

  constructor(opts: ExperimentsSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.features,
      toSearchText: (feature) => `${featureTitle(feature)} ${feature.id} ${featureDescription(feature)}`,
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
      view.query.length === 0 ? currentTheme.fg('textMuted', `  ${t('tui.dialogs.modelSelector.searchHint')}`) : '';
    const hintParts = [t('tui.dialogs.experimentsSelector.hintNavigate')];
    if (view.page.pageCount > 1) hintParts.push(t('tui.dialogs.experimentsSelector.hintPage'));
    hintParts.push(t('tui.dialogs.experimentsSelector.hintSpace'), t('tui.dialogs.experimentsSelector.hintEnter'), t('tui.dialogs.experimentsSelector.hintCancel'));
    if (view.query.length > 0) hintParts.push(t('tui.dialogs.experimentsSelector.hintBackspace'));

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${t('tui.dialogs.experimentsSelector.title')}`) + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` ${t('tui.dialogs.modelSelector.searchLabel')}`) + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   ' + t('tui.dialogs.modelSelector.noMatches')));
    }

    for (let i = view.page.start; i < view.page.end; i++) {
      const feature = view.items[i]!;
      const selected = i === view.selectedIndex;
      lines.push(...this.renderFeature(feature, selected, width));
    }

    lines.push('');
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${String(view.items.length)} / ${String(this.opts.features.length)}`,
        ),
      );
    } else if (view.page.end < view.items.length) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${t('tui.dialogs.experimentsSelector.more', { count: view.items.length - view.page.end })}`,
        ),
      );
    }
    lines.push(this.renderApplyButton());
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private toggleDraft(feature: ExperimentalFeatureState): void {
    if (isLocked(feature)) return;

    const enabled = !this.effectiveEnabled(feature);
    if (enabled === feature.enabled) {
      this.draft.delete(feature.id);
      return;
    }
    this.draft.set(feature.id, enabled);
  }

  private effectiveEnabled(feature: ExperimentalFeatureState): boolean {
    return this.draft.get(feature.id) ?? feature.enabled;
  }

  private isDraftChanged(feature: ExperimentalFeatureState): boolean {
    return this.effectiveEnabled(feature) !== feature.enabled;
  }

  private draftChanges(): ExperimentalFeatureDraftChange[] {
    const changes: ExperimentalFeatureDraftChange[] = [];
    for (const feature of this.opts.features) {
      if (this.isDraftChanged(feature)) {
        changes.push({ id: feature.id, enabled: this.effectiveEnabled(feature) });
      }
    }
    return changes;
  }

  private renderApplyButton(): string {
    const changes = this.draftChanges();
    const count = changes.length;
    const label = t('tui.dialogs.experimentsSelector.applyButton');
    const summary =
      count === 0
        ? t('tui.dialogs.experimentsSelector.noChanges')
        : t(
            count === 1
              ? 'tui.dialogs.experimentsSelector.changeCount_one'
              : 'tui.dialogs.experimentsSelector.changeCount_other',
            { count },
          );
    const button = count === 0
      ? currentTheme.fg('textDim', label)
      : currentTheme.boldFg('primary', label);
    const summaryText = count === 0
      ? currentTheme.fg('textMuted', summary)
      : currentTheme.fg('success', summary);
    return ` ${button}  ${summaryText}`;
  }

  private renderFeature(
    feature: ExperimentalFeatureState,
    selected: boolean,
    width: number,
  ): string[] {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const title = featureTitle(feature);
    const description = featureDescription(feature);
    const label = selected ? currentTheme.boldFg('primary', title) : currentTheme.fg('text', title);
    const enabled = this.effectiveEnabled(feature);
    const status = enabled ? t('tui.dialogs.experimentsSelector.statusEnabled') : t('tui.dialogs.experimentsSelector.statusDisabled');
    const statusText = enabled ? currentTheme.fg('success', status) : currentTheme.fg('textDim', status);
    const detail = this.isDraftChanged(feature)
      ? `${featureDetail(feature)}${t('tui.dialogs.experimentsSelector.modifiedSuffix')}`
      : featureDetail(feature);
    const lines = [
      `${prefix}${label}  ${statusText}`,
      currentTheme.fg('textMuted', `    ${detail}`),
    ];
    const descriptionWidth = Math.max(1, width - 4);
    for (const line of wrapText(description, descriptionWidth)) {
      lines.push(currentTheme.fg('textMuted', `    ${line}`));
    }
    return lines;
  }
}

function isLocked(feature: ExperimentalFeatureState): boolean {
  return feature.source === 'env' || feature.source === 'master-env';
}

function featureDetail(feature: ExperimentalFeatureState): string {
  const source = sourceLabel(feature);
  const idPart = t('tui.dialogs.experimentsSelector.featureId', { id: feature.id });
  if (feature.source === 'env' || feature.source === 'master-env') {
    return `${idPart} · ${source}`;
  }
  return `${idPart} · ${source} · ${feature.env}`;
}

function sourceLabel(feature: ExperimentalFeatureState): string {
  switch (feature.source) {
    case 'master-env':
      return t('tui.dialogs.experimentsSelector.lockedByMasterEnv');
    case 'env':
      return t('tui.dialogs.experimentsSelector.lockedBy', { env: feature.env });
    case 'config':
      return t('tui.dialogs.experimentsSelector.sourceConfig');
    case 'default':
      return t('tui.dialogs.experimentsSelector.sourceDefault');
  }
}

function featureTitle(feature: ExperimentalFeatureState): string {
  const key = `tui.dialogs.experimentsSelector.features.${feature.id}.title` as const;
  const translated = t(key);
  return translated === key ? feature.title : translated;
}

function featureDescription(feature: ExperimentalFeatureState): string {
  const key = `tui.dialogs.experimentsSelector.features.${feature.id}.description` as const;
  const translated = t(key);
  return translated === key ? feature.description : translated;
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
