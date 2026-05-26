import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '../config/schema';
import {
  PLUGIN_NAME_REGEX,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
} from './types';

const PLUGIN_JSON_PATH = 'plugin.json';
const KIMI_PLUGIN_JSON_PATH = '.kimi-plugin/plugin.json';

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const pluginJsonPath = path.join(pluginRoot, PLUGIN_JSON_PATH);
  const kimiPluginJsonPath = path.join(pluginRoot, KIMI_PLUGIN_JSON_PATH);
  const pluginJsonExists = await isFile(pluginJsonPath);
  const kimiPluginJsonExists = await isFile(kimiPluginJsonPath);

  if (!pluginJsonExists && !kimiPluginJsonExists) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.missing',
          message: `No manifest at ${PLUGIN_JSON_PATH} or ${KIMI_PLUGIN_JSON_PATH}`,
        },
      ],
    };
  }

  const manifestPath = pluginJsonExists ? pluginJsonPath : kimiPluginJsonPath;
  const manifestKind: PluginManifestKind = pluginJsonExists ? 'plugin-json' : 'kimi-plugin';
  const shadowedManifestPath =
    pluginJsonExists && kimiPluginJsonExists ? kimiPluginJsonPath : undefined;

  let raw: unknown;
  try {
    const text = await readFile(manifestPath, 'utf8');
    raw = JSON.parse(text);
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.invalid_json',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.invalid_json',
          message: 'manifest must be a JSON object',
        },
      ],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.missing_name',
      message: '"name" is required',
    });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.invalid_name',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }

  let skills = await resolveSkillsField(pluginRoot, raw['skills'], diagnostics);

  if (raw['skills'] === undefined) {
    const rootSkillMd = path.join(pluginRoot, 'SKILL.md');
    if (await isFile(rootSkillMd)) {
      skills = [pluginRoot];
    }
  }

  const skillInstructions =
    typeof raw['skillInstructions'] === 'string' ? raw['skillInstructions'] : undefined;

  recordUnsupportedPluginJsonFields(raw, diagnostics);
  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    keywords: stringArrayField(raw, 'keywords'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    sessionStart: readSessionStart(raw['sessionStart'], diagnostics),
    mcpServers: await readMcpServers(pluginRoot, raw['mcpServers'], diagnostics),
    interface: readInterface(raw['interface']),
    skillInstructions,
  };

  return {
    manifest,
    manifestKind,
    manifestPath,
    shadowedManifestPath,
    diagnostics,
  };
}

function recordUnsupportedPluginJsonFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of [
    'tools',
    'configFile',
    'config_file',
    'inject',
    'bootstrap',
    'hooks',
    'apps',
  ] as const) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
      code: `manifest.unsupported_field.${field}`,
      message: `"${field}" is present but not supported by Kimi plugins`,
    });
  }
}

async function resolveSkillsField(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.skills.invalid_type',
      message: '"skills" must be a string or string[]',
    });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.skills.path_required_dot_slash',
        message: `"skills" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute; // missing path is allowed; we'll catch via not_a_directory below
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.skills.path_escape',
        message: `"skills" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
        code: 'manifest.skills.not_a_directory',
        message: `"skills" path is not a directory (${entry})`,
      });
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}

async function resolvePluginPathField(input: {
  readonly pluginRoot: string;
  readonly field: string;
  readonly value: string;
  readonly diagnostics: PluginDiagnostic[];
  readonly codePrefix: string;
}): Promise<string | undefined> {
  if (!input.value.startsWith('./')) {
    input.diagnostics.push({
      severity: 'warn',
      code: `${input.codePrefix}.path_required_dot_slash`,
      message: `"${input.field}" path must start with "./" (got "${input.value}")`,
    });
    return undefined;
  }
  const absolute = path.resolve(input.pluginRoot, input.value);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    real = absolute;
  }
  const rootReal = await realpath(input.pluginRoot).catch(() => input.pluginRoot);
  if (!isWithin(real, rootReal)) {
    input.diagnostics.push({
      severity: 'warn',
      code: `${input.codePrefix}.path_escape`,
      message: `"${input.field}" path resolves outside the plugin (${input.value})`,
    });
    return undefined;
  }
  return real;
}

function readSessionStart(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): PluginManifest['sessionStart'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({
      severity: 'warn',
      code: 'manifest.sessionStart.invalid_type',
      message: '"sessionStart" must be an object',
    });
    return undefined;
  }

  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) {
    diagnostics.push({
      severity: 'warn',
      code: 'manifest.sessionStart.missing_skill',
      message: '"sessionStart.skill" is required when sessionStart is present',
    });
    return undefined;
  }
  return { skill };
}

async function readMcpServers(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<PluginManifest['mcpServers']> {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({
      severity: 'warn',
      code: 'manifest.mcpServers.invalid_type',
      message: '"mcpServers" must be an object',
    });
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({
        severity: 'warn',
        code: 'manifest.mcpServers.invalid_name',
        message: '"mcpServers" entries must have a non-empty name',
      });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        code: `manifest.mcpServers.${trimmedName}.invalid`,
        message: `Invalid MCP server "${trimmedName}": ${parsed.error.message}`,
      });
      continue;
    }
    const normalized = await normalizePluginMcpServer({
      pluginRoot,
      name: trimmedName,
      config: parsed.data,
      diagnostics,
    });
    if (normalized !== undefined) out[trimmedName] = normalized;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

async function normalizePluginMcpServer(input: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<McpServerConfig | undefined> {
  const { config } = input;
  if (config.transport === 'http') return config;

  let command = config.command;
  if (command.startsWith('./')) {
    const resolvedCommand = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.command`,
      value: command,
      diagnostics: input.diagnostics,
      codePrefix: `manifest.mcpServers.${input.name}.command`,
    });
    if (resolvedCommand === undefined) return undefined;
    command = resolvedCommand;
  } else if (command.includes('/') || path.isAbsolute(command)) {
    input.diagnostics.push({
      severity: 'warn',
      code: `manifest.mcpServers.${input.name}.command.path_required_dot_slash`,
      message: `"mcpServers.${input.name}.command" must be a PATH command or start with "./"`,
    });
    return undefined;
  }

  let cwd = config.cwd;
  if (cwd !== undefined) {
    const resolvedCwd = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.cwd`,
      value: cwd,
      diagnostics: input.diagnostics,
      codePrefix: `manifest.mcpServers.${input.name}.cwd`,
    });
    if (resolvedCwd === undefined) return undefined;
    cwd = resolvedCwd;
  }

  return { ...config, command, cwd };
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, 'displayName'),
    shortDescription: stringField(raw, 'shortDescription'),
    longDescription: stringField(raw, 'longDescription'),
    developerName: stringField(raw, 'developerName'),
    capabilities: stringArrayField(raw, 'capabilities'),
    websiteURL: stringField(raw, 'websiteURL'),
    defaultPrompt: defaultPromptField(raw['defaultPrompt']),
  };
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function defaultPromptField(raw: unknown): PluginInterface['defaultPrompt'] {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return raw as readonly string[];
  }
  return undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
