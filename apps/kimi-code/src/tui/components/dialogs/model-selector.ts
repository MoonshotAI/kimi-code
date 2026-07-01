import { effectiveModelAlias, type ModelAlias, type ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

import type { ChoiceOption } from './choice-picker';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  /** Model display name (left column). */
  readonly name: string;
  /** Provider display name (right column). */
  readonly provider: string;
  /** Combined text the fuzzy filter matches against (name + provider). */
  readonly label: string;
}

export interface ModelSelection {
  readonly alias: string;
  /** Chosen thinking effort: 'off', or a concrete effort such as 'low' /
   * 'high' / 'max'. Boolean 'on' is normalized to the model's default effort
   * before the selection is committed (see commitEffort). */
  readonly thinking: ThinkingEffort;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg);
    return {
      value: alias,
      label: `${modelDisplayName(alias, effective)} (${providerDisplayName(effective.provider)})`,
    };
  });
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  /** Live thinking effort of the currently active model (e.g. 'off', 'on',
   * 'high'). Used to highlight the active segment for the current model. */
  readonly currentThinkingEffort: ThinkingEffort;
  /** When true, typed characters filter the list (fuzzy) and a search line is shown. */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate (PgUp/PgDn). */
  readonly pageSize?: number;
  /** When true, the hint line mentions the Tab provider switch — set by
   * TabbedModelSelectorComponent so the inner list advertises the tab keys. */
  readonly providerSwitchHint?: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  /** When provided, Alt+S invokes this instead of onSelect — used to apply the
   * choice to the current session only, without persisting it as the default. */
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const effective = effectiveModelAlias(cfg);
    const name = modelDisplayName(alias, effective);
    const provider = providerDisplayName(effective.provider);
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

/**
 * Ordered list of selectable thinking efforts for a model. Effort-capable models
 * expose their declared efforts (with an 'off' entry when the model is not
 * always-on); legacy boolean models expose 'on'/'off'; single-segment lists
 * mean the control is effectively locked.
 */
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

/**
 * Default thinking effort for a model: declared `default_effort`, else the
 * middle `support_efforts` entry, else `'on'` for boolean models, `'off'` when
 * thinking is unsupported.
 */
function defaultThinkingEffortFor(model: ModelAlias): ThinkingEffort {
  if (thinkingAvailability(model) === 'unsupported') return 'off';
  const efforts = effortsOf(model);
  if (efforts.length > 0) {
    return model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

/**
 * Normalize a draft effort before committing a selection. A boolean `'on'`
 * never leaks past the UI boundary — it becomes the model's default effort
 * (a concrete effort for effort-capable models, `'on'` only for genuine
 * boolean models).
 */
function commitEffort(choice: ModelChoice, draft: ThinkingEffort): ThinkingEffort {
  if (draft === 'on') return defaultThinkingEffortFor(choice.model);
  return draft;
}

/**
 * Flat, searchable single-list model picker.
 *
 * One navigation axis: ↑/↓ move the cursor (PgUp/PgDn page), typing fuzzy-filters
 * across every provider (provider name included), and ←/→ toggle the thinking
 * draft for models that support it. There are no provider tabs — filtering by
 * typing a provider name replaces them. See .agents/skills/write-tui/DESIGN.md.
 */
export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  /** Per-model thinking-effort override set by ←/→; absent → the default. */
  private readonly thinkingOverrides = new Map<string, string>();

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  /**
   * Thinking effort for a model: an explicit ←/→ override when set, otherwise
   * the live effort for the active model, otherwise the model's default effort
   * (effort-capable) or 'on' (other thinking-capable models).
   */
  private draftFor(choice: ModelChoice): string {
    const override = this.thinkingOverrides.get(choice.alias);
    if (override !== undefined) return override;
    if (choice.alias === this.opts.currentValue) return this.opts.currentThinkingEffort;
    const efforts = effortsOf(choice.model);
    if (efforts.length > 0) {
      // A model with support_efforts but no default_effort defaults to the
      // middle entry of its supported efforts.
      const def = choice.model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)];
      if (def !== undefined && efforts.includes(def)) return def;
      return efforts[0]!;
    }
    return thinkingAvailability(choice.model) !== 'unsupported' ? 'on' : 'off';
  }

  /** Draft coerced onto the model's segment list so rendering/selection never
   * reference a effort the model cannot actually select. */
  private effectiveEffort(choice: ModelChoice): string {
    const draft = this.draftFor(choice);
    const segments = segmentsFor(choice.model);
    return segments.includes(draft) ? draft : segments[0]!;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }

    // ↑/↓, PgUp/PgDn, and — when searchable — typing + Backspace.
    if (this.list.handleKey(data)) {
      return;
    }

    // Left/Right move the active thinking effort within the model's segments.
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const selected = this.selectedChoice();
      if (selected !== undefined) {
        const segments = segmentsFor(selected.model);
        if (segments.length > 1) {
          const current = this.effectiveEffort(selected);
          const idx = segments.indexOf(current);
          // The two-segment case is the legacy boolean On/Off control: both
          // arrows flip it. With more segments (efforts), ←/→ step.
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
      this.opts.onSelect({
        alias: selected.alias,
        thinking: commitEffort(selected, this.effectiveEffort(selected)),
      });
      return;
    }

    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      const selected = this.selectedChoice();
      if (selected === undefined) return;
      this.opts.onSessionOnlySelect({
        alias: selected.alias,
        thinking: commitEffort(selected, this.effectiveEffort(selected)),
      });
    }
  }

  override render(width: number): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;

    const titleSuffix =
      searchable && view.query.length === 0
        ? currentTheme.fg('textMuted', '  (type to search)')
        : '';

    // "type to search" already lives in the title suffix, so the hint only
    // surfaces the backspace shortcut once a query is active.
    const hintParts: string[] = [];
    if (this.opts.providerSwitchHint) hintParts.push('Tab toggle provider');
    hintParts.push('↑↓ navigate');
    if (searchable && view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select');
    if (this.opts.onSessionOnlySelect !== undefined) hintParts.push('Alt+S session-only');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Select a model') + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      '',
    ];

    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    } else {
      // Column width for model names so the provider column lines up. Capped so
      // the provider + "← current" marker still fit on normal terminal widths.
      const nameCap = Math.max(8, Math.floor(width * 0.5));
      let nameWidth = 0;
      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(choice.name));
      }
      nameWidth = Math.min(nameWidth, nameCap);

      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const isCurrent = choice.alias === this.opts.currentValue;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
        const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
        let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        line += (isSelected ? currentTheme.boldFg('primary', truncatedName) : currentTheme.fg('text', truncatedName)) + namePad;
        line += '  ' + currentTheme.fg('textMuted', choice.provider);
        if (isCurrent) {
          line += ' ' + currentTheme.fg('success', CURRENT_MARK);
        }
        lines.push(line);
      }
    }

    // Scroll / match indicator.
    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalCount)}`),
      );
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    const selected = this.selectedChoice();
    if (selected !== undefined) {
      const canSwitch = segmentsFor(selected.model).length > 1;
      const thinkingHeader = canSwitch ? ' Thinking  (←→ to switch)' : ' Thinking';
      lines.push(currentTheme.fg('textMuted', thinkingHeader));
      lines.push(this.renderThinkingControl(selected));
    }
    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  private renderThinkingControl(choice: ModelChoice): string {
    const segment = (label: string, active: boolean): string =>
      active
        ? currentTheme.boldFg('primary', `[ ${label} ]`)
        : currentTheme.fg('text', `  ${label}  `);
    // The whole segment is muted, suffix included, so the disabled side reads
    // as a single greyed-out control rather than a selectable option.
    const unavailable = (label: string): string =>
      currentTheme.fg('textMuted', `  ${label} (Unsupported)  `);

    // Non-effort always-on / unsupported models keep the original On/Off layout
    // so the control never shifts while moving across legacy models.
    const efforts = effortsOf(choice.model);
    const availability = thinkingAvailability(choice.model);
    if (efforts.length === 0 && availability === 'always-on') {
      return `  ${segment('On', true)} ${unavailable('Off')}`;
    }
    if (efforts.length === 0 && availability === 'unsupported') {
      return `  ${unavailable('On')} ${segment('Off', true)}`;
    }

    const segments = segmentsFor(choice.model);
    const active = this.effectiveEffort(choice);
    const rendered = segments.map((effort) => segment(effortLabel(effort), effort === active));
    return `  ${rendered.join('  ')}`;
  }
}
