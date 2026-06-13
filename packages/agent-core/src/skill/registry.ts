import { readFileSync } from 'node:fs';

import { LAZY_CONTENT_SENTINEL, expandSkillParameters, skillArgumentNames, parseSkillMetaFromFile, parseSkillText } from './parser';
import { discoverSkills, type DiscoverSkillsOptions } from './scanner';
import { SkillSearchIndex, type SkillSearchResult } from './search';
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { isInlineSkillType, normalizeSkillName } from './types';
import type { SkillRegistry as AgentSkillRegistry } from '../agent/skill/types';
import { escapeXmlAttr } from '../utils/xml-escape';

const LISTING_DESC_MAX = 250;

/**
 * Above this threshold, getModelSkillListing() switches to a compact
 * name-only listing and tells the model to use the `skill_search` tool.
 * Below it, the legacy full listing is injected into the system prompt
 * (cheaper for prompt caching with small catalogues).
 */
const COMPACT_LISTING_THRESHOLD = 80;

/**
 * Above this threshold, the compact listing drops descriptions entirely
 * and lists only skill names.
 */
const NAMES_ONLY_LISTING_THRESHOLD = 300;

export class SkillNotFoundError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

export interface SkillRegistryOptions {
  readonly discover?: typeof discoverSkills;
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
}

export class SessionSkillRegistry implements AgentSkillRegistry {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly byPluginAndName = new Map<string, SkillDefinition>();
  private readonly roots: string[] = [];
  private readonly skipped: SkippedSkill[] = [];
  private readonly discoverImpl: typeof discoverSkills;
  private readonly onWarning: (message: string, cause?: unknown) => void;
  readonly sessionId?: string;
  private readonly searchIndex = new SkillSearchIndex();

  private indexDirty = false;

  constructor(options: SkillRegistryOptions = {}) {
    this.discoverImpl = options.discover ?? discoverSkills;
    this.onWarning = options.onWarning ?? (() => {});
    this.sessionId = options.sessionId;
  }

  async loadRoots(roots: readonly SkillRoot[]): Promise<void> {
    for (const root of roots) {
      if (!this.roots.includes(root.path)) this.roots.push(root.path);
    }

    // Only parse frontmatter at startup (name, description, whenToUse).
    // The full body is loaded on demand when renderSkillPrompt() is called.
    // This saves ~95% memory for large skill catalogues.

    const skills = await this.discoverImpl({
      roots,
      parse: parseSkillMetaFromFile,
      onWarning: this.onWarning,
      onSkippedByPolicy: (skill) => this.skipped.push(skill),
      onDiscoveredSkill: (skill) => {
        this.indexPluginSkill(skill);
      },
    } satisfies DiscoverSkillsOptions);

    for (const skill of skills) {
      this.byName.set(normalizeSkillName(skill.name), skill);
    }

    // Build the BM25 search index so the model can discover skills
    // via the `skill_search` tool instead of scanning a full listing.
    this.searchIndex.build(this.listInvocableSkills());
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.register(skill.source === 'builtin' ? skill : { ...skill, source: 'builtin' });
  }

  register(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    const key = normalizeSkillName(skill.name);
    if (options.replace === true || !this.byName.has(key)) {
      this.byName.set(key, skill);
      this.indexDirty = true;
    }
    this.indexPluginSkill(skill, options);
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(normalizeSkillName(name));
  }

  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined {
    return this.byPluginAndName.get(pluginSkillKey(pluginId, name));
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

  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    // Lazy content loading: when compact mode parsed only frontmatter,
    // the body is empty. Read the full file now (sync, only for activated skills).
    let content = skill.content;
    if (content === LAZY_CONTENT_SENTINEL && skill.path.length > 0) {
      const text = readFileSync(skill.path, 'utf8');
      const full = parseSkillText({
        skillMdPath: skill.path,
        skillDirName: skill.dir.split('/').pop() ?? skill.dir,
        source: skill.source,
        text,
      });
      content = full.content;
    }

    const argumentNames = skillArgumentNames(skill.metadata);
    content = expandSkillParameters(content, rawArgs, {
      skillDir: skill.dir,
      sessionId: this.sessionId,
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

  /**
   * Search skills by free-text query. Delegates to the BM25 index.
   * Lazily rebuilds the index if skills were registered since the last build.
   */
  searchSkills(query: string, limit?: number): readonly SkillSearchResult[] {
    if (this.indexDirty) {
      this.searchIndex.build(this.listInvocableSkills());
      this.indexDirty = false;
    }
    return this.searchIndex.search(query, limit);
  }

  getModelSkillListing(): string {
    const invocable = this.listInvocableSkills().filter(
      (skill) => skill.metadata.isSubSkill !== true,
    );

    // Auto-detect: small catalogue → legacy full listing.
    // Large catalogue → compact/names-only + search-first.
    if (invocable.length <= COMPACT_LISTING_THRESHOLD) {
      const lines = ['DISREGARD any earlier skill listings. Current available skills:'];
      const listing = renderGroupedSkills(invocable, formatModelSkill);
      if (listing.length > 0) lines.push(listing);
      return lines.length === 1 ? '' : lines.join('\n');
    }

    // Tier 2+3: Large catalogue — search-first.
    const count = invocable.length;
    const format = count > NAMES_ONLY_LISTING_THRESHOLD
      ? formatNameOnlySkill
      : formatCompactSkill;
    const lines = [
      `You have access to ${String(count)} registered skills.`,
      'To find relevant skills, call the `Skill` tool with `action: "search"` and keywords from the user\'s request.',
      'Do NOT guess skill names — always search first, then load with `action: "load"`.',
      '',
      'Skill names by scope:',
    ];
    const listing = renderGroupedSkills(invocable, format);
    if (listing.length > 0) lines.push(listing);
    return lines.join('\n');
  }
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

/** Compact format: name + 80-char description, no path. */
function formatCompactSkill(skill: SkillDefinition): readonly string[] {
  return [`- ${skill.name}: ${truncate(skill.description, 80)}`];
}

/** Minimal format: name only. Used for catalogues > 200 skills. */
function formatNameOnlySkill(skill: SkillDefinition): readonly string[] {
  return [`- ${skill.name}`];
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
