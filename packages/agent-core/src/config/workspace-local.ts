import { mkdir, readFile } from 'node:fs/promises';

import type { Kaos } from '@moonshot-ai/kaos';
import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';
import { writeFileAtomicDurable } from '#/utils/fs';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

const WorkspaceLocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
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
  const file = await readWorkspaceLocalToml(configPath);

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
  const additionalDir = await resolveAdditionalDir(kaos, projectRoot, inputPath);
  const file = (await readWorkspaceLocalToml(configPath)) ?? { raw: {}, parsed: {} };
  const fileAdditionalDirs = file.parsed.workspace?.additional_dir ?? [];
  const fileExistingDirs = resolveExistingAdditionalDirs(kaos, projectRoot, fileAdditionalDirs);

  if (hasSameAdditionalDir(kaos, fileExistingDirs, additionalDir)) {
    return { projectRoot, configPath, additionalDirs: fileExistingDirs };
  }

  const workspace = cloneRecord(file.raw['workspace']);
  workspace['additional_dir'] = [...fileExistingDirs, additionalDir];
  file.raw['workspace'] = workspace;

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFileAtomicDurable(configPath, `${stringifyToml(file.raw)}\n`);

  return { projectRoot, configPath, additionalDirs: [...fileExistingDirs, additionalDir] };
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

async function readWorkspaceLocalToml(configPath: string): Promise<WorkspaceLocalTomlFile | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
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
    const resolvedDir = resolvePath(projectRoot, additionalDir);
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
  const resolvedDir = resolvePath(projectRoot, normalizedInput);
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

function resolvePath(projectRoot: string, additionalDir: string): string {
  return isAbsolute(additionalDir) ? normalize(additionalDir) : resolve(projectRoot, additionalDir);
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
