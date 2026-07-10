/**
 * `skillCatalog` domain (L3) — concrete in-memory skill catalog.
 *
 * Owns registered skill lookup, plugin-scoped skill lookup, prompt rendering,
 * and model-facing skill listings for `skill`, plus the skipped-skill /
 * scanned-root diagnostics accumulated from discovery results. Held internally
 * by the Session skill-catalog sink (`ISessionSkillCatalog`) and composed
 * directly by the edge to resolve a workspace's skills without a Session; it is
 * not a scoped service.
 */

import { escapeXmlAttr, escapeXmlTags } from '#/_base/utils/xml-escape';

import type {
  SkillCatalog,
  SkillDefinition,
  SkillMetadata,
  SkillSource,
  SkippedSkill,
} from './types';
import { isInlineSkillType, normalizeSkillName } from './types';

const LISTING_DESC_MAX = 250;

export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

export class InMemorySkillCatalog implements SkillCatalog {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly byPluginAndName = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const key = normalizeSkillName(skill.name);
    if (options.replace === true || !this.byName.has(key)) {
      this.byName.set(key, skill);
    }
    this.indexPluginSkill(skill, options);
  }

  recordSkipped(skills: readonly SkippedSkill[]): void {
    this.skipped.push(...skills);
  }

  addRoots(roots: readonly string[]): void {
    for (const root of roots) {
      if (!this.roots.includes(root)) this.roots.push(root);
    }
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(normalizeSkillName(name));
  }

  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined {
    return this.byPluginAndName.get(pluginSkillKey(pluginId, name));
  }

  renderSkillPrompt(
    skill: SkillDefinition,
    rawArgs: string,
    context?: { readonly sessionId?: string },
  ): string {
    const argumentNames = skillArgumentNames(skill.metadata);
    const content = expandSkillParameters(skill.content, rawArgs, {
      skillDir: skill.dir,
      sessionId: context?.sessionId,
      argumentNames,
    });
    const plugin = skill.plugin;
    if (plugin === undefined) return content;
    const instructions = plugin.instructions;
    if (instructions === undefined || instructions.trim().length === 0) return content;
    return (
      `<kimi-plugin-instructions plugin="${escapeXmlAttr(plugin.id)}">\n` +
      `${instructions}\n` +
      `</kimi-plugin-instructions>\n\n${content}`
    );
  }

  listSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.listSkills().filter(
      (skill) =>
        skill.metadata.disableModelInvocation !== true && isInlineSkillType(skill.metadata.type),
    );
  }

  getSkillRoots(): readonly string[] {
    return [...this.roots];
  }

  getSkippedByPolicy(): readonly SkippedSkill[] {
    return [...this.skipped];
  }

  getKimiSkillsDescription(): string {
    const rendered = renderGroupedSkills(this.listSkills(), formatFullSkill);
    return rendered.length === 0 ? 'No skills' : rendered;
  }

  getModelSkillListing(): string {
    const lines = ['DISREGARD any earlier skill listings. Current available skills:'];
    const listing = renderGroupedSkills(
      this.listInvocableSkills().filter((skill) => skill.metadata.isSubSkill !== true),
      formatModelSkill,
    );
    if (listing.length > 0) {
      lines.push(listing);
    }
    return lines.length === 1 ? '' : lines.join('\n');
  }

  private indexPluginSkill(
    skill: SkillDefinition,
    options: { readonly replace?: boolean } = {},
  ): void {
    if (skill.plugin === undefined) return;
    const key = pluginSkillKey(skill.plugin.id, skill.name);
    if (options.replace === true || !this.byPluginAndName.has(key)) {
      this.byPluginAndName.set(key, skill);
    }
  }
}

interface SkillExpandContext {
  readonly skillDir: string;
  readonly sessionId?: string;
  readonly argumentNames?: readonly string[];
}

function expandSkillParameters(
  body: string,
  rawArgs: string,
  context: SkillExpandContext,
): string {
  const tokens = tokenizeArgs(rawArgs);
  let content = body;

  for (let index = 0; index < (context.argumentNames?.length ?? 0); index++) {
    const name = context.argumentNames?.[index];
    if (name === undefined) continue;
    const escaped = escapeRegExp(name);
    content = content.replaceAll(
      new RegExp(`\\$${escaped}(?![\\[\\w])`, 'g'),
      escapeXmlTags(tokens[index] ?? ''),
    );
  }

  content = content
    .replaceAll(/\$ARGUMENTS\[(\d+)\]/g, (_match, indexText: string) => {
      const index = Number.parseInt(indexText, 10);
      return escapeXmlTags(tokens[index] ?? '');
    })
    .replaceAll(/\$(\d+)(?!\w)/g, (_match, indexText: string) => {
      const index = Number.parseInt(indexText, 10);
      return escapeXmlTags(tokens[index] ?? '');
    })
    .replaceAll('$ARGUMENTS', escapeXmlTags(rawArgs));

  const hasArgumentPlaceholder = content !== body;
  content = content
    .replaceAll('${KIMI_SKILL_DIR}', context.skillDir)
    .replaceAll('${KIMI_SESSION_ID}', context.sessionId ?? '');

  if (!hasArgumentPlaceholder && rawArgs.length > 0) {
    return `${content}\n\nARGUMENTS: ${escapeXmlTags(rawArgs)}`;
  }
  return content;
}

function skillArgumentNames(metadata: SkillMetadata): readonly string[] {
  const value = metadata.arguments;
  const isValidName = (name: string): boolean =>
    name.trim() !== '' && !/^\d+$/.test(name);
  if (typeof value === 'string') return value.split(/\s+/).filter(isValidName);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && isValidName(item));
}

function pluginSkillKey(pluginId: string, skillName: string): string {
  return `${pluginId}\0${normalizeSkillName(skillName)}`;
}

const SOURCE_GROUPS: ReadonlyArray<{ readonly source: SkillSource; readonly label: string }> = [
  { source: 'project', label: 'Project' },
  { source: 'user', label: 'User' },
  { source: 'extra', label: 'Extra' },
  { source: 'builtin', label: 'Built-in' },
];

function renderGroupedSkills(
  skills: readonly SkillDefinition[],
  format: (skill: SkillDefinition) => readonly string[],
): string {
  const lines: string[] = [];
  for (const group of SOURCE_GROUPS) {
    const groupSkills = skills.filter((skill) => skill.source === group.source);
    if (groupSkills.length === 0) continue;
    lines.push(`### ${group.label}`);
    for (const skill of groupSkills) {
      lines.push(...format(skill));
    }
  }
  return lines.join('\n');
}

function formatFullSkill(skill: SkillDefinition): readonly string[] {
  return [`- ${skill.name}`, `  - Path: ${skill.path}`, `  - Description: ${skill.description}`];
}

function formatModelSkill(skill: SkillDefinition): readonly string[] {
  const lines = [`- ${skill.name}: ${truncate(skill.description, LISTING_DESC_MAX)}`];
  if (typeof skill.metadata.whenToUse === 'string' && skill.metadata.whenToUse.length > 0) {
    lines.push(`  When to use: ${skill.metadata.whenToUse}`);
  }
  lines.push(`  Path: ${skill.path}`);
  return lines;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let length = 0;
  let result = '';
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (length + segment.length > max - 3) break;
    result += segment;
    length += segment.length;
  }
  return `${result}...`;
}

function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasContent = false;

  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
        hasContent = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        out.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }

  if (hasContent) out.push(current);
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
