import type { IConfigService } from '#/app/config/config';
import { DEFAULT_REMOTE_BIN, type LauncherSpec } from '#/remote/client/launchers';

import { ENVIRONMENTS_SECTION } from './configSection';
import {
  sectionEntries,
  type RemoteEnvironmentEntry,
  type EnvironmentsSection,
  type EnvironmentDeclarationSet,
} from './remoteEnvironmentDeclaration';

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
  config.assertValid(ENVIRONMENTS_SECTION);
  const user = config.get<EnvironmentsSection | undefined>(ENVIRONMENTS_SECTION);
  const entries = sectionEntries(user);
  return { entries, defaultId: user?.default };
}
