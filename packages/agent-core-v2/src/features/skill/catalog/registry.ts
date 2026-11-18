import { escapeXmlAttr, escapeXmlTags } from '#/_base/utils/xml-escape';

import type {
  SkillCatalog,
  SkillDefinition,
  SkillMetadata,
  SkillPluginContext,
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
  private readonly variantsByName = new Map<string, SkillDefinition[]>();
  private readonly byPluginAndName = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const plugin = skill.plugin;
    if (plugin !== undefined) {
      this.registerPluginSkill(skill, plugin, options);
      return;
    }
    const key = normalizeSkillName(skill.name);
    if (options.replace === true || !this.byName.has(key)) {
      this.byName.set(key, skill);
      this.variantsByName.set(key, [skill]);
    }
  }

  registerVariants(
    skills: readonly SkillDefinition[],
    options: { readonly replace?: boolean } = {},
  ): void {
    const grouped = new Map<string, SkillDefinition[]>();
    for (const input of skills) {
      const { key, skill } = catalogVariant(input);
      const variants = grouped.get(key) ?? [];
      if (!variants.some((variant) => variant.path === skill.path)) variants.push(skill);
      grouped.set(key, variants);
    }
    for (const [key, variants] of grouped) {
      if (options.replace === true || !this.variantsByName.has(key)) {
        this.variantsByName.set(key, variants);
      }
    }
  }

  recordSkipped(skills: readonly SkippedSkill[]): void {
    this.skipped.push(...skills);
  }

  addRoots(roots: readonly string[]): void {
    for (const root of roots) {
      if (!this.roots.includes(root)) this.roots.push(root);
    }
  }

  getSkill(name: string, path?: string): SkillDefinition | undefined {
    const key = normalizeSkillName(name);
    if (path === undefined) return this.byName.get(key);
    return this.variantsByName.get(key)?.find((skill) => skill.path === path);
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
      `<plugin-instructions plugin="${escapeXmlAttr(plugin.id)}">\n` +
      `${instructions}\n` +
      `</plugin-instructions>\n\n${content}`
    );
  }

  listDefaultSkills(): readonly SkillDefinition[] {
    return [...this.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listSkills(): readonly SkillDefinition[] {
    return [...this.variantsByName.values()].flat().toSorted((a, b) => a.name.localeCompare(b.name));
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
      if (this.roots.length > 0) {
        lines.push('### Skill roots', ...this.roots.map((root) => `- \`${root}\``));
      }
    }
    return lines.length === 1 ? '' : lines.join('\n');
  }

  private registerPluginSkill(
    skill: SkillDefinition,
    plugin: SkillPluginContext,
    options: { readonly replace?: boolean },
  ): void {
    const prefix = `${plugin.id}:`;
    const bareName = skill.name.startsWith(prefix) ? skill.name.slice(prefix.length) : skill.name;
    const pluginKey = pluginSkillKey(plugin.id, bareName);
    if (options.replace === true || !this.byPluginAndName.has(pluginKey)) {
      this.byPluginAndName.set(pluginKey, { ...skill, name: bareName });
    }
    const qualifiedName = `${prefix}${bareName}`;
    const qualifiedKey = normalizeSkillName(qualifiedName);
    if (options.replace === true || !this.byName.has(qualifiedKey)) {
      const qualified = { ...skill, name: qualifiedName };
      this.byName.set(qualifiedKey, qualified);
      this.variantsByName.set(qualifiedKey, [qualified]);
    }
  }
}

function catalogVariant(skill: SkillDefinition): { key: string; skill: SkillDefinition } {
  const plugin = skill.plugin;
  if (plugin === undefined) return { key: normalizeSkillName(skill.name), skill };
  const prefix = `${plugin.id}:`;
  const bareName = skill.name.startsWith(prefix) ? skill.name.slice(prefix.length) : skill.name;
  const qualifiedName = `${prefix}${bareName}`;
  return {
    key: normalizeSkillName(qualifiedName),
    skill: { ...skill, name: qualifiedName },
  };
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
  if (skill.workspaceDir !== undefined) lines.push(`  Workspace: ${skill.workspaceDir}`);
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
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
