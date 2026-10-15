import type { IConfigService } from '#/app/config/config';
import { join } from 'pathe';
import { parse } from 'smol-toml';
import { Error2, ErrorCodes } from '#/errors';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { DEFAULT_REMOTE_BIN, type LauncherSpec } from '#/remote/client/launchers';

import { ENVIRONMENTS_SECTION } from './configSection';
import {
  sectionEntries,
  EnvironmentsSectionSchema,
  type RemoteEnvironmentEntry,
  type EnvironmentsSection,
  type EnvironmentDeclarationSet,
} from './remoteEnvironmentDeclaration';

export const PROJECT_ENVIRONMENTS_FILE = '.kimi-code/environments.toml';

export async function loadProjectEnvironmentsSection(fs: IHostFileSystem, root: string): Promise<EnvironmentsSection | undefined> {
  const path = join(root, PROJECT_ENVIRONMENTS_FILE);
  let text: string;
  try {
    text = await fs.readText(path);
  } catch (error) {
    if ((error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) ||
      (error instanceof Error && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))) return undefined;
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Could not read ${path}`, { cause: error });
  }
  if (text.trim() === '') return undefined;
  try {
    return EnvironmentsSectionSchema.parse(parse(text));
  } catch (error) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Invalid environment declarations in ${path}`, { cause: error });
  }
}

export function toLauncherSpec(entry: RemoteEnvironmentEntry): LauncherSpec {
  if ('command' in entry) return { type: 'command', program: entry.command, args: entry.args, env: entry.env };
  return entry.type === 'ssh'
    ? { type: 'ssh', host: entry.host, remoteBin: entry.remoteBin }
    : { type: 'docker', container: entry.container, context: entry.context, remoteBin: entry.remoteBin };
}

export function declarationFingerprint(entry: RemoteEnvironmentEntry): string {
  const launcher = toLauncherSpec(entry);
  return JSON.stringify(launcher.type === 'command'
    ? { ...launcher, args: launcher.args ?? [], env: Object.fromEntries(Object.entries(launcher.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b))) }
    : { ...launcher, remoteBin: launcher.remoteBin ?? DEFAULT_REMOTE_BIN });
}

export async function resolveWorkspaceEnvironmentDeclarations(
  config: IConfigService,
): Promise<EnvironmentDeclarationSet> {
  await config.ready;
  const user = config.get<EnvironmentsSection | undefined>(ENVIRONMENTS_SECTION);
  const entries = sectionEntries(user);
  const defaultId = user?.default;
  const defaultEntry = defaultId === undefined ? undefined : entries.find((entry) => entry.id === defaultId);
  const defaultCwd = defaultEntry?.entry.defaultCwd;
  return {
    entries,
    default: defaultEntry === undefined || defaultCwd === undefined ? undefined : { environmentId: defaultEntry.id, cwd: defaultCwd },
  };
}
