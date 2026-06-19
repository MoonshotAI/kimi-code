import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'pathe';

import { load as loadYaml } from 'js-yaml';
import regexpEscape from 'regexp.escape';

import type { SkillDefinition, SkillMetadata, SkillSource } from './types';
import { isSupportedSkillType } from './types';
import { escapeXmlTags } from '../utils/xml-escape';

/**
 * Sentinel stored in SkillDefinition.content when only frontmatter was
 * parsed at startup.  renderSkillPrompt() checks for this to decide
 * whether to lazy-load the full body from disk.
 */
export const LAZY_CONTENT_SENTINEL = '\u0000LAZY';

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

export interface SkillExpandContext {
  readonly skillDir: string;
  readonly sessionId?: string;
  readonly argumentNames?: readonly string[];
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

export async function parseSkillFromFile(options: ParseSkillOptions): Promise<SkillDefinition> {
  let text: string;
  try {
    text = await readFile(options.skillMdPath, 'utf8');
  } catch (error) {
    throw new SkillParseError(`Failed to read ${options.skillMdPath}`, error);
  }
  return parseSkillText({ ...options, text });
}

/**
 * Read only the frontmatter from a SKILL.md file, leaving `content` empty.
 * The body is not read from disk — callers can load it later via
 * `readFile` + `parseSkillText` when the full content is actually needed.
 *
 * This avoids loading the full body of thousands of SKILL files into memory
 * at startup when only the index (name, description) is needed.
 */
export async function parseSkillMetaFromFile(options: ParseSkillOptions): Promise<SkillDefinition> {
  const stream = createReadStream(options.skillMdPath, { encoding: 'utf8', highWaterMark: 4096 });
  let buffer = '';
  let fenceCount = 0;

  try {
    for await (const chunk of stream) {
      buffer += chunk;
      const fences = buffer.match(/^---\s*$/gm);
      if (fences !== null && fences.length >= 2) {
        fenceCount = 2;
        break;
      }
    }
  } finally {
    stream.close();
  }

  if (fenceCount < 2) {
    return parseSkillFromFile(options);
  }

  // Find the exact end of the second fence in the original buffer so the
  // slice works for both LF and CRLF line endings. `split('\n')` keeps a
  // trailing '\r' on CRLF lines, so the fence line itself is '---\r' (length
  // 4) and must be included in full; hard-coding +3 only works for LF.
  let fencesFound = 0;
  let offset = 0;
  let fenceLineLength = 0;
  const lines = buffer.split('\n');
  for (const line of lines) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^---\s*$/.test(trimmed)) {
      fencesFound++;
      if (fencesFound === 2) {
        fenceLineLength = line.length;
        break;
      }
    }
    offset += line.length + 1; // +1 for the \n that split removed
  }

  const frontmatterOnly = buffer.slice(0, offset + fenceLineLength);
  const bodyStart = offset + fenceLineLength;
  const bodySnippet = buffer.slice(bodyStart, bodyStart + 1024).trim() || undefined;

  const result = parseSkillText({ ...options, text: frontmatterOnly });
  const definition = { ...result, content: LAZY_CONTENT_SENTINEL, bodySnippet };

  // Flat .md skills are allowed to omit description and derive it from the
  // first body line. The frontmatter-only parse has no body, so re-parse the
  // full file when that fallback was triggered.
  const isDirectorySkill = path.basename(options.skillMdPath) === 'SKILL.md';
  if (!isDirectorySkill && definition.description === 'No description provided.') {
    const full = await parseSkillFromFile(options);
    return { ...definition, description: full.description };
  }

  return definition;
}

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

/**
 * Expand argument placeholders in a skill body.
 *
 * Placeholder syntax ($ARGUMENTS, $0, $name, etc.) is modelled after common
 * shell/CLI conventions rather than any specific product.
 */
export function expandSkillParameters(
  body: string,
  rawArgs: string,
  context: SkillExpandContext,
): string {
  const tokens = tokenizeArgs(rawArgs);
  let content = body;

  for (let index = 0; index < (context.argumentNames?.length ?? 0); index++) {
    const name = context.argumentNames?.[index];
    if (name === undefined) continue;
    const escaped = regexpEscape(name);
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
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const firstSentence = lines
    .join(' ')
    .match(/[^.!?]+[.!?]+/);
  const candidate = firstSentence?.[0]?.trim() ?? lines.find((line) => line.length > 0);
  if (candidate === undefined) return 'No description provided.';
  return candidate.length > 240 ? `${candidate.slice(0, 239)}…` : candidate;
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
