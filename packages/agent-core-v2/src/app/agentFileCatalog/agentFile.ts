/**
 * `agentFileCatalog` domain (L3) — agent-file parsing primitives.
 *
 * Parses a single agent Markdown file (frontmatter + body) into an
 * `AgentFileDefinition`. Pure functions with no IO: callers read bytes however
 * they like and pass the decoded text in, mirroring `skillCatalog/parser`.
 * Unknown frontmatter fields are ignored so later format extensions stay
 * forward-compatible. Compatibility conventions match other agent CLIs: a
 * missing `name` falls back to the file name (OpenCode), a lone `*` in
 * `tools` / `subagents` means unrestricted like an omitted field, and list
 * fields accept either a bare comma-separated string or the YAML list form
 * (Claude Code).
 */

import { FrontmatterError, parseFrontmatter } from '#/app/skillCatalog/parser';

import type { AgentFileDefinition, AgentFileSource } from './types';

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

  const nameField = frontmatter['name'];
  if (nameField !== undefined && nameField !== null && typeof nameField !== 'string') {
    throw new AgentFileParseError(
      `Frontmatter field "name" in ${options.path} must be a non-empty string`,
    );
  }
  const name = nonEmptyString(nameField) ?? deriveNameFromPath(options.path);
  if (name === undefined) {
    throw new AgentFileParseError(`Missing required frontmatter field "name" in ${options.path}`);
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AgentFileParseError(
      `Invalid agent name "${name}" in ${options.path}: expected kebab-case (e.g. "code-reviewer")`,
    );
  }

  const description = requiredNonEmptyString(
    frontmatter['description'],
    'description',
    options.path,
  );

  const override = parseBoolean(frontmatter['override'], 'override', options.path);
  const rawTools = parseStringList(frontmatter['tools'], 'tools', options.path);
  const tools = rawTools?.length === 1 && rawTools[0] === '*' ? undefined : rawTools;
  const disallowedTools = parseStringList(
    frontmatter['disallowedTools'],
    'disallowedTools',
    options.path,
  );
  const rawSubagents = parseStringList(frontmatter['subagents'], 'subagents', options.path);
  const subagents =
    rawSubagents?.length === 1 && rawSubagents[0] === '*' ? undefined : rawSubagents;
  const modelPreference = parseModelPreference(frontmatter['model_preference'], options.path);

  const prompt = parsed.body.trim();
  if (prompt.length === 0) {
    throw new AgentFileParseError(`Missing prompt body in ${options.path}`);
  }

  return {
    name,
    description,
    whenToUse: nonEmptyString(frontmatter['whenToUse']),
    override,
    tools,
    disallowedTools,
    subagents,
    modelPreference,
    prompt,
    path: options.path,
    source: options.source,
  };
}

function parseModelPreference(
  value: unknown,
  filePath: string,
): AgentFileDefinition['modelPreference'] {
  if (value === undefined || value === null) return undefined;
  if (value === 'primary' || value === 'secondary') return value;
  throw new AgentFileParseError(
    `Frontmatter field "model_preference" in ${filePath} must be "primary" or "secondary"`,
  );
}

function parseBoolean(value: unknown, field: string, filePath: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw new AgentFileParseError(
    `Frontmatter field "${field}" in ${filePath} must be a boolean`,
  );
}

function parseStringList(
  value: unknown,
  field: string,
  filePath: string,
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  if (!Array.isArray(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a comma-separated string or a list of strings`,
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

function requiredNonEmptyString(value: unknown, field: string, filePath: string): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a non-empty string`,
    );
  }
  const parsed = nonEmptyString(value);
  if (parsed === undefined) {
    throw new AgentFileParseError(`Missing required frontmatter field "${field}" in ${filePath}`);
  }
  return parsed;
}

function deriveNameFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');
  return name !== '' ? name : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
