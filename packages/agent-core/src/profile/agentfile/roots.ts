/**
 * Agent-root resolution primitives: user, project, and configured discovery
 * roots, mirroring the skill scanner's directory conventions
 * (`skills` ↔ `agents`, `.kimi-code` ↔ `.agents`).
 *
 * Ported from the v2 engine (`packages/agent-core-v2/src/app/agentFileCatalog/agentRoots.ts`)
 * — keep the two in sync: discovery-root conventions must land in both engines.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'pathe';

import { isDirectoryPath, pathExists, resolveAgentPath } from './paths';
import type { AgentFileRoot, AgentFileSource } from './types';

export interface AgentRootWarn {
  (message: string, error?: unknown): void;
}

// Relative to brandHomeDir, which already IS the brand data dir (~/.kimi-code
// or $KIMI_CODE_HOME) — no '.kimi-code' segment here, or it would nest twice.
const USER_BRAND_DIRS = ['agents'] as const;
const USER_GENERIC_DIRS = ['.agents/agents'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/agents'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/agents'] as const;

export async function userAgentRoots(
  brandHomeDir: string,
  osHomeDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(roots, USER_BRAND_DIRS, brandHomeDir, 'user', warn);
  await pushFirstExisting(roots, USER_GENERIC_DIRS, osHomeDir, 'user', warn);
  return roots;
}

export async function projectAgentRoots(
  workDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(workDir, warn);
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(roots, PROJECT_BRAND_DIRS, projectRoot, 'project', warn);
  await pushFirstExisting(roots, PROJECT_GENERIC_DIRS, projectRoot, 'project', warn);
  return roots;
}

export async function configuredAgentRoots(
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(workDir, warn);
  const roots: AgentFileRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(roots, resolveAgentPath(dir, projectRoot, osHomeDir), source, warn);
  }
  return roots;
}

async function findProjectRoot(workDir: string, warn?: AgentRootWarn): Promise<string> {
  const start = resolve(workDir);
  let current = start;
  while (true) {
    const marker = join(current, '.git');
    try {
      if (await pathExists(marker)) return current;
    } catch (error) {
      warn?.(`Skipping unreadable project marker ${marker}: ${errorMessage(error)}`, error);
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function pushFirstExisting(
  out: AgentFileRoot[],
  dirs: readonly string[],
  base: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(out, join(base, dir), source, warn)) return;
  }
}

async function pushExistingRoot(
  out: AgentFileRoot[],
  dir: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<boolean> {
  try {
    if (!(await isDirectoryPath(dir))) return false;
    const resolved = (await fs.realpath(dir)).replaceAll('\\', '/');
    if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
    return true;
  } catch (error) {
    warn?.(`Skipping unreadable agent root ${dir}: ${errorMessage(error)}`, error);
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
