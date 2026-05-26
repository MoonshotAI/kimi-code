import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface SkillsReportOptions {
  readonly colors: ColorPalette;
  readonly skills: readonly SkillSummary[];
}

type Source = SkillSummary['source'];

const SOURCE_ORDER: readonly Source[] = ['builtin', 'project', 'user', 'extra'];

const SOURCE_LABEL: Record<Source, string> = {
  builtin: 'Built-in',
  project: 'Project',
  user: 'User',
  extra: 'Extra',
};

const SOURCE_PRIORITY: Record<Source, number> = {
  builtin: 0,
  project: 1,
  user: 2,
  extra: 3,
};

function sortSkills(skills: readonly SkillSummary[]): SkillSummary[] {
  return skills.toSorted(
    (a, b) =>
      SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] ||
      a.name.localeCompare(b.name),
  );
}

function groupBySource(
  skills: readonly SkillSummary[],
): Map<Source, SkillSummary[]> {
  const groups = new Map<Source, SkillSummary[]>();
  for (const skill of skills) {
    const list = groups.get(skill.source) ?? [];
    list.push(skill);
    groups.set(skill.source, list);
  }
  return groups;
}

function buildSkillLines(
  skills: readonly SkillSummary[],
  value: (text: string) => string,
  dim: (text: string) => string,
  nameWidth: number,
  typeWidth: number,
): string[] {
  return skills.map((skill) => {
    const name = skill.name.length > nameWidth ? skill.name.slice(0, nameWidth - 1) + '…' : skill.name;
    const type = (skill.type ?? '-').padEnd(typeWidth).slice(0, typeWidth);
    const desc = skill.description || '-';
    return `    ${value(name.padEnd(nameWidth))}  ${dim(type)}  ${value(desc)}`;
  });
}

export function buildSkillsReportLines(options: SkillsReportOptions): string[] {
  const { colors, skills } = options;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const dim = chalk.hex(colors.textDim);

  if (skills.length === 0) {
    return [muted('  No skills available.')];
  }

  const sorted = sortSkills(skills);
  const groups = groupBySource(sorted);

  const nameWidth = Math.min(24, Math.max('Name'.length, ...skills.map((s) => s.name.length)));
  const typeWidth = Math.min(12, Math.max('Type'.length, ...skills.map((s) => (s.type ?? '-').length)));

  const lines: string[] = [
    `  ${muted('Name'.padEnd(nameWidth))}  ${muted('Type'.padEnd(typeWidth))}  ${muted('Description')}`,
  ];

  for (const source of SOURCE_ORDER) {
    const group = groups.get(source);
    if (group === undefined || group.length === 0) continue;

    lines.push(`  ${accent(SOURCE_LABEL[source])}`);
    lines.push(...buildSkillLines(group, value, dim, nameWidth, typeWidth));
  }

  return lines;
}
