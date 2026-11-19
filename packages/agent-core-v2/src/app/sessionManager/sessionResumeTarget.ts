import type { ServicesAccessor } from '#/_base/di/instantiation';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceAliases } from '#/app/workspaceAliases/workspaceAliases';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { Error2, ErrorCodes } from '#/errors';

export type SessionResumeSelection =
  | { readonly sessionId: string }
  | { readonly workDir: string; readonly environmentId?: string; readonly environmentCwd?: string };

export interface SessionResumeTarget {
  readonly id: string;
  readonly projectId: string;
  readonly workDir: string;
  readonly environmentId: string;
  readonly environmentCwd: string;
}

export async function resolveSessionResumeTarget(
  services: ServicesAccessor,
  selection: SessionResumeSelection,
): Promise<SessionResumeTarget | undefined> {
  const index = services.get(ISessionIndex);
  let summary;
  if ('sessionId' in selection) {
    summary = await index.get(selection.sessionId);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `Session "${selection.sessionId}" not found.`);
    }
  } else {
    const project = await services.get(ISessionManager).resolveCreationEnvironment(selection);
    const page = await index.listRecent({
      workspaceIds: await services.get(IWorkspaceAliases).resolveAliasIds(project.workspaceId),
      workdir: {
        environmentId: project.environmentId ?? LOCAL_ENVIRONMENT_ID,
        cwd: project.environmentCwd ?? selection.workDir,
      },
      limit: 1,
    });
    summary = page.items[0];
    if (summary === undefined) return undefined;
  }
  const environmentId = summary.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const environmentCwd = summary.environmentCwd ?? (environmentId === LOCAL_ENVIRONMENT_ID ? summary.cwd : undefined);
  const workDir = environmentId === LOCAL_ENVIRONMENT_ID ? environmentCwd : summary.cwd;
  if (workDir === undefined || environmentCwd === undefined) {
    throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `Session "${summary.id}" has no recorded working directory.`);
  }
  return { id: summary.id, projectId: summary.workspaceId, workDir, environmentId, environmentCwd };
}
