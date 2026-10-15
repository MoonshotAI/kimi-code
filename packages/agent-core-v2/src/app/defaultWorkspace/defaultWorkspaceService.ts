import { randomUUID } from 'node:crypto';

import { dirname, join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { DEFAULT_WORKSPACE_SECTION, type DefaultWorkspaceConfig } from './configSection';
import { IDefaultWorkspace, type DefaultWorkspaceStatus } from './defaultWorkspace';
import {
  DEFAULT_WORKSPACE_RELATIVE_ROOT,
  WINDOWS_DOCUMENTS_COMMAND,
  defaultDocumentsDir,
  parseWindowsDocumentsOutput,
  parseXdgDocumentsDir,
  resolveCustomRoot,
  windowsPowerShellPath,
} from './defaultWorkspacePaths';
import {
  DEFAULT_WORKSPACE_PROBLEM_MESSAGES,
  DefaultWorkspaceUnavailableError,
  type DefaultWorkspaceUnavailableReason,
} from './errors';

const WINDOWS_DOCUMENTS_TIMEOUT_MS = 15_000;

interface PathProbe {
  readonly exists: boolean;
  readonly problem: DefaultWorkspaceUnavailableReason | undefined;
}

export class DefaultWorkspaceService implements IDefaultWorkspace {
  declare readonly _serviceBrand: undefined;

  private systemRootPromise: Promise<string> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly processes: IHostProcessService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  async ensure(): Promise<string> {
    const root = await this.root();
    try {
      await this.fs.mkdir(root, { recursive: true });
    } catch (error) {
      throw unavailable(root, reasonOf(error), error);
    }
    const problem = await this.writeProblem(root);
    if (problem !== undefined) throw unavailable(root, problem);
    return root;
  }

  async path(): Promise<string | undefined> {
    return this.root().catch(() => undefined);
  }

  async isDefault(root: string): Promise<boolean> {
    const defaultRoot = await this.path();
    return defaultRoot !== undefined && workspaceRootKey(root) === workspaceRootKey(defaultRoot);
  }

  async status(): Promise<DefaultWorkspaceStatus> {
    await this.config.ready;
    const customPath = this.customPath();
    const systemPath = await this.systemRoot().catch(() => undefined);
    const path =
      customPath === undefined
        ? systemPath
        : resolveCustomRoot(customPath, this.bootstrap.osHomeDir, this.bootstrap.platform);
    if (path === undefined) {
      const problem = customPath === undefined ? 'documents_unavailable' : 'invalid_path';
      return { path, customPath, systemPath, exists: false, problem };
    }
    const { exists, problem } = await this.probe(path);
    return { path, customPath, systemPath, exists, problem };
  }

  async setCustomPath(path: string | undefined): Promise<DefaultWorkspaceStatus> {
    await this.config.ready;
    const trimmed = path?.trim() ?? '';
    if (trimmed.length === 0) {
      await this.assertUsable(await this.systemRoot());
      await this.config.replace(DEFAULT_WORKSPACE_SECTION, {});
      return this.status();
    }
    const root = resolveCustomRoot(trimmed, this.bootstrap.osHomeDir, this.bootstrap.platform);
    if (root === undefined) {
      throw unavailable(trimmed, 'invalid_path');
    }
    await this.assertUsable(root);
    await this.config.set(DEFAULT_WORKSPACE_SECTION, { path: trimmed });
    return this.status();
  }

  private async assertUsable(root: string): Promise<void> {
    const { problem } = await this.probe(root);
    if (problem !== undefined) throw unavailable(root, problem);
  }

  private customPath(): string | undefined {
    const config = this.config.get<DefaultWorkspaceConfig | undefined>(DEFAULT_WORKSPACE_SECTION);
    const path = config?.path?.trim();
    return path === undefined || path.length === 0 ? undefined : path;
  }

  private async root(): Promise<string> {
    await this.config.ready;
    const customPath = this.customPath();
    if (customPath === undefined) return this.systemRoot();
    const root = resolveCustomRoot(customPath, this.bootstrap.osHomeDir, this.bootstrap.platform);
    if (root === undefined) throw unavailable(customPath, 'invalid_path');
    return root;
  }

  private systemRoot(): Promise<string> {
    if (this.systemRootPromise === undefined) {
      const pending = this.documentsDir().then((dir) =>
        join(dir, ...DEFAULT_WORKSPACE_RELATIVE_ROOT),
      );
      this.systemRootPromise = pending;
      pending.catch(() => {
        if (this.systemRootPromise === pending) this.systemRootPromise = undefined;
      });
    }
    return this.systemRootPromise;
  }

  private async probe(root: string): Promise<PathProbe> {
    let existing = root;
    for (;;) {
      try {
        const stat = await this.fs.stat(existing);
        if (!stat.isDirectory) return { exists: false, problem: 'blocked_by_file' };
        break;
      } catch (error) {
        if (!isNotFound(error)) return { exists: false, problem: reasonOf(error) };
        if (await this.isDanglingLink(existing)) return { exists: false, problem: 'blocked_by_file' };
        const parent = dirname(existing);
        if (parent === existing) return { exists: false, problem: 'missing_parent' };
        existing = parent;
      }
    }
    const exists = existing === root;
    return { exists, problem: await this.writeProblem(existing, exists ? 'file' : 'folder') };
  }

  private async isDanglingLink(path: string): Promise<boolean> {
    try {
      await this.fs.lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async writeProblem(
    dir: string,
    entry: 'file' | 'folder' = 'file',
  ): Promise<DefaultWorkspaceUnavailableReason | undefined> {
    const probe = join(dir, `.kimi-code-write-test-${randomUUID()}`);
    let problem: DefaultWorkspaceUnavailableReason | undefined;
    try {
      if (!(await this.createProbe(probe, entry))) return 'unknown';
    } catch (error) {
      problem = reasonOf(error);
    }
    try {
      await this.fs.remove(probe);
    } catch (error) {
      if (!isNotFound(error)) problem ??= reasonOf(error);
    }
    return problem;
  }

  private async createProbe(probe: string, entry: 'file' | 'folder'): Promise<boolean> {
    if (entry === 'file') return this.fs.createExclusive(probe, new Uint8Array());
    try {
      await this.fs.mkdir(probe);
    } catch (error) {
      if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_ALREADY_EXISTS) {
        return false;
      }
      throw error;
    }
    await this.fs.createExclusive(join(probe, 'probe'), new Uint8Array());
    return true;
  }

  private async documentsDir(): Promise<string> {
    if (this.bootstrap.platform === 'win32') return this.windowsDocumentsDir();
    const fallback = defaultDocumentsDir(this.bootstrap.osHomeDir);
    if (this.bootstrap.platform === 'darwin') return fallback;
    return (await this.xdgDocumentsDir()) ?? fallback;
  }

  private async windowsDocumentsDir(): Promise<string> {
    let dir: string | undefined;
    let cause: unknown;
    try {
      dir = await this.queryWindowsDocumentsDir();
      if (dir !== undefined && !(await this.isDirectory(dir))) dir = undefined;
    } catch (error) {
      cause = error;
    }
    if (dir === undefined) {
      throw new DefaultWorkspaceUnavailableError(
        { path: undefined, reason: 'documents_unavailable' },
        'cannot locate the Windows Documents folder',
        cause,
      );
    }
    return dir;
  }

  private async queryWindowsDocumentsDir(): Promise<string | undefined> {
    const proc = await this.processes.spawn(
      windowsPowerShellPath(this.bootstrap.getEnv('SystemRoot') ?? this.bootstrap.getEnv('windir')),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DOCUMENTS_COMMAND],
      { windowsHide: true, timeout: WINDOWS_DOCUMENTS_TIMEOUT_MS },
    );
    try {
      const [stdout, exitCode] = await Promise.all([collect(proc.stdout), proc.wait()]);
      if (exitCode !== 0) return undefined;
      return parseWindowsDocumentsOutput(stdout);
    } finally {
      void proc.dispose();
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await this.fs.stat(path)).isDirectory;
    } catch {
      return false;
    }
  }

  private async xdgDocumentsDir(): Promise<string | undefined> {
    const configHome =
      this.bootstrap.getEnv('XDG_CONFIG_HOME') ?? join(this.bootstrap.osHomeDir, '.config');
    try {
      const content = await this.fs.readText(join(configHome, 'user-dirs.dirs'));
      return parseXdgDocumentsDir(content, this.bootstrap.osHomeDir);
    } catch {
      return undefined;
    }
  }
}

function unavailable(
  path: string | undefined,
  reason: DefaultWorkspaceUnavailableReason,
  cause?: unknown,
): DefaultWorkspaceUnavailableError {
  const where = path === undefined ? '' : ` ${path}`;
  return new DefaultWorkspaceUnavailableError(
    { path, reason },
    `default workspace${where} is unavailable: ${DEFAULT_WORKSPACE_PROBLEM_MESSAGES[reason]}`,
    cause,
  );
}

const REASON_BY_FS_CODE: ReadonlyMap<string, DefaultWorkspaceUnavailableReason> = new Map([
  [OsFsErrors.codes.OS_FS_ALREADY_EXISTS, 'blocked_by_file'],
  [OsFsErrors.codes.OS_FS_NOT_DIRECTORY, 'blocked_by_file'],
  [OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'permission_denied'],
  [OsFsErrors.codes.OS_FS_NOT_FOUND, 'missing_parent'],
]);

const REASON_BY_ERRNO: ReadonlyMap<unknown, DefaultWorkspaceUnavailableReason> = new Map([
  ['ENOSPC', 'no_space'],
  ['EDQUOT', 'no_space'],
  ['EROFS', 'read_only'],
  ['ENAMETOOLONG', 'invalid_path'],
]);

function reasonOf(error: unknown): DefaultWorkspaceUnavailableReason {
  if (error instanceof DefaultWorkspaceUnavailableError) return error.details.reason;
  if (!(error instanceof HostFsError)) return 'unknown';
  return (
    REASON_BY_FS_CODE.get(error.code) ??
    REASON_BY_ERRNO.get(error.details?.['errno']) ??
    'unknown'
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

registerScopedService(
  LifecycleScope.App,
  IDefaultWorkspace,
  DefaultWorkspaceService,
  ScopeActivation.OnDemand,
  'defaultWorkspace',
);
