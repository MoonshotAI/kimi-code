import { join } from 'pathe';
import { parse as parseToml } from 'smol-toml';

import type { IConfigService } from '#/app/config/config';
import { ErrorCodes, Error2 } from '#/errors';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { readWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';

import { ENVIRONMENTS_SECTION } from './configSection';
import {
  describeEnvironmentEntry,
  mergeEnvironmentDeclarations,
  EnvironmentsSectionSchema,
  sectionEntries,
  type RemoteEnvironmentEntry,
  type EnvironmentDeclarationSet,
  type EnvironmentsSection,
} from './remoteEnvironmentDeclaration';

export const PROJECT_ENVIRONMENTS_FILE = '.kimi-code/environments.toml';

export async function loadProjectEnvironmentsSection(
  fs: IHostFileSystem,
  root: string,
): Promise<EnvironmentsSection | undefined> {
  const filePath = join(root, PROJECT_ENVIRONMENTS_FILE);
  let text: string;
  try {
    text = await fs.readText(filePath);
  } catch (error: unknown) {
    if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) return undefined;
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (text.trim().length === 0) return undefined;
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error: unknown) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = EnvironmentsSectionSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid environments in ${filePath}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface ResolveEnvironmentDeclarationsInput {
  readonly config: IConfigService;
  readonly fs: IHostFileSystem;
  readonly docs: IAtomicDocumentStore;
  readonly root: string;
}

export type { EnvironmentDeclarationSet } from './remoteEnvironmentDeclaration';

export async function resolveWorkspaceEnvironmentDeclarations(
  input: ResolveEnvironmentDeclarationsInput,
): Promise<EnvironmentDeclarationSet> {
  await input.config.ready;
  const user = input.config.get<EnvironmentsSection | undefined>(ENVIRONMENTS_SECTION);
  const trusted = await readWorkspaceTrust(input.docs, input.root);
  let project: EnvironmentsSection | undefined;
  let projectError: unknown;
  if (trusted) {
    try {
      project = await loadProjectEnvironmentsSection(input.fs, input.root);
    } catch (error: unknown) {
      projectError = error;
    }
  }
  const entries = mergeEnvironmentDeclarations(sectionEntries(user, 'user'), sectionEntries(project, 'project'));
  const defaultId = project?.default ?? user?.default;
  const defaultEntry = defaultId === undefined ? undefined : entries.find((entry) => entry.id === defaultId);
  const defaultCwd = defaultEntry?.entry.defaultCwd;
  return {
    entries,
    default: defaultEntry === undefined || defaultCwd === undefined ? undefined : { environmentId: defaultEntry.id, cwd: defaultCwd },
    projectError,
  };
}

export interface ProjectEnvironmentTrustEntry {
  readonly id: string;
  readonly commandLine: string;
}

export async function previewProjectEnvironmentDeclarations(
  fs: IHostFileSystem,
  root: string,
): Promise<readonly ProjectEnvironmentTrustEntry[]> {
  const section = await loadProjectEnvironmentsSection(fs, root);
  if (section === undefined) return [];
  return sectionEntries(section, 'project').map((declaration) => ({
    id: declaration.id,
    commandLine: previewCommandLine(declaration.entry, root),
  }));
}

function previewCommandLine(entry: RemoteEnvironmentEntry, root: string): string {
  try {
    return describeEnvironmentEntry(entry, { cwd: root });
  } catch (error: unknown) {
    const raw = 'command' in entry ? [entry.command, ...(entry.args ?? [])].join(' ') : entry.type;
    return `${raw} (invalid: ${error instanceof Error ? error.message : String(error)})`;
  }
}
