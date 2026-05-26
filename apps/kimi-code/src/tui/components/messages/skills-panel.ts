import { isAbsolute, relative } from 'node:path';

import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface SkillsReportOptions {
  readonly colors: ColorPalette;
  readonly skills: readonly SkillSummary[];
  readonly workDir: string;
}

type Colorize = (text: string) => string;

const SOURCE_GROUPS: ReadonlyArray<{
  readonly source: SkillSummary['source'];
  readonly label: string;
}> = [
  { source: 'project', label: 'Project' },
  { source: 'user', label: 'User' },
  { source: 'extra', label: 'Extra' },
  { source: 'builtin', label: 'Built-in' },
];

export function formatSkillType(skill: SkillSummary): string {
  return skill.type ?? 'prompt';
}

export function formatSkillCapability(skill: SkillSummary): string {
  const parts = [`type: ${formatSkillType(skill)}`];
  if (skill.disableModelInvocation === true) parts.push('manual only');
  return parts.join(' | ');
}

export function displaySkillPath(path: string, workDir: string): string {
  if (!isAbsolute(path) || workDir.length === 0) return path;
  const relativePath = relative(workDir, path);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    return path;
  }
  return relativePath;
}

function appendSkillLines(
  lines: string[],
  skills: readonly SkillSummary[],
  workDir: string,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
): void {
  for (const group of SOURCE_GROUPS) {
    const groupSkills = skills.filter((skill) => skill.source === group.source);
    if (groupSkills.length === 0) continue;

    if (lines.length > 0) lines.push('');
    lines.push(accent(group.label));

    for (const skill of groupSkills) {
      const description = skill.description.trim();
      lines.push(`  ${value(skill.name)}  ${muted(formatSkillCapability(skill))}`);
      if (description.length > 0) {
        lines.push(`    ${description}`);
      }
      lines.push(`    ${muted('path:')} ${displaySkillPath(skill.path, workDir)}`);
    }
  }
}

export function buildSkillsReportLines(options: SkillsReportOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const skills = [...options.skills].toSorted(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );

  if (skills.length === 0) {
    return [accent('Skills'), muted('  No skills loaded for this session.')];
  }

  const lines: string[] = [];
  appendSkillLines(lines, skills, options.workDir, accent, value, muted);
  return lines;
}
