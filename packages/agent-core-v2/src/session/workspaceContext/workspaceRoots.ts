import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding } from '#/environment/environment';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

export interface EffectiveWorkspaceRoots {
  readonly workDir: string;
  readonly primaryDir?: string;
  readonly additionalDirs: readonly string[];
  readonly followsPrimary: boolean;
}

declare const sessionWorkdirBrand: unique symbol;

export type SessionWorkdir = string & { readonly [sessionWorkdirBrand]: true };

export interface SessionPlacementFacts {
  readonly cwd?: string;
  readonly environmentId?: string;
  readonly environmentCwd?: string;
}

export type SessionPlacement =
  | { readonly kind: 'pinned'; readonly workDir: string }
  | { readonly kind: 'follows-project-root'; readonly createdIn?: string }
  | { readonly kind: 'remote'; readonly hostCwd?: string };

export function sessionPlacementOf(facts: SessionPlacementFacts): SessionPlacement {
  if ((facts.environmentId ?? LOCAL_ENVIRONMENT_ID) !== LOCAL_ENVIRONMENT_ID) {
    return { kind: 'remote', hostCwd: facts.cwd };
  }
  return facts.environmentCwd === undefined
    ? { kind: 'follows-project-root', createdIn: facts.cwd }
    : { kind: 'pinned', workDir: facts.environmentCwd };
}

export function sessionWorkDir(
  placement: SessionPlacement,
  projectRoot: string | undefined,
): SessionWorkdir | undefined {
  switch (placement.kind) {
    case 'pinned':
      return placement.workDir as SessionWorkdir;
    case 'follows-project-root':
      return (projectRoot ?? placement.createdIn) as SessionWorkdir | undefined;
    case 'remote':
      return (placement.hostCwd ?? projectRoot) as SessionWorkdir | undefined;
  }
}

export function resolveEffectiveWorkspaceRoots(
  session: Pick<ISessionContext, 'workspaceId' | 'cwd'>,
  binding: EnvironmentBinding | undefined,
  workspace: Pick<ISessionWorkspaceInfo, 'primaryByWorkspace' | 'additionalDirs'>,
  host?: Pick<HostEnvironmentInfo, 'cwd' | 'homeDir'>,
): EffectiveWorkspaceRoots {
  const environmentId = binding?.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const local = environmentId === LOCAL_ENVIRONMENT_ID;
  const primaryDir = local ? workspace.primaryByWorkspace[session.workspaceId] : undefined;
  const followsPrimary = local && binding?.cwd === undefined && primaryDir !== undefined;
  const workDir = local
    ? sessionWorkDir(sessionPlacementOf({ cwd: session.cwd, environmentCwd: binding?.cwd }), primaryDir) ?? session.cwd
    : binding?.cwd ?? host?.cwd ?? host?.homeDir ?? session.cwd;
  const workDirKey = workspaceRootKey(workDir);
  const seen = new Set([workDirKey]);
  const additionalDirs: string[] = [];
  for (const dir of [primaryDir, ...workspace.additionalDirs]) {
    if (dir === undefined) continue;
    const key = workspaceRootKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    additionalDirs.push(dir);
  }
  return { workDir, primaryDir, additionalDirs, followsPrimary };
}
