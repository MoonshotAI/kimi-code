/**
 * `agentFileCatalog` domain (L3) — agent-file parsing primitives.
 *
 * Parses a single agent Markdown file (frontmatter + body) into an
 * `AgentFileDefinition`. Pure functions with no IO: callers read bytes however
 * they like and pass the decoded text in, mirroring `skillCatalog/parser`.
 * Unknown frontmatter fields are ignored so later format extensions stay
 * forward-compatible.
 */

import { FrontmatterError, parseFrontmatter } from '#/app/skillCatalog/parser';

import type { AgentFileDefinition, AgentFileSource, AgentPromptMode } from './types';

export class AgentFileParseError extends Error {
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentFileParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

export interface ParseAgentFileOptions {
  readonly path: string;
  readonly source: AgentFileSource;
  readonly text: string;
}

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseAgentFileText(options: ParseAgentFileOptions): AgentFileDefinition {
  let parsed;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new AgentFileParseError(
        `Invalid frontmatter in ${options.path}: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const frontmatter = parsed.data;
  if (frontmatter === null) {
    throw new AgentFileParseError(`Missing frontmatter in ${options.path}`);
  }
  if (!isRecord(frontmatter)) {
    throw new AgentFileParseError(
      `Frontmatter in ${options.path} must be a mapping at the top level`,
    );
  }

  const name = nonEmptyString(frontmatter['name']);
  if (name === undefined) {
    throw new AgentFileParseError(
      `Missing required frontmatter field "name" in ${options.path}`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AgentFileParseError(
      `Invalid agent name "${name}" in ${options.path}: expected kebab-case (e.g. "code-reviewer")`,
    );
  }

  const description = nonEmptyString(frontmatter['description']);
  if (description === undefined) {
    throw new AgentFileParseError(
      `Missing required frontmatter field "description" in ${options.path}`,
    );
  }

  const override = parseBoolean(frontmatter['override'], 'override', options.path);
  const mode = parseMode(frontmatter['mode'], options.path);
  const tools = parseStringList(frontmatter['tools'], 'tools', options.path);
  const disallowedTools = parseStringList(
    frontmatter['disallowedTools'],
    'disallowedTools',
    options.path,
  );

  const prompt = parsed.body.trim();
  if (prompt.length === 0) {
    throw new AgentFileParseError(`Missing prompt body in ${options.path}`);
  }

  return {
    name,
    description,
    whenToUse: nonEmptyString(frontmatter['whenToUse']),
    override,
    mode,
    tools,
    disallowedTools,
    prompt,
    path: options.path,
    source: options.source,
  };
}

function parseBoolean(value: unknown, field: string, filePath: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw new AgentFileParseError(
    `Frontmatter field "${field}" in ${filePath} must be a boolean`,
  );
}

function parseMode(value: unknown, filePath: string): AgentPromptMode {
  if (value === undefined || value === null) return 'replace';
  const mode = typeof value === 'string' ? value.trim() : undefined;
  if (mode === 'replace' || mode === 'append') return mode;
  throw new AgentFileParseError(
    `Invalid "mode" value ${JSON.stringify(value)} in ${filePath}: expected "replace" or "append"`,
  );
}

function parseStringList(
  value: unknown,
  field: string,
  filePath: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a list of strings`,
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new AgentFileParseError(
        `Frontmatter field "${field}" in ${filePath} must be a list of non-empty strings`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
