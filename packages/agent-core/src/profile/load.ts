import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'pathe';

import { load as loadYaml } from 'js-yaml';

import { resolveAgentProfiles } from './resolve';
import { RawAgentProfileSchema, type RawAgentProfile, type ResolvedAgentProfile } from './types';

export async function loadAgentProfilesFromDir(
  paths: readonly string[],
): Promise<Record<string, ResolvedAgentProfile>> {
  const rawProfiles = await loadRawAgentProfiles(paths);
  return resolveAgentProfiles(rawProfiles);
}

export function loadAgentProfilesFromSources(
  paths: readonly string[],
  sources: Readonly<Record<string, string>>,
): Record<string, ResolvedAgentProfile> {
  const rawProfiles = paths.map((profilePath) =>
    finalizeRawAgentProfileSource(readRequiredSource(sources, profilePath), profilePath, sources),
  );
  return resolveAgentProfiles(rawProfiles);
}

async function loadRawAgentProfiles(paths: readonly string[]): Promise<RawAgentProfile[]> {
  const profiles: RawAgentProfile[] = [];

  for (const profilePath of paths) {
    let content: string;
    try {
      content = await readFile(profilePath, 'utf-8');
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw readError('agent profile', profilePath, error);
    }
    profiles.push(await finalizeRawAgentProfile(content, profilePath));
  }

  return profiles;
}

async function finalizeRawAgentProfile(
  content: string,
  profilePath: string,
): Promise<RawAgentProfile> {
  const raw = parseAgentProfileYaml(content, profilePath);
  if (raw.systemPromptPath === undefined) return raw;
  const templatePath = join(dirname(profilePath), raw.systemPromptPath);
  try {
    return { ...raw, systemPromptTemplate: await readFile(templatePath, 'utf-8') };
  } catch (error) {
    throw new Error(
      `Failed to read system prompt template for "${raw.name}" at ${templatePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function finalizeRawAgentProfileSource(
  content: string,
  profilePath: string,
  sources: Readonly<Record<string, string>>,
): RawAgentProfile {
  const raw = parseAgentProfileYaml(content, profilePath);
  if (raw.systemPromptPath === undefined) return raw;
  const templatePath = resolveProfileSourcePath(profilePath, raw.systemPromptPath);
  return { ...raw, systemPromptTemplate: readRequiredSource(sources, templatePath) };
}

function parseAgentProfileYaml(content: string, profilePath: string): RawAgentProfile {
  let parsed: unknown;
  try {
    parsed = loadYaml(content);
  } catch (error) {
    throw new Error(
      `Invalid agent profile YAML at ${profilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const result = RawAgentProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid agent profile at ${profilePath}`);
  }
  return result.data;
}

function resolveProfileSourcePath(profilePath: string, relativePath: string): string {
  return normalizeSourcePath(
    join(dirname(normalizeSourcePath(profilePath)), relativePath),
  );
}

function readRequiredSource(sources: Readonly<Record<string, string>>, path: string): string {
  const normalized = normalizeSourcePath(path);
  const content = sources[normalized];
  if (content === undefined) {
    throw new Error(`Embedded agent profile source missing: ${normalized}`);
  }
  return content;
}

function normalizeSourcePath(path: string): string {
  return normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function readError(label: string, filePath: string, error: unknown): Error {
  return new Error(
    `Failed to read ${label} at ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
