/**
 * `agentFileCatalog` domain (L3) — filesystem agent-file discovery.
 *
 * Walks caller-supplied roots recursively for `*.md` files and parses each
 * through `agentFile`. Invalid files are skipped with a warning and collected
 * into the result's `skipped` list, so one bad file never breaks the scan.
 * Name collisions resolve first-wins in root order; priority across sources is
 * the caller's (catalog's) concern. Dot-prefixed entries and `node_modules`
 * are never scanned. Mirrors `skillCatalog/fileSkillDiscovery`.
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

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
  roots: readonly AgentFileRoot[],
  warn?: DiscoverAgentFilesWarn,
): Promise<AgentFileDiscoveryResult> {
  const byName = new Map<string, AgentFileDefinition>();
  const skipped: SkippedAgentFile[] = [];

  async function parseAndRegister(filePath: string, root: AgentFileRoot): Promise<void> {
    try {
      const text = await fs.readFile(filePath, 'utf8');
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
      entries = [...(await fs.readdir(dirPath))].toSorted();
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const entryPath = path.join(dirPath, entry);
      if (await isDir(entryPath)) {
        await walk(entryPath, root, depth + 1);
        continue;
      }
      if (!entry.endsWith('.md') || !(await isFile(entryPath))) continue;
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

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
