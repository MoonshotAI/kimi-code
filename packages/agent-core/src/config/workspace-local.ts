import type { Kaos } from '@moonshot-ai/kaos';
import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

const SubagentBindingTomlSchema = z.object({
  model: z.string().optional(),
  thinking_effort: z.string().optional(),
  inherit: z.boolean().optional(),
});

const WorkspaceLocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
  subagent: z.record(z.string(), SubagentBindingTomlSchema).optional(),
  'subagent-slot': z.record(z.string(), SubagentBindingTomlSchema).optional(),
});

type WorkspaceLocalToml = z.infer<typeof WorkspaceLocalTomlSchema>;

export interface WorkspaceAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly warning?: string;
}

export type WorkspaceLocalConfig = WorkspaceAdditionalDirsLoadResult;

interface WorkspaceLocalTomlFile {
  readonly raw: Record<string, unknown>;
  readonly parsed: WorkspaceLocalToml;
}

export async function loadWorkspaceLocalConfig(
  kaos: Kaos,
  workDir: string,
): Promise<WorkspaceLocalConfig> {
  const projectRoot = await findProjectRoot(kaos, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const file = await readWorkspaceLocalToml(kaos, configPath);

  const additionalDirs = file?.parsed.workspace?.additional_dir;
  if (additionalDirs === undefined) {
    return { projectRoot, configPath, additionalDirs: [] };
  }

  return {
    projectRoot,
    configPath,
    additionalDirs: await resolveAdditionalDirs(kaos, projectRoot, additionalDirs),
  };
}

export async function readWorkspaceAdditionalDirs(
  kaos: Kaos,
  workDir: string,
): Promise<WorkspaceAdditionalDirsLoadResult> {
  return loadWorkspaceLocalConfig(kaos, workDir);
}

export async function resolveWorkspaceAdditionalDirs(
  kaos: Kaos,
  projectRoot: string,
  additionalDirs: readonly string[],
): Promise<string[]> {
  return resolveAdditionalDirs(kaos, projectRoot, additionalDirs);
}

export async function appendWorkspaceAdditionalDir(
  kaos: Kaos,
  workDir: string,
  inputPath: string,
  _currentAdditionalDirs: readonly string[],
): Promise<WorkspaceAdditionalDirsLoadResult> {
  const projectRoot = await findProjectRoot(kaos, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const additionalDir = await resolveAdditionalDir(kaos, workDir, inputPath);
  const file = (await readWorkspaceLocalToml(kaos, configPath)) ?? { raw: {}, parsed: {} };
  const fileAdditionalDirs = file.parsed.workspace?.additional_dir ?? [];
  const fileExistingDirs = resolveExistingAdditionalDirs(kaos, projectRoot, fileAdditionalDirs);

  if (hasSameAdditionalDir(kaos, fileExistingDirs, additionalDir)) {
    return { projectRoot, configPath, additionalDirs: fileExistingDirs };
  }

  const workspace = cloneRecord(file.raw['workspace']);
  workspace['additional_dir'] = [...fileExistingDirs, additionalDir];
  file.raw['workspace'] = workspace;

  await kaos.mkdir(dirname(configPath), { parents: true, existOk: true });
  await kaos.writeText(configPath, `${stringifyToml(file.raw)}\n`);

  return { projectRoot, configPath, additionalDirs: [...fileExistingDirs, additionalDir] };
}

/**
 * Per-workspace model/effort binding for one subagent type, stored in
 * `<projectRoot>/.kimi-code/local.toml` under `[subagent.<type>]`.
 *
 * `inherit: true` is an explicit user choice to keep parent inheritance —
 * recorded so the Agent tool does not re-ask on every spawn.
 */
export interface SubagentBinding {
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly inherit?: boolean;
}

/** Read the binding for one subagent type; `undefined` means never configured. */
export async function readSubagentBinding(
  kaos: Kaos,
  workDir: string,
  agentType: string,
): Promise<SubagentBinding | undefined> {
  return readBindingEntry(kaos, workDir, 'subagent', agentType);
}

/** Read all subagent bindings for the workspace (for display/management). */
export async function readSubagentBindings(
  kaos: Kaos,
  workDir: string,
): Promise<Readonly<Record<string, SubagentBinding>>> {
  return readBindingSection(kaos, workDir, 'subagent');
}

/**
 * Write (or clear, when `binding` is `undefined`) the binding for one
 * subagent type, preserving unrelated TOML content.
 */
export async function writeSubagentBinding(
  kaos: Kaos,
  workDir: string,
  agentType: string,
  binding: SubagentBinding | undefined,
): Promise<{ readonly configPath: string }> {
  return writeBindingEntry(kaos, workDir, 'subagent', agentType, binding);
}

/**
 * Named binding slots (`[subagent-slot.<name>]`): instance-level bindings the
 * Agent tool selects via its `binding_slot` parameter. Unlike type bindings,
 * slots let a caller address a specific pre-configured model/effort pair —
 * the caller names a slot, never a model.
 */
export async function readSubagentSlotBinding(
  kaos: Kaos,
  workDir: string,
  slot: string,
): Promise<SubagentBinding | undefined> {
  return readBindingEntry(kaos, workDir, 'subagent-slot', slot);
}

/** Read all named slot bindings for the workspace (for display/management). */
export async function readSubagentSlotBindings(
  kaos: Kaos,
  workDir: string,
): Promise<Readonly<Record<string, SubagentBinding>>> {
  return readBindingSection(kaos, workDir, 'subagent-slot');
}

/**
 * Write (or clear, when `binding` is `undefined`) the binding for one named
 * slot, preserving unrelated TOML content.
 */
export async function writeSubagentSlotBinding(
  kaos: Kaos,
  workDir: string,
  slot: string,
  binding: SubagentBinding | undefined,
): Promise<{ readonly configPath: string }> {
  return writeBindingEntry(kaos, workDir, 'subagent-slot', slot, binding);
}

type BindingSection = 'subagent' | 'subagent-slot';

async function readBindingEntry(
  kaos: Kaos,
  workDir: string,
  section: BindingSection,
  name: string,
): Promise<SubagentBinding | undefined> {
  const projectRoot = await findProjectRoot(kaos, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const file = await readWorkspaceLocalToml(kaos, configPath);
  const entry = file?.parsed[section]?.[name];
  if (entry === undefined) return undefined;
  return {
    model: entry.model,
    thinkingEffort: entry.thinking_effort,
    inherit: entry.inherit,
  };
}

async function readBindingSection(
  kaos: Kaos,
  workDir: string,
  section: BindingSection,
): Promise<Readonly<Record<string, SubagentBinding>>> {
  const projectRoot = await findProjectRoot(kaos, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const file = await readWorkspaceLocalToml(kaos, configPath);
  const entries = file?.parsed[section] ?? {};
  return Object.fromEntries(
    Object.entries(entries).map(([type, entry]) => [
      type,
      { model: entry.model, thinkingEffort: entry.thinking_effort, inherit: entry.inherit },
    ]),
  );
}

async function writeBindingEntry(
  kaos: Kaos,
  workDir: string,
  section: BindingSection,
  name: string,
  binding: SubagentBinding | undefined,
): Promise<{ readonly configPath: string }> {
  const projectRoot = await findProjectRoot(kaos, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const file = (await readWorkspaceLocalToml(kaos, configPath)) ?? { raw: {}, parsed: {} };

  const record = cloneRecord(file.raw[section]);
  if (binding === undefined) {
    delete record[name];
  } else {
    const entry: Record<string, unknown> = {};
    if (binding.model !== undefined) entry['model'] = binding.model;
    if (binding.thinkingEffort !== undefined) entry['thinking_effort'] = binding.thinkingEffort;
    if (binding.inherit !== undefined) entry['inherit'] = binding.inherit;
    record[name] = entry;
  }
  if (Object.keys(record).length === 0) {
    delete file.raw[section];
  } else {
    file.raw[section] = record;
  }

  await kaos.mkdir(dirname(configPath), { parents: true, existOk: true });
  await kaos.writeText(configPath, `${stringifyToml(file.raw)}\n`);
  return { configPath };
}

export function normalizeAdditionalDirs(additionalDirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalizedDirs: string[] = [];

  for (const additionalDir of additionalDirs) {
    const normalized = normalize(additionalDir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedDirs.push(normalized);
  }

  return normalizedDirs;
}

function getWorkspaceLocalConfigPath(projectRoot: string): string {
  return join(projectRoot, '.kimi-code', 'local.toml');
}

async function findProjectRoot(kaos: Kaos, workDir: string): Promise<string> {
  const initial = resolveWorkDir(kaos, workDir);
  let current = initial;

  for (;;) {
    if (await pathExists(kaos, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function resolveWorkDir(kaos: Kaos, workDir: string): string {
  return isAbsolute(workDir) ? kaos.normpath(workDir) : resolve(kaos.getcwd(), workDir);
}

async function readWorkspaceLocalToml(
  kaos: Kaos,
  configPath: string,
): Promise<WorkspaceLocalTomlFile | undefined> {
  let text: string;
  try {
    text = await kaos.readText(configPath);
  } catch (error: unknown) {
    if (isPathMissing(error)) return undefined;
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (text.trim().length === 0) return { raw: {}, parsed: {} };

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error: unknown) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (!isPlainObject(raw)) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid workspace local config in ${configPath}`);
  }

  return { raw: cloneRecord(raw), parsed: parseWorkspaceLocalToml(raw) };
}

function parseWorkspaceLocalToml(raw: Record<string, unknown>): WorkspaceLocalToml {
  try {
    return WorkspaceLocalTomlSchema.parse(raw);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, describeWorkspaceLocalValidationError(error), {
        cause: error,
      });
    }
    throw error;
  }
}

function describeWorkspaceLocalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'workspace' && issue.path[1] === 'additional_dir') {
    return 'workspace.additional_dir must be an array of strings';
  }
  if (issue?.path[0] === 'workspace') return 'workspace must be a table';
  return `Invalid workspace local config: ${error.message}`;
}

async function resolveAdditionalDirs(
  kaos: Kaos,
  projectRoot: string,
  additionalDirs: readonly string[],
): Promise<string[]> {
  const resolvedDirs: string[] = [];

  for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
    const resolvedDir = await resolveAdditionalDir(kaos, projectRoot, additionalDir);
    if (hasSameAdditionalDir(kaos, resolvedDirs, resolvedDir)) continue;
    resolvedDirs.push(resolvedDir);
  }

  return resolvedDirs;
}

function resolveExistingAdditionalDirs(
  kaos: Kaos,
  projectRoot: string,
  additionalDirs: readonly string[],
): string[] {
  const resolvedDirs: string[] = [];

  for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
    const resolvedDir = resolvePath(kaos, projectRoot, additionalDir);
    if (hasSameAdditionalDir(kaos, resolvedDirs, resolvedDir)) continue;
    resolvedDirs.push(resolvedDir);
  }

  return resolvedDirs;
}

async function resolveAdditionalDir(
  kaos: Kaos,
  projectRoot: string,
  additionalDir: string,
): Promise<string> {
  const normalizedInput = normalizeAdditionalDirInput(additionalDir);
  const resolvedDir = resolvePath(kaos, projectRoot, normalizedInput);
  await assertDirectory(kaos, resolvedDir);
  return resolvedDir;
}

function normalizeAdditionalDirInput(additionalDir: string): string {
  if (typeof additionalDir !== 'string') {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, 'workspace.additional_dir must be an array of strings');
  }
  const trimmed = additionalDir.trim();
  if (trimmed.length === 0) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      'workspace.additional_dir must exist and be a directory',
    );
  }
  return normalize(trimmed);
}

function resolvePath(kaos: Kaos, projectRoot: string, additionalDir: string): string {
  const expanded = expandHome(kaos, additionalDir);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(projectRoot, expanded);
}

function expandHome(kaos: Kaos, value: string): string {
  if (value === '~') return kaos.gethome();
  if (value.startsWith('~/')) return join(kaos.gethome(), value.slice(2));
  return value;
}

function hasSameAdditionalDir(kaos: Kaos, dirs: readonly string[], target: string): boolean {
  const normalizedTarget = normalizeForCompare(kaos, target);
  return dirs.some((dir) => normalizeForCompare(kaos, dir) === normalizedTarget);
}

function normalizeForCompare(kaos: Kaos, filePath: string): string {
  return kaos.normpath(filePath);
}

async function assertDirectory(kaos: Kaos, filePath: string): Promise<void> {
  try {
    const stat = await kaos.stat(filePath);
    if ((stat.stMode & S_IFMT) === S_IFDIR) return;
  } catch (error: unknown) {
    if (isPathMissing(error)) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        'workspace.additional_dir must exist and be a directory',
      );
    }
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to stat ${filePath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  throw new KimiError(
    ErrorCodes.CONFIG_INVALID,
    'workspace.additional_dir must exist and be a directory',
  );
}

async function pathExists(kaos: Kaos, filePath: string): Promise<boolean> {
  try {
    await kaos.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathMissing(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function getErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code: unknown }).code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
