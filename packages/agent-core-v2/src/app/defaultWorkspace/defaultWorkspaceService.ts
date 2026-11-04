import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { DEFAULT_WORKSPACE_SECTION, type DefaultWorkspaceConfig } from './configSection';
import { IDefaultWorkspace } from './defaultWorkspace';
import { DEFAULT_WORKSPACE_RELATIVE_ROOT, resolveCustomRoot } from './defaultWorkspacePaths';
import {
  DEFAULT_WORKSPACE_PROBLEM_MESSAGES,
  DefaultWorkspaceUnavailableError,
  type DefaultWorkspaceUnavailableReason,
} from './errors';

export class DefaultWorkspaceService implements IDefaultWorkspace {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IConfigService private readonly config: IConfigService,
  ) {}

  async ensure(): Promise<string> {
    const baseRoot = await this.root();
    const root = join(baseRoot, sessionFolderName(new Date()));
    try {
      await this.fs.mkdir(baseRoot, { recursive: true });
      await this.fs.mkdir(root, { recursive: false });
    } catch (error) {
      throw unavailable(root, reasonOf(error), error);
    }
    return root;
  }

  async isDefault(root: string): Promise<boolean> {
    const defaultRoot = await this.root().catch(() => undefined);
    if (defaultRoot === undefined) return false;
    const candidateKey = workspaceRootKey(root);
    const defaultKey = workspaceRootKey(defaultRoot);
    return candidateKey === defaultKey || workspaceRootKey(dirname(root)) === defaultKey;
  }

  private customPath(): string | undefined {
    const config = this.config.get<DefaultWorkspaceConfig | undefined>(DEFAULT_WORKSPACE_SECTION);
    const path = config?.path?.trim();
    return path === undefined || path.length === 0 ? undefined : path;
  }

  private async root(): Promise<string> {
    await this.config.ready;
    const customPath = this.customPath();
    if (customPath === undefined) {
      return join(this.bootstrap.osHomeDir, ...DEFAULT_WORKSPACE_RELATIVE_ROOT);
    }
    const root = resolveCustomRoot(customPath, this.bootstrap.osHomeDir, this.bootstrap.platform);
    if (root === undefined) throw unavailable(customPath, 'invalid_path');
    return root;
  }
}

function sessionFolderName(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}-${randomBytes(4).toString('hex')}`;
}

function unavailable(
  path: string,
  reason: DefaultWorkspaceUnavailableReason,
  cause?: unknown,
): DefaultWorkspaceUnavailableError {
  return new DefaultWorkspaceUnavailableError(
    { path, reason },
    `default workspace ${path} is unavailable: ${DEFAULT_WORKSPACE_PROBLEM_MESSAGES[reason]}`,
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
  if (!(error instanceof HostFsError)) return 'unknown';
  return (
    REASON_BY_FS_CODE.get(error.code) ??
    REASON_BY_ERRNO.get(error.details?.['errno']) ??
    'unknown'
  );
}

registerScopedService(
  LifecycleScope.App,
  IDefaultWorkspace,
  DefaultWorkspaceService,
  ScopeActivation.OnDemand,
  'defaultWorkspace',
);
