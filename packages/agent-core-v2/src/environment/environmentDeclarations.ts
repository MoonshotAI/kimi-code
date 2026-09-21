import type { IConfigService } from '#/app/config/config';

import { ENVIRONMENTS_SECTION } from './configSection';
import {
  sectionEntries,
  type EnvironmentsSection,
  type EnvironmentDeclarationSet,
} from './remoteEnvironmentDeclaration';

export type { EnvironmentDeclarationSet } from './remoteEnvironmentDeclaration';

export interface ResolveEnvironmentDeclarationsInput {
  readonly config: IConfigService;
}

export async function resolveWorkspaceEnvironmentDeclarations(
  input: ResolveEnvironmentDeclarationsInput,
): Promise<EnvironmentDeclarationSet> {
  await input.config.ready;
  const user = input.config.get<EnvironmentsSection | undefined>(ENVIRONMENTS_SECTION);
  const entries = sectionEntries(user);
  const defaultId = user?.default;
  const defaultEntry = defaultId === undefined ? undefined : entries.find((entry) => entry.id === defaultId);
  const defaultCwd = defaultEntry?.entry.defaultCwd;
  return {
    entries,
    default: defaultEntry === undefined || defaultCwd === undefined ? undefined : { environmentId: defaultEntry.id, cwd: defaultCwd },
  };
}
