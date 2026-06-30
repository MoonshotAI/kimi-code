import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  HookDefSchema,
  McpServerConfigSchema,
  type HookDefConfig,
  type McpServerConfig,
} from '../config/schema';
import {
  PLUGIN_NAME_REGEX,
  type PluginCommandEntry,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
} from './types';

const KIMI_PLUGIN_ROOT_PATH = 'kimi.plugin.json';
const KIMI_PLUGIN_DIR_PATH = '.kimi-plugin/plugin.json';

// Fields that look like third-party runtime extensions (Claude / Codex / old
// Kimi CLI). We do not run them; emit an info diagnostic so plugin authors and
// users can see why a field is silently ignored.
const UNSUPPORTED_RUNTIME_FIELDS = [
  'tools',
  'apps',
  'inject',
  'configFile',
  'config_file',
  'bootstrap',
] as const;

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const rootJsonPath = path.join(pluginRoot, KIMI_PLUGIN_ROOT_PATH);
  const dirJsonPath = path.join(pluginRoot, KIMI_PLUGIN_DIR_PATH);
  const rootJsonExists = await isFile(rootJsonPath);
  const dirJsonExists = await isFile(dirJsonPath);

  if (!rootJsonExists && !dirJsonExists) {
    return {
      diagnostics: [
        {
          severity: 'error',
          message: `No manifest at ${KIMI_PLUGIN_ROOT_PATH} or ${KIMI_PLUGIN_DIR_PATH}`,
        },
      ],
    };
  }

  const manifestPath = rootJsonExists ? rootJsonPath : dirJsonPath;
  const manifestKind: PluginManifestKind = rootJsonExists ? 'kimi-plugin-root' : 'kimi-plugin-dir';
  const shadowedManifestPath = rootJsonExists && dirJsonExists ? dirJsonPath : undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
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
      diagnostics: [{ severity: 'error', message: 'manifest must be a JSON object' }],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({ severity: 'error', message: '"name" is required' });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
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

  recordUnsupportedRuntimeFields(raw, diagnostics);

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
    hooks: readHooks(raw['hooks'], diagnostics),
    commands: await readCommands(pluginRoot, raw['commands'], diagnostics),
    interface: readInterface(raw['interface']),
    skillInstructions,
  };

  return { manifest, manifestKind, manifestPath, shadowedManifestPath, diagnostics };
}

function recordUnsupportedRuntimeFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
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
    diagnostics.push({ severity: 'error', message: '"skills" must be a string or string[]' });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        message: `"skills" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute;
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        message: `"skills" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
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
}): Promise<string | undefined> {
  if (!input.value.startsWith('./')) {
    input.diagnostics.push({
      severity: 'warn',
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
    diagnostics.push({ severity: 'warn', message: '"sessionStart" must be an object' });
    return undefined;
  }
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) {
    diagnostics.push({
      severity: 'warn',
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
    diagnostics.push({ severity: 'warn', message: '"mcpServers" must be an object' });
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({
        severity: 'warn',
        message: '"mcpServers" entries must have a non-empty name',
      });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
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

function readHooks(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): readonly HookDefConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({ severity: 'warn', message: '"hooks" must be an array' });
    return undefined;
  }
  const out: HookDefConfig[] = [];
  raw.forEach((entry, i) => {
    const parsed = HookDefSchema.safeParse(entry);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid hook at index ${i}: ${parsed.error.message}`,
      });
    } else {
      out.push(parsed.data);
    }
  });
  return out.length === 0 ? undefined : out;
}

async function readCommands(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly PluginCommandEntry[] | undefined> {
  if (raw === undefined) return undefined;
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'warn', message: '"commands" must be a string or string[]' });
    return undefined;
  }

  const files: PluginCommandEntry[] = [];
  for (const entry of entries) {
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: 'commands',
      value: entry,
      diagnostics,
    });
    if (resolved === undefined) continue;
    if (await isDir(resolved)) {
      files.push(...(await listMarkdownFilesRecursive(resolved)));
    } else if ((await isFile(resolved)) && resolved.endsWith('.md')) {
      files.push({ path: resolved, name: commandNameFromFile(resolved, path.dirname(resolved)) });
    } else {
      diagnostics.push({
        severity: 'warn',
        message: `"commands" entry must be a directory or .md file (${entry})`,
      });
    }
  }
  return files.length === 0 ? undefined : files.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function listMarkdownFilesRecursive(root: string): Promise<readonly PluginCommandEntry[]> {
  const out: PluginCommandEntry[] = [];
  await walkMarkdown(root, root, out);
  return out;
}

async function walkMarkdown(
  root: string,
  dir: string,
  out: PluginCommandEntry[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ path: full, name: commandNameFromFile(full, root) });
    }
  }
}

function commandNameFromFile(file: string, root: string): string {
  const relative = path.relative(root, file).replace(/\.md$/i, '');
  return relative.split(path.sep).join('/');
}

async function normalizePluginMcpServer(input: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<McpServerConfig | undefined> {
  const { config } = input;
  if (config.transport === 'http' || config.transport === 'sse') return config;

  let command = config.command;
  if (command.startsWith('./')) {
    const resolvedCommand = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.command`,
      value: command,
      diagnostics: input.diagnostics,
    });
    if (resolvedCommand === undefined) return undefined;
    command = resolvedCommand;
  } else if (command.includes('/') || path.isAbsolute(command)) {
    input.diagnostics.push({
      severity: 'warn',
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
    websiteURL: stringField(raw, 'websiteURL'),
  };
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
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
