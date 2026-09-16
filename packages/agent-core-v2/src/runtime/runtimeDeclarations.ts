import { join } from 'pathe';
import { parse as parseToml } from 'smol-toml';

import type { IConfigService } from '#/app/config/config';
import { ErrorCodes, Error2 } from '#/errors';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { readWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';

import { RUNTIMES_SECTION } from './configSection';
import {
  describeRuntimeEntry,
  mergeRuntimeDeclarations,
  RuntimesSectionSchema,
  sectionDefault,
  sectionEntries,
  type RemoteRuntimeEntry,
  type RuntimeDeclarationSet,
  type RuntimesSection,
} from './remoteRuntimeDeclaration';

export const PROJECT_RUNTIMES_FILE = '.kimi-code/runtimes.toml';

export async function loadProjectRuntimesSection(
  fs: IHostFileSystem,
  root: string,
): Promise<RuntimesSection | undefined> {
  const filePath = join(root, PROJECT_RUNTIMES_FILE);
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
  const parsed = RuntimesSectionSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid runtimes in ${filePath}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface ResolveRuntimeDeclarationsInput {
  readonly config: IConfigService;
  readonly fs: IHostFileSystem;
  readonly docs: IAtomicDocumentStore;
  readonly root: string;
}

export type { RuntimeDeclarationSet } from './remoteRuntimeDeclaration';

export async function resolveWorkspaceRuntimeDeclarations(
  input: ResolveRuntimeDeclarationsInput,
): Promise<RuntimeDeclarationSet> {
  await input.config.ready;
  const user = input.config.get<RuntimesSection | undefined>(RUNTIMES_SECTION);
  const trusted = await readWorkspaceTrust(input.docs, input.root);
  let project: RuntimesSection | undefined;
  let projectError: unknown;
  if (trusted) {
    try {
      project = await loadProjectRuntimesSection(input.fs, input.root);
    } catch (error: unknown) {
      projectError = error;
    }
  }
  return {
    entries: mergeRuntimeDeclarations(sectionEntries(user, 'user'), sectionEntries(project, 'project')),
    default: sectionDefault(project) ?? sectionDefault(user),
    projectError,
  };
}

export interface ProjectRuntimeTrustEntry {
  readonly id: string;
  readonly commandLine: string;
}

export async function previewProjectRuntimeDeclarations(
  fs: IHostFileSystem,
  root: string,
): Promise<readonly ProjectRuntimeTrustEntry[]> {
  const section = await loadProjectRuntimesSection(fs, root);
  if (section === undefined) return [];
  return sectionEntries(section, 'project').map((declaration) => ({
    id: declaration.id,
    commandLine: previewCommandLine(declaration.entry, root),
  }));
}

function previewCommandLine(entry: RemoteRuntimeEntry, root: string): string {
  try {
    return describeRuntimeEntry(entry, { cwd: root });
  } catch (error: unknown) {
    const raw = 'command' in entry ? [entry.command, ...(entry.args ?? [])].join(' ') : entry.type;
    return `${raw} (invalid: ${error instanceof Error ? error.message : String(error)})`;
  }
}
