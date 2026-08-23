export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface SkillMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly isSubSkill?: boolean;
  readonly safe?: boolean;
  readonly arguments?: readonly unknown[] | string;
  readonly category?: string;
  readonly categories?: readonly string[] | string;
  readonly issuer?: string;
  readonly collection?: string;
  readonly groups?: readonly string[];
  readonly tags?: readonly string[];
  readonly [key: string]: unknown;
}

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly dir: string;
  readonly content: string;
  readonly metadata: SkillMetadata;
  readonly source: SkillSource;
  readonly plugin?: SkillPluginContext;
  readonly mermaid?: string;
  readonly d2?: string;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly type?: string;
  readonly disableModelInvocation?: boolean;
  readonly isSubSkill?: boolean;
  readonly category?: string;
  readonly categories?: readonly string[];
  readonly issuer?: string;
  readonly collection?: string;
  readonly groups?: readonly string[];
  readonly tags?: readonly string[];
}

export interface SkillRoot {
  readonly path: string;
  readonly source: SkillSource;
  readonly plugin?: SkillPluginContext;
  /**
   * How discovery scans this root. Defaults to 'directory' (full directory
   * scan). 'root-skill-only' treats the root as a single skill bundle and only
   * parses `<root>/SKILL.md` — used for the plugin manifest fallback so sibling
   * docs like CHANGELOG.md are not mistaken for flat skills.
   */
  readonly scanMode?: 'directory' | 'root-skill-only';
}

export interface SkillPluginContext {
  readonly id: string;
  readonly instructions?: string;
}

export interface SkippedSkill {
  readonly path: string;
  readonly type: string;
  readonly reason: string;
}

export interface SkillCatalog {
  getSkill(name: string): SkillDefinition | undefined;
  listSkills(): readonly SkillDefinition[];
  listInvocableSkills(): readonly SkillDefinition[];
}

export function normalizeSkillName(name: string): string {
  return name.toLowerCase();
}

export function isInlineSkillType(type: string | undefined): boolean {
  return type === undefined || type === 'prompt' || type === 'inline';
}

export function isUserActivatableSkillType(type: string | undefined): boolean {
  return isInlineSkillType(type) || type === 'flow';
}

export function isSupportedSkillType(type: string | undefined): boolean {
  return isUserActivatableSkillType(type) || type === 'reference';
}

export function summarizeSkill(skill: SkillDefinition): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
    type: skill.metadata.type,
    disableModelInvocation: skill.metadata.disableModelInvocation,
    isSubSkill: skill.metadata.isSubSkill,
    category: typeof skill.metadata.category === 'string' && skill.metadata.category.trim() !== '' ? skill.metadata.category.trim() : undefined,
    categories: Array.isArray(skill.metadata.categories)
      ? skill.metadata.categories.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : typeof skill.metadata.categories === 'string' && skill.metadata.categories.trim() !== ''
        ? [skill.metadata.categories.trim()]
        : undefined,
    issuer: typeof skill.metadata.issuer === 'string' && skill.metadata.issuer.trim() !== '' ? skill.metadata.issuer.trim() : undefined,
    collection: typeof skill.metadata.collection === 'string' && skill.metadata.collection.trim() !== '' ? skill.metadata.collection.trim() : undefined,
    groups: Array.isArray(skill.metadata.groups) ? skill.metadata.groups.filter((g): g is string => typeof g === 'string' && g.trim() !== '') : undefined,
    tags: Array.isArray(skill.metadata.tags) ? skill.metadata.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : undefined,
  };
}
