import { join } from 'pathe';

import { findUpwardRoot } from '#/_base/utils/paths';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { isDirectoryPath, pathExists, resolveAgentPath } from './paths';
import type { AgentFileRoot, AgentFileSource } from './types';

export interface AgentRootWarn {
  (message: string, error?: unknown): void;
}

const USER_BRAND_DIRS = ['agents'] as const;
const USER_GENERIC_DIRS = ['.agents/agents'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/agents'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/agents'] as const;

export async function userAgentRoots(
  fs: IHostFileSystem,
  homeDir: string,
  osHomeDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, USER_BRAND_DIRS, homeDir, 'user', warn);
  await pushFirstExisting(fs, roots, USER_GENERIC_DIRS, osHomeDir, 'user', warn);
  return roots;
}

export async function projectAgentRoots(
  fs: IHostFileSystem,
  workDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, PROJECT_BRAND_DIRS, projectRoot, 'project', warn);
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project', warn);
  return roots;
}

export interface ProjectAgentRootCandidates {
  readonly projectRoot: string;
  readonly candidates: readonly string[];
}

export async function projectAgentRootCandidates(
  fs: IHostFileSystem,
  workDir: string,
  warn?: AgentRootWarn,
): Promise<ProjectAgentRootCandidates> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  return {
    projectRoot,
    candidates: [...PROJECT_BRAND_DIRS, ...PROJECT_GENERIC_DIRS].map((dir) =>
      join(projectRoot, dir),
    ),
  };
}

export async function configuredAgentRoots(
  fs: IHostFileSystem,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const roots: AgentFileRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(fs, roots, resolveAgentPath(dir, projectRoot, osHomeDir), source, warn);
  }
  return roots;
}

async function findProjectRoot(
  fs: IHostFileSystem,
  workDir: string,
  warn?: AgentRootWarn,
): Promise<string> {
  return findUpwardRoot(workDir, '.git', async (marker) => {
    try {
      return await pathExists(fs, marker);
    } catch (error) {
      if (isUnavailable(error)) throw error;
      warn?.(`Skipping unreadable project marker ${marker}: ${errorMessage(error)}`, error);
      return false;
    }
  });
}

async function pushFirstExisting(
  fs: IHostFileSystem,
  out: AgentFileRoot[],
  dirs: readonly string[],
  base: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(fs, out, join(base, dir), source, warn)) return;
  }
}

async function pushExistingRoot(
  fs: IHostFileSystem,
  out: AgentFileRoot[],
  dir: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<boolean> {
  try {
    if (!(await isDirectoryPath(fs, dir))) return false;
    const resolved = (await fs.realpath(dir)).replaceAll('\\', '/');
    if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
    return true;
  } catch (error) {
    if (isUnavailable(error)) throw error;
    warn?.(`Skipping unreadable agent root ${dir}: ${errorMessage(error)}`, error);
    return false;
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
