/**
 * `FileProjectLocalConfigService` — node-fs backend for `IProjectLocalConfigService`.
 *
 * Discovers project roots, parses and writes project-local
 * `.kimi-code/local.toml`, resolves additional directories with
 * v1-compatible OS-home expansion through `bootstrap`, and accesses the local
 * filesystem through `hostFs`. Works purely by path (project-root discovery
 * via the nearest `.git` ancestor); it never touches the workspace catalog or
 * a `workspaceId`. Bound at App scope.
 */

import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IProjectLocalConfigService,
  type ProjectAdditionalDirsLoadResult,
} from '#/app/projectLocalConfig/projectLocalConfig';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { StorageError, StorageErrors, toStorageIoError } from '#/persistence/interface/storage';

const ProjectLocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
});

type ProjectLocalToml = z.infer<typeof ProjectLocalTomlSchema>;

interface ProjectLocalTomlFile {
  readonly raw: Record<string, unknown>;
  readonly parsed: ProjectLocalToml;
}

export class FileProjectLocalConfigService implements IProjectLocalConfigService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  async readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult> {
    const projectRoot = await this.findProjectRoot(workDir);
    const configPath = this.getProjectLocalConfigPath(projectRoot);
    const file = await this.readProjectLocalToml(configPath);

    const additionalDirs = file?.parsed.workspace?.additional_dir;
    if (additionalDirs === undefined) {
      return { projectRoot, configPath, additionalDirs: [] };
    }

    return {
      projectRoot,
      configPath,
      additionalDirs: await this.resolveAdditionalDirs(projectRoot, additionalDirs),
    };
  }

  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]> {
    return this.resolveAdditionalDirsInternal(baseDir, additionalDirs);
  }

  async appendAdditionalDir(
    workDir: string,
    inputPath: string,
  ): Promise<ProjectAdditionalDirsLoadResult> {
    const projectRoot = await this.findProjectRoot(workDir);
    const configPath = this.getProjectLocalConfigPath(projectRoot);
    const additionalDir = await this.resolveAdditionalDir(workDir, inputPath);
    const file = (await this.readProjectLocalToml(configPath)) ?? { raw: {}, parsed: {} };
    const fileAdditionalDirs = file.parsed.workspace?.additional_dir ?? [];
    const fileExistingDirs = this.resolveExistingAdditionalDirs(projectRoot, fileAdditionalDirs);

    if (this.hasSameAdditionalDir(fileExistingDirs, additionalDir)) {
      return { projectRoot, configPath, additionalDirs: fileExistingDirs };
    }

    const workspace = cloneRecord(file.raw['workspace']);
    workspace['additional_dir'] = [...fileExistingDirs, additionalDir];
    file.raw['workspace'] = workspace;

    try {
      await this.fs.mkdir(dirname(configPath), { recursive: true });
      await this.fs.writeText(configPath, `${stringifyToml(file.raw)}\n`);
    } catch (error: unknown) {
      throw toStorageIoError(error, { path: configPath, op: 'write' });
    }

    return { projectRoot, configPath, additionalDirs: [...fileExistingDirs, additionalDir] };
  }

  private getProjectLocalConfigPath(projectRoot: string): string {
    return join(projectRoot, '.kimi-code', 'local.toml');
  }

  private async findProjectRoot(workDir: string): Promise<string> {
    const initial = normalize(workDir);
    let current = initial;

    while (true) {
      if (await this.pathExists(join(current, '.git'))) return current;
      const parent = dirname(current);
      if (parent === current) return initial;
      current = parent;
    }
  }

  private async readProjectLocalToml(
    configPath: string,
  ): Promise<ProjectLocalTomlFile | undefined> {
    let text: string;
    try {
      text = await this.fs.readText(configPath);
    } catch (error: unknown) {
      if (isPathMissing(error)) return undefined;
      throw toStorageIoError(error, { path: configPath, op: 'read' });
    }

    if (text.trim().length === 0) return { raw: {}, parsed: {} };

    let raw: unknown;
    try {
      raw = parseToml(text);
    } catch (error: unknown) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_DECODE_FAILED,
        `Invalid TOML in ${configPath}`,
        {
          details: { path: configPath, format: 'toml' },
          cause: error,
        },
      );
    }

    if (!isPlainObject(raw)) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid project local config in ${configPath}`,
      );
    }

    return { raw: cloneRecord(raw), parsed: parseProjectLocalToml(raw) };
  }

  private async resolveAdditionalDirsInternal(
    baseDir: string,
    additionalDirs: readonly string[],
  ): Promise<string[]> {
    const resolvedDirs: string[] = [];

    for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
      const resolvedDir = await this.resolveAdditionalDir(baseDir, additionalDir);
      if (this.hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
      resolvedDirs.push(resolvedDir);
    }

    return resolvedDirs;
  }

  private resolveExistingAdditionalDirs(
    projectRoot: string,
    additionalDirs: readonly string[],
  ): string[] {
    const resolvedDirs: string[] = [];

    for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
      const resolvedDir = this.resolvePath(projectRoot, additionalDir);
      if (this.hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
      resolvedDirs.push(resolvedDir);
    }

    return resolvedDirs;
  }

  private async resolveAdditionalDir(
    baseDir: string,
    additionalDir: string,
  ): Promise<string> {
    const normalizedInput = normalizeAdditionalDirInput(additionalDir);
    const resolvedDir = this.resolvePath(baseDir, normalizedInput);
    await this.assertDirectory(resolvedDir);
    return resolvedDir;
  }

  private resolvePath(baseDir: string, additionalDir: string): string {
    const expanded = this.expandHome(additionalDir);
    return isAbsolute(expanded) ? normalize(expanded) : resolve(baseDir, expanded);
  }

  private expandHome(value: string): string {
    if (value === '~') return this.bootstrap.osHomeDir;
    if (value.startsWith('~/')) return join(this.bootstrap.osHomeDir, value.slice(2));
    return value;
  }

  private hasSameAdditionalDir(dirs: readonly string[], target: string): boolean {
    const normalizedTarget = normalize(target);
    return dirs.some((dir) => normalize(dir) === normalizedTarget);
  }

  private async assertDirectory(filePath: string): Promise<void> {
    let stat: Awaited<ReturnType<IHostFileSystem['stat']>>;
    try {
      stat = await this.fs.stat(filePath);
    } catch (error: unknown) {
      if (isPathMissing(error)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          'workspace.additional_dir must exist and be a directory',
        );
      }
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }

    if (!stat.isDirectory) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        'workspace.additional_dir must exist and be a directory',
      );
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await this.fs.lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeAdditionalDirs(additionalDirs: readonly string[]): string[] {
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

function normalizeAdditionalDirInput(additionalDir: string): string {
  if (typeof additionalDir !== 'string') {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      'workspace.additional_dir must be an array of strings',
    );
  }
  const trimmed = additionalDir.trim();
  if (trimmed.length === 0) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      'workspace.additional_dir must exist and be a directory',
    );
  }
  return normalize(trimmed);
}

function parseProjectLocalToml(raw: Record<string, unknown>): ProjectLocalToml {
  try {
    return ProjectLocalTomlSchema.parse(raw);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, describeProjectLocalValidationError(error), {
        cause: error,
      });
    }
    throw error;
  }
}

function describeProjectLocalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'workspace' && issue.path[1] === 'additional_dir') {
    return 'workspace.additional_dir must be an array of strings';
  }
  if (issue?.path[0] === 'workspace') return 'workspace must be a table';
  return `Invalid project local config: ${error.message}`;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathMissing(error: unknown): boolean {
  const code = getErrorCode(unwrapErrorCause(error));
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function getErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code: unknown }).code;
}

registerScopedService(
  LifecycleScope.App,
  IProjectLocalConfigService,
  FileProjectLocalConfigService,
  InstantiationType.Eager,
  'projectLocalConfig',
);
