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
import { renderTabStrip } from '#/tui/utils/tab-strip';
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
      readonly groupPath?: string;
      readonly isDescendant?: boolean;
    }
  | {
      readonly kind: 'skill';
      readonly skill: SkillSummary;
      readonly label: string;
      readonly description: string;
      readonly groupPath?: string;
      readonly isDescendant?: boolean;
    };

function countSkillsInTree(node: SkillGroupNode): number {
  let count = node.skills.length;
  for (const child of node.childGroups) {
    count += countSkillsInTree(child);
  }
  return count;
}

function collectDescendantSkills(
  node: SkillGroupNode,
): Array<{ skill: SkillSummary; groupPath: string }> {
  const result: Array<{ skill: SkillSummary; groupPath: string }> = [];
  for (const child of node.childGroups) {
    for (const skill of child.skills) {
      result.push({ skill, groupPath: child.path });
    }
    result.push(...collectDescendantSkills(child));
  }
  return result;
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

  private get tabLabels(): readonly string[] {
    return ['All', ...this.rootTree.childGroups.map((g) => g.label)];
  }

  private get activeTabIdx(): number {
    if (this.currentGroupPath === '') return 0;
    const topSegment = this.currentGroupPath.split('/')[0];
    const idx = this.rootTree.childGroups.findIndex(
      (g) => g.label === topSegment || g.path === topSegment,
    );
    return idx >= 0 ? idx + 1 : 0;
  }

  private switchTab(newIdx: number): void {
    if (newIdx === 0) {
      this.currentGroupPath = '';
    } else {
      const group = this.rootTree.childGroups[newIdx - 1];
      if (group !== undefined) {
        this.currentGroupPath = group.path;
      }
    }
    this.rebuildList();
  }

  private cycleTab(isShift: boolean): void {
    const labels = this.tabLabels;
    if (labels.length <= 1) return;
    const current = this.activeTabIdx;
    const nextIdx = isShift
      ? (current - 1 + labels.length) % labels.length
      : (current + 1) % labels.length;
    this.switchTab(nextIdx);
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
        groupPath: childGroup.path,
      });
    }

    const directSkillNames = new Set<string>();
    for (const skill of currentNode.skills) {
      directSkillNames.add(skill.name);
      items.push({
        kind: 'skill',
        skill,
        label: skill.name,
        description: skill.description || 'No description provided.',
        groupPath: currentNode.path,
      });
    }

    const descendantSkills = collectDescendantSkills(currentNode);
    for (const { skill, groupPath } of descendantSkills) {
      if (!directSkillNames.has(skill.name)) {
        directSkillNames.add(skill.name);
        items.push({
          kind: 'skill',
          skill,
          label: skill.name,
          description: skill.description || 'No description provided.',
          groupPath,
          isDescendant: true,
        });
      }
    }

    this.list = new SearchableList({
      items,
      toSearchText: (item) => `${item.label} ${item.description} ${item.groupPath ?? ''}`,
      filterItem: (item, query) => query.length > 0 || item.isDescendant !== true,
      pageSize: this.opts.pageSize,
      searchable: this.opts.searchable ?? true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      const isShift = matchesKey(data, Key.shift('tab'));
      this.cycleTab(isShift);
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

    const hintParts = ['↑↓ navigate', 'Tab switch group'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    hintParts.push('Enter select', 'Esc back/cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${titleText}`) + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      '',
    ];

    const labels = this.tabLabels;
    if (labels.length > 1) {
      const stripLine = renderTabStrip({
        labels,
        activeIndex: this.activeTabIdx,
        width,
        colors: currentTheme.palette,
      });
      lines.push(stripLine, '');
    }

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
          if (item.isDescendant && item.groupPath) {
            line += '  ' + currentTheme.fg('textMuted', `(${item.groupPath})`);
          }
        }
        lines.push(line);
      }
    }

    lines.push('');

    // Footer preview for currently selected item
    const selected = this.list.selected();
    if (selected !== undefined) {
      const selectedType = selected.kind === 'group' ? 'Group' : 'Skill';
      const pathSuffix =
        selected.kind === 'skill' && selected.groupPath ? ` (${selected.groupPath})` : '';
      lines.push(currentTheme.fg('textMuted', ` ${selectedType}: ${selected.label}${pathSuffix}`));
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

