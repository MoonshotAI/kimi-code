import { createHash } from 'node:crypto';

import { isAbsolute, join, normalize, relative } from 'pathe';

import { sameDir } from '#/_base/utils/workdir-slug';
import type {
  ProjectAgentsMdBelief,
  WorkdirMoveBaseline,
} from '#/agent/environmentBinding/environmentBindingOps';
import { AGENTS_MD_PLAIN_NAMES } from '#/agent/profile/context';

import type { WorkdirMovedDisclosure } from './workdirMove';
import type { WorkdirMoveState } from './workdirMoveOps';

export interface LoadedProjectAgentsMdFile extends ProjectAgentsMdBelief {
  readonly content: string;
}

const WINDOWS_DRIVE_PREFIX = /^[A-Z]:(?=\/|$)/;

function canonicalPathKey(rawPath: string): string {
  const normalized = normalize(rawPath.replaceAll('\\', '/'));
  return normalized.replace(WINDOWS_DRIVE_PREFIX, (drive) => drive.toLowerCase());
}

function resolveProjectAgentsMdPath(
  rawPath: string,
  checkoutRootKey: string,
  globalPaths: ReadonlySet<string>,
): { readonly path: string; readonly relativePath: string } | undefined {
  const normalizedPath = normalize(rawPath);
  const pathKey = canonicalPathKey(rawPath);
  if (globalPaths.has(pathKey)) return undefined;
  const rel = relative(checkoutRootKey, pathKey);
  const relativePath =
    rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)
      ? normalizedPath
      : rel;
  return { path: normalizedPath, relativePath };
}

export function globalAgentsMdPaths(homeDir: string, brandHome?: string): Set<string> {
  const realHome = normalize(homeDir);
  const brandDir = normalize(brandHome ?? join(realHome, '.kimi-code'));
  return new Set<string>([
    canonicalPathKey(join(brandDir, 'AGENTS.md')),
    ...AGENTS_MD_PLAIN_NAMES.map((name) => canonicalPathKey(join(realHome, '.agents', name))),
  ]);
}

export function extractProjectAgentsMdFiles(
  files: ReadonlyMap<string, string>,
  checkoutRoot: string,
  globalPaths: ReadonlySet<string>,
): LoadedProjectAgentsMdFile[] {
  const checkoutRootKey = canonicalPathKey(checkoutRoot);
  const entries: LoadedProjectAgentsMdFile[] = [];
  for (const [rawPath, content] of files) {
    const resolved = resolveProjectAgentsMdPath(rawPath, checkoutRootKey, globalPaths);
    if (resolved === undefined) continue;
    entries.push({
      relativePath: resolved.relativePath,
      path: resolved.path,
      hash: sha256Hex(content),
      content,
    });
  }
  return entries;
}

export function overlaySnapshotHashes(
  entries: readonly ProjectAgentsMdBelief[],
  snapshotFiles: Readonly<Record<string, string>> | undefined,
  checkoutRoot: string,
  globalPaths: ReadonlySet<string>,
): ProjectAgentsMdBelief[] {
  if (snapshotFiles === undefined) return [...entries];
  const checkoutRootKey = canonicalPathKey(checkoutRoot);
  const byRel = new Map<string, ProjectAgentsMdBelief>();
  for (const [rawPath, hash] of Object.entries(snapshotFiles)) {
    const resolved = resolveProjectAgentsMdPath(rawPath, checkoutRootKey, globalPaths);
    if (resolved === undefined) continue;
    byRel.set(resolved.relativePath, {
      relativePath: resolved.relativePath,
      path: resolved.path,
      hash,
    });
  }
  return [...byRel.values()];
}

export function selectWorkdirMoveBaseline(input: {
  readonly state: WorkdirMoveState;
  readonly lastDisclosure?: WorkdirMovedDisclosure;
  readonly hasCompactionSummary: boolean;
  readonly promptBaseline: WorkdirMoveBaseline;
}): WorkdirMoveBaseline | undefined {
  if (input.state.originCwd === undefined && input.state.pendingBaseline === undefined) {
    return undefined;
  }
  if (input.lastDisclosure !== undefined) {
    if (
      input.state.pendingBaseline !== undefined &&
      sameDir(input.state.pendingBaseline.cwd, input.lastDisclosure.cwd)
    ) {
      return input.state.pendingBaseline;
    }
    return {
      cwd: input.lastDisclosure.cwd,
      checkoutRoot: input.lastDisclosure.checkoutRoot,
      projectAgentsMd: input.lastDisclosure.projectAgentsMd,
    };
  }
  if (input.hasCompactionSummary) {
    return input.promptBaseline;
  }
  return input.state.pendingBaseline ?? input.promptBaseline;
}

export function buildWorkdirMovedReminder(input: {
  readonly baseline: WorkdirMoveBaseline;
  readonly currentCwd: string;
  readonly currentCheckoutRoot: string;
  readonly currentProjectFiles: readonly LoadedProjectAgentsMdFile[];
}): { readonly content: string; readonly disclosure: WorkdirMovedDisclosure } | undefined {
  if (sameDir(input.baseline.cwd, input.currentCwd)) {
    return undefined;
  }

  const oldByRel = new Map(input.baseline.projectAgentsMd.map((file) => [file.relativePath, file]));
  const newByRel = new Map(input.currentProjectFiles.map((file) => [file.relativePath, file]));

  const staleOldPaths: string[] = [];
  const freshNewFiles: LoadedProjectAgentsMdFile[] = [];

  for (const [rel, oldFile] of oldByRel) {
    const nextFile = newByRel.get(rel);
    if (nextFile === undefined || nextFile.hash !== oldFile.hash) {
      staleOldPaths.push(oldFile.path);
    }
  }
  for (const [rel, nextFile] of newByRel) {
    const oldFile = oldByRel.get(rel);
    if (oldFile === undefined || oldFile.hash !== nextFile.hash) {
      freshNewFiles.push(nextFile);
    }
  }

  const moveLine = `The current working directory has moved from \`${input.baseline.cwd}\` to \`${input.currentCwd}\`.`;
  const agentsMdSection = formatMovedAgentsMdSection(staleOldPaths, freshNewFiles);
  const content = agentsMdSection === undefined ? moveLine : `${moveLine}\n\n${agentsMdSection}`;

  return {
    content,
    disclosure: {
      kind: 'workdir_moved',
      cwd: input.currentCwd,
      checkoutRoot: input.currentCheckoutRoot,
      projectAgentsMd: input.currentProjectFiles.map(({ relativePath, path, hash }) => ({
        relativePath,
        path,
        hash,
      })),
    },
  };
}

export function formatMovedAgentsMdSection(
  staleOldPaths: readonly string[],
  freshNewFiles: readonly LoadedProjectAgentsMdFile[],
): string | undefined {
  if (staleOldPaths.length === 0 && freshNewFiles.length === 0) {
    return undefined;
  }
  const staleSentence =
    staleOldPaths.length > 0
      ? `The instructions from ${staleOldPaths.map((path) => `\`${path}\``).join(', ')} no longer apply.`
      : undefined;

  if (freshNewFiles.length === 0) {
    return staleSentence;
  }

  const applyIntro = 'The following `AGENTS.md` instructions now apply:';
  const header = staleSentence === undefined ? applyIntro : `${staleSentence} ${applyIntro}`;
  const blocks = freshNewFiles
    .map((file) => `<!-- From: ${file.path} -->\n${file.content}`)
    .join('\n\n');
  return `${header}\n\n${blocks}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
