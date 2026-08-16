export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface SkillMetadata {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly type?: string | undefined;
  readonly whenToUse?: string | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  readonly isSubSkill?: boolean | undefined;
  readonly safe?: boolean | undefined;
  readonly arguments?: readonly unknown[] | string | undefined;
  readonly category?: string | undefined;
  readonly issuer?: string | undefined;
  readonly collection?: string | undefined;
  readonly groups?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
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
  readonly mermaid?: string | undefined;
  readonly d2?: string;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly type?: string | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  readonly isSubSkill?: boolean | undefined;
  readonly category?: string | undefined;
  readonly issuer?: string | undefined;
  readonly collection?: string | undefined;
  readonly groups?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
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
    issuer: typeof skill.metadata.issuer === 'string' && skill.metadata.issuer.trim() !== '' ? skill.metadata.issuer.trim() : undefined,
    collection: typeof skill.metadata.collection === 'string' && skill.metadata.collection.trim() !== '' ? skill.metadata.collection.trim() : undefined,
    groups: Array.isArray(skill.metadata.groups) ? skill.metadata.groups.filter((g): g is string => typeof g === 'string' && g.trim() !== '') : undefined,
    tags: Array.isArray(skill.metadata.tags) ? skill.metadata.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : undefined,
  };
}
