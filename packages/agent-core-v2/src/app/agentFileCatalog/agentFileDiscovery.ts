/**
 * `agentFileCatalog` domain (L3) — filesystem agent-file discovery.
 *
 * Discovers and parses agent files through the `hostFs` filesystem boundary.
 * Invalid files are isolated from the rest of the discovery pass. No scoped
 * state.
 */

import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { AgentFileParseError, parseAgentFileText } from './agentFile';
import type {
  AgentFileDefinition,
  AgentFileDiscoveryResult,
  AgentFileRoot,
  SkippedAgentFile,
} from './types';

const MAX_AGENT_SCAN_DEPTH = 8;

export interface DiscoverAgentFilesWarn {
  (message: string, error?: unknown): void;
}

export async function discoverAgentFiles(
  fs: IHostFileSystem,
  roots: readonly AgentFileRoot[],
  warn?: DiscoverAgentFilesWarn,
): Promise<AgentFileDiscoveryResult> {
  const byName = new Map<string, AgentFileDefinition>();
  const skipped: SkippedAgentFile[] = [];

  async function parseAndRegister(filePath: string, root: AgentFileRoot): Promise<void> {
    try {
      const text = await fs.readText(filePath);
      const agent = parseAgentFileText({ path: filePath, source: root.source, text });
      if (!byName.has(agent.name)) {
        byName.set(agent.name, agent);
      }
    } catch (error) {
      if (error instanceof AgentFileParseError) {
        skipped.push({ path: filePath, reason: error.message });
        warn?.(`Skipping invalid agent file at ${filePath}: ${error.message}`, error);
      } else {
        warn?.(`Skipping agent file at ${filePath} due to unexpected error`, error);
      }
    }
  }

  async function walk(dirPath: string, root: AgentFileRoot, depth: number): Promise<void> {
    if (depth > MAX_AGENT_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = (await fs.readdir(dirPath)).map((entry) => entry.name).toSorted();
    } catch (error) {
      if (
        error instanceof HostFsError &&
        (error.code === OsFsErrors.codes.OS_FS_NOT_FOUND ||
          error.code === OsFsErrors.codes.OS_FS_NOT_DIRECTORY)
      ) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const entryPath = join(dirPath, entry);
      if (await isDir(fs, entryPath)) {
        await walk(entryPath, root, depth + 1);
        continue;
      }
      if (!entry.endsWith('.md') || !(await isFile(fs, entryPath))) continue;
      await parseAndRegister(entryPath, root);
    }
  }

  for (const root of roots) {
    await walk(root.path, root, 0);
  }

  return {
    agents: [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    skipped,
    scannedRoots: roots.map((root) => root.path),
  };
}

async function isDir(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isFile;
  } catch {
    return false;
  }
}
