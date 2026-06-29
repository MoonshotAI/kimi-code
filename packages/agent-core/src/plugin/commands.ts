import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from '../skill/parser';
import type { PluginCommandDef } from './types';

export function parseCommandText(input: {
  readonly text: string;
  readonly commandPath: string;
  readonly pluginId: string;
  readonly fallbackName?: string;
}): PluginCommandDef {
  const { text, commandPath, pluginId } = input;
  const parsed = parseFrontmatter(text);
  const frontmatter = isRecord(parsed.data) ? parsed.data : {};

  const baseName = input.fallbackName ?? path.basename(commandPath).replace(/\.md$/i, '');
  const name = nonEmptyString(frontmatter['name']) ?? baseName;

  const body = parsed.body.trim();
  const description = nonEmptyString(frontmatter['description']) ?? descriptionFromBody(body);

  return {
    pluginId,
    name,
    description,
    body,
    path: path.resolve(commandPath),
  };
}

export async function loadPluginCommand(input: {
  readonly commandPath: string;
  readonly pluginId: string;
  readonly fallbackName?: string;
}): Promise<PluginCommandDef | undefined> {
  try {
    const text = await readFile(input.commandPath, 'utf8');
    return parseCommandText({
      text,
      commandPath: input.commandPath,
      pluginId: input.pluginId,
      fallbackName: input.fallbackName,
    });
  } catch {
    return undefined;
  }
}

/**
 * Expand `$ARGUMENTS` placeholders in a plugin command body with the typed args.
 * If the body has no placeholder but args are present, append them so nothing
 * is silently dropped.
 */
export function expandCommandArguments(body: string, args: string): string {
  const replaced = body.replaceAll('$ARGUMENTS', args);
  if (!body.includes('$ARGUMENTS') && args.length > 0) {
    return `${replaced}\n\nARGUMENTS: ${args}`;
  }
  return replaced;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function descriptionFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return 'No description provided.';
  return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
