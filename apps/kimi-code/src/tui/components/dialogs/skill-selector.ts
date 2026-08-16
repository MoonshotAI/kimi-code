import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';
import {
  buildSkillGroupTree,
  findGroupNode,
  type SkillGroupNode,
} from '../../commands/skill-group-tree';

export interface SkillSelectorOptions {
  readonly skills: readonly SkillSummary[];
  readonly skillRoots?: readonly string[];
  readonly title?: string;
  readonly searchable?: boolean;
  readonly pageSize?: number;
  readonly onSelect: (skill: SkillSummary) => void;
  readonly onCancel: () => void;
}

export type SkillSelectorItem =
  | {
      readonly kind: 'group';
      readonly node: SkillGroupNode;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: 'skill';
      readonly skill: SkillSummary;
      readonly label: string;
      readonly description: string;
    };

function countSkillsInTree(node: SkillGroupNode): number {
  let count = node.skills.length;
  for (const child of node.childGroups) {
    count += countSkillsInTree(child);
  }
  return count;
}

export class SkillSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: SkillSelectorOptions;
  private readonly rootTree: SkillGroupNode;
  private currentGroupPath: string = '';
  private list!: SearchableList<SkillSelectorItem>;

  constructor(opts: SkillSelectorOptions) {
    super();
    this.opts = opts;
    this.rootTree = buildSkillGroupTree(opts.skills, { skillRoots: opts.skillRoots });
    this.rebuildList();
  }

  private rebuildList(): void {
    const currentNode = findGroupNode(this.rootTree, this.currentGroupPath) ?? this.rootTree;
    const items: SkillSelectorItem[] = [];

    for (const childGroup of currentNode.childGroups) {
      const skillCount = countSkillsInTree(childGroup);
      items.push({
        kind: 'group',
        node: childGroup,
        label: childGroup.label,
        description: `${String(skillCount)} skill${skillCount === 1 ? '' : 's'}`,
      });
    }

    for (const skill of currentNode.skills) {
      items.push({
        kind: 'skill',
        skill,
        label: skill.name,
        description: skill.description || 'No description provided.',
      });
    }

    this.list = new SearchableList({
      items,
      toSearchText: (item) => `${item.label} ${item.description}`,
      pageSize: this.opts.pageSize,
      searchable: this.opts.searchable ?? true,
    });
  }

  private cycleGroupSelection(isShift: boolean): void {
    const view = this.list.view();
    const items = view.items;
    if (items.length === 0) return;

    const groupIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind === 'group') {
        groupIndices.push(i);
      }
    }

    if (groupIndices.length === 0) return;

    const currentIndex = view.selectedIndex;
    let targetIndex: number;

    const k = groupIndices.indexOf(currentIndex);
    if (k >= 0) {
      if (isShift) {
        targetIndex = groupIndices[(k - 1 + groupIndices.length) % groupIndices.length] ?? 0;
      } else {
        targetIndex = groupIndices[(k + 1) % groupIndices.length] ?? 0;
      }
    } else {
      targetIndex = isShift ? (groupIndices[groupIndices.length - 1] ?? 0) : (groupIndices[0] ?? 0);
    }

    this.list.setSelectedIndex(targetIndex);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      const isShift = matchesKey(data, Key.shift('tab'));
      this.cycleGroupSelection(isShift);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      if (this.currentGroupPath !== '') {
        const segments = this.currentGroupPath.split('/');
        segments.pop();
        this.currentGroupPath = segments.join('/');
        this.rebuildList();
        return;
      }
      this.opts.onCancel();
      return;
    }

    const isSpace = matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (matchesKey(data, Key.enter) || (isSpace && this.opts.searchable !== true)) {
      const selected = this.list.selected();
      if (selected === undefined) return;

      if (selected.kind === 'group') {
        this.currentGroupPath = selected.node.path;
        this.rebuildList();
      } else {
        this.opts.onSelect(selected.skill);
      }
      return;
    }

    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const searchable = this.opts.searchable !== false;
    const view = this.list.view();
    const items = view.items;

    const titleText =
      this.opts.title ??
      (this.currentGroupPath === ''
        ? 'Select skill group'
        : `Skills › ${this.currentGroupPath.split('/').join(' › ')}`);

    const titleSuffix =
      searchable && view.query.length === 0
        ? currentTheme.fg('textMuted', '  (type to search)')
        : '';

    const hintParts = ['↑↓ navigate', 'Tab jump groups'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    hintParts.push('Enter select', 'Esc back/cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${titleText}`) + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      '',
    ];

    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    if (items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const item = items[i];
        if (item === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const pointer = isSelected ? SELECT_POINTER : ' ';

        let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        if (item.kind === 'group') {
          const groupLabel = `${item.label}/`;
          line += isSelected
            ? currentTheme.boldFg('primary', groupLabel)
            : currentTheme.fg('primary', groupLabel);
          line += '  ' + currentTheme.fg('textMuted', `(${item.description})`);
        } else {
          line += isSelected
            ? currentTheme.boldFg('primary', item.label)
            : currentTheme.fg('text', item.label);
        }
        lines.push(line);
      }
    }

    lines.push('');

    // Footer preview for currently selected item
    const selected = this.list.selected();
    if (selected !== undefined) {
      const selectedType = selected.kind === 'group' ? 'Group' : 'Skill';
      lines.push(currentTheme.fg('textMuted', ` ${selectedType}: ${selected.label}`));
      lines.push(currentTheme.fg('text', `   ${selected.description}`));
      lines.push('');
    }

    if (view.page.pageCount > 1) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
