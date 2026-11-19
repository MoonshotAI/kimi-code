import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding } from '#/environment/environment';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

export interface EffectiveWorkspaceRoots {
  readonly workDir: string;
  readonly primaryDir?: string;
  readonly additionalDirs: readonly string[];
}

export function resolveEffectiveWorkspaceRoots(
  session: Pick<ISessionContext, 'workspaceId' | 'cwd'>,
  binding: EnvironmentBinding | undefined,
  workspace: Pick<ISessionWorkspaceInfo, 'primaryByWorkspace' | 'additionalDirs' | 'environmentId'>,
  host?: Pick<HostEnvironmentInfo, 'cwd' | 'homeDir'>,
): EffectiveWorkspaceRoots {
  const environmentId = binding?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const local = environmentId === LOCAL_ENVIRONMENT_ID;
  const primaryDir = local ? workspace.primaryByWorkspace[session.workspaceId] : undefined;
  const workDir = binding?.cwd ??
    (local
      ? session.cwd
      : host?.cwd ?? host?.homeDir ?? session.cwd);
  const workDirKey = workspaceRootKey(workDir);
  const seen = new Set([workDirKey]);
  const additionalDirs: string[] = [];
  const dirs = environmentId === (workspace.environmentId ?? LOCAL_ENVIRONMENT_ID) ? workspace.additionalDirs : [];
  for (const dir of dirs) {
    const key = workspaceRootKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    additionalDirs.push(dir);
  }
  return { workDir, primaryDir, additionalDirs };
}
