import { dirname, join, resolve } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

import type { AgentFileRoot, AgentFileSource } from '../definition/agent-file';
import { isDirectoryPath, pathExists, resolveAgentPath } from './paths';

const USER_BRAND_DIRS = ['agents'] as const;
const USER_GENERIC_DIRS = ['.agents/agents'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/agents'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/agents'] as const;

export async function userAgentRoots(
  fs: OsFsPort,
  homeDir: string,
  osHomeDir: string,
  warn?: (message: string) => void,
): Promise<readonly AgentFileRoot[]> {
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, USER_BRAND_DIRS, homeDir, 'user', warn);
  await pushFirstExisting(fs, roots, USER_GENERIC_DIRS, osHomeDir, 'user', warn);
  return roots;
}

export async function projectAgentRoots(
  fs: OsFsPort,
  workDir: string,
  warn?: (message: string) => void,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, PROJECT_BRAND_DIRS, projectRoot, 'project', warn);
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project', warn);
  return roots;
}

export async function configuredAgentRoots(
  fs: OsFsPort,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: AgentFileSource,
  warn?: (message: string) => void,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const roots: AgentFileRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(fs, roots, resolveAgentPath(dir, projectRoot, osHomeDir), source, warn);
  }
  return roots;
}

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

async function findUpwardRoot(
  workDir: string,
  markerName: string,
  hasMarker: (markerPath: string) => Promise<boolean>,
): Promise<string> {
  const start = resolve(workDir);
  let current = start;
  while (true) {
    if (await hasMarker(join(current, markerName))) return normalizeSlashes(current);
    const parent = dirname(current);
    if (parent === current) return normalizeSlashes(start);
    current = parent;
  }
}

async function findProjectRoot(
  fs: OsFsPort,
  workDir: string,
  warn?: (message: string) => void,
): Promise<string> {
  return findUpwardRoot(workDir, '.git', async (marker) => {
    try {
      return await pathExists(fs, marker);
    } catch (error) {
      if (isUnavailable(error)) throw error;
      warn?.(`Skipping unreadable project marker ${marker}: ${errorMessage(error)}`);
      return false;
    }
  });
}

async function pushFirstExisting(
  fs: OsFsPort,
  out: AgentFileRoot[],
  dirs: readonly string[],
  base: string,
  source: AgentFileSource,
  warn?: (message: string) => void,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(fs, out, join(base, dir), source, warn)) return;
  }
}

async function pushExistingRoot(
  fs: OsFsPort,
  out: AgentFileRoot[],
  dir: string,
  source: AgentFileSource,
  warn?: (message: string) => void,
): Promise<boolean> {
  try {
    if (!(await isDirectoryPath(fs, dir))) return false;
    const resolved = (await fs.realpath(dir)).replaceAll('\\', '/');
    if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
    return true;
  } catch (error) {
    if (isUnavailable(error)) throw error;
    warn?.(`Skipping unreadable agent root ${dir}: ${errorMessage(error)}`);
    return false;
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof HostFsError && error.code === 'os.fs.unavailable';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
