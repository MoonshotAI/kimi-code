/**
 * `skillCatalog` domain (L3) — SKILL.md parsing primitives.
 *
 * Parses a SKILL.md (frontmatter + body) into a `SkillDefinition` and extracts
 * flowchart blocks. Pure functions with no IO: callers (the catalog Store
 * backends) read bytes however they like and pass the decoded text in. Keeping
 * parsing here lets the Store layer stay filesystem-agnostic.
 */

import path from 'pathe';

import { load as loadYaml } from 'js-yaml';

import type { SkillDefinition, SkillMetadata, SkillSource } from './types';
import { isSupportedSkillType } from './types';

export class FrontmatterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FrontmatterError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

export class SkillParseError extends Error {
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SkillParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

export class UnsupportedSkillTypeError extends Error {
  readonly skillType: string;

  constructor(skillType: string) {
    super(
      `Skill type "${skillType}" is not supported; only "prompt", "inline", and "flow" are supported.`,
    );
    this.name = 'UnsupportedSkillTypeError';
    this.skillType = skillType;
  }
}

export interface ParseSkillOptions {
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly source: SkillSource;
}

export interface ParseSkillTextOptions extends ParseSkillOptions {
  readonly text: string;
}

export interface ParsedFrontmatter {
  readonly data: unknown;
  readonly body: string;
}

const FENCE = '---';
const METADATA_ALIASES: Readonly<Record<string, string>> = {
  'when-to-use': 'whenToUse',
  when_to_use: 'whenToUse',
  'disable-model-invocation': 'disableModelInvocation',
  disable_model_invocation: 'disableModelInvocation',
};

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    return { data: null, body: text };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (close === -1) {
    throw new FrontmatterError('Missing closing frontmatter fence');
  }

  const yamlText = lines.slice(1, close).join('\n').trim();
  const body = lines.slice(close + 1).join('\n');
  if (yamlText === '') {
    return { data: {}, body };
  }

  try {
    return { data: loadYaml(yamlText) ?? {}, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FrontmatterError(message, error);
  }
}

export function parseSkillText(options: ParseSkillTextOptions): SkillDefinition {
  const isDirectorySkill = path.basename(options.skillMdPath) === 'SKILL.md';
  if (isDirectorySkill && options.text.split(/\r?\n/, 1)[0]?.trim() !== FENCE) {
    throw new SkillParseError(`Missing frontmatter in ${options.skillMdPath}`);
  }

  let parsed;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new SkillParseError(
        `Invalid frontmatter in ${options.skillMdPath}: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const frontmatter = parsed.data ?? {};
  if (!isRecord(frontmatter)) {
    throw new SkillParseError(
      `Frontmatter in ${options.skillMdPath} must be a mapping at the top level`,
    );
  }

  const metadata = normalizeMetadata(frontmatter);
  if (!isSupportedSkillType(metadata.type)) {
    throw new UnsupportedSkillTypeError(metadata.type ?? String(frontmatter['type']));
  }

  const name = nonEmptyString(metadata.name);
  const description = nonEmptyString(metadata.description);
  if (isDirectorySkill && (name === undefined || description === undefined)) {
    const field = name === undefined ? '"name"' : '"description"';
    throw new SkillParseError(
      `Missing required frontmatter field ${field} in ${options.skillMdPath}`,
    );
  }

  const skillPath = path.resolve(options.skillMdPath);
  const content = parsed.body.trim();
  return {
    name: name ?? options.skillDirName,
    description: description ?? descriptionFromBody(content),
    path: skillPath,
    dir: path.dirname(skillPath),
    content,
    metadata,
    source: options.source,
    mermaid: parseMermaidFlowchart(content),
    d2: parseD2Flowchart(content),
  };
}

export function parseMermaidFlowchart(markdown: string): string | undefined {
  return /```mermaid\r?\n([\s\S]*?)\r?\n```/.exec(markdown)?.[1];
}

export function parseD2Flowchart(markdown: string): string | undefined {
  return /```d2\r?\n([\s\S]*?)\r?\n```/.exec(markdown)?.[1];
}

export function skillArgumentNames(metadata: SkillMetadata): readonly string[] {
  const value = metadata.arguments;
  const isValidName = (name: string): boolean =>
    name.trim() !== '' && !/^\d+$/.test(name);
  if (typeof value === 'string') return value.split(/\s+/).filter(isValidName);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && isValidName(item));
}

function normalizeMetadata(raw: Record<string, unknown>): SkillMetadata {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = METADATA_ALIASES[rawKey] ?? rawKey;
    out[key] = value;
  }

  const type = nonEmptyString(out['type']);
  if (type !== undefined) out['type'] = type;

  const name = nonEmptyString(out['name']);
  if (name !== undefined) out['name'] = name;

  const description = nonEmptyString(out['description']);
  if (description !== undefined) out['description'] = description;

  return out as SkillMetadata;
}

function descriptionFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return 'No description provided.';
  return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
