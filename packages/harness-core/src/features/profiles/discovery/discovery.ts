import { join } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

import {
  AgentFileParseError,
  parseAgentFileText,
  type AgentFileDefinition,
  type AgentFileRoot,
} from '../definition/agent-file';
import type { SkippedAgentFile } from './finder';
import { isDirectoryPath, isFilePath } from './paths';

const MAX_AGENT_SCAN_DEPTH = 8;
const MAX_SKIP_WARNINGS = 5;

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
}

export async function discoverAgentFiles(
  fs: OsFsPort,
  roots: readonly AgentFileRoot[],
  warn?: (message: string) => void,
): Promise<AgentFileDiscoveryResult> {
  const byName = new Map<string, AgentFileDefinition>();
  const skipped: SkippedAgentFile[] = [];

  let emittedWarnings = 0;
  let suppressedWarnings = 0;
  const suppressedSubjects: string[] = [];
  const warnCapped = (subject: string, message: string): void => {
    if (emittedWarnings < MAX_SKIP_WARNINGS) {
      emittedWarnings += 1;
      warn?.(message);
    } else {
      suppressedWarnings += 1;
      if (suppressedSubjects.length < 3) suppressedSubjects.push(subject);
    }
  };

  async function parseAndRegister(filePath: string, root: AgentFileRoot): Promise<void> {
    try {
      const text = await fs.readText(filePath);
      const agent = parseAgentFileText({ path: filePath, source: root.source, text });
      if (!byName.has(agent.name)) {
        byName.set(agent.name, agent);
      }
    } catch (error) {
      if (error instanceof HostFsError && error.code === 'os.fs.unavailable') {
        throw error;
      }
      if (error instanceof AgentFileParseError) {
        skipped.push({ path: filePath, reason: error.message });
        warnCapped(filePath, `Skipping invalid agent file at ${filePath}: ${error.message}`);
      } else {
        warnCapped(filePath, `Skipping agent file at ${filePath} due to unexpected error`);
      }
    }
  }

  async function walk(dirPath: string, root: AgentFileRoot, depth: number): Promise<void> {
    if (depth > MAX_AGENT_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = (await fs.readdir(dirPath)).map((entry) => entry.name).toSorted();
    } catch (error) {
      if (depth > 0) {
        warnCapped(dirPath, `Skipping unreadable directory ${dirPath}: ${errorMessage(error)}`);
        return;
      }
      if (
        error instanceof HostFsError &&
        (error.code === 'os.fs.not_found' || error.code === 'os.fs.not_directory')
      ) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const entryPath = join(dirPath, entry);
      try {
        if (await isDirectoryPath(fs, entryPath)) {
          await walk(entryPath, root, depth + 1);
          continue;
        }
        if (!entry.endsWith('.md') || !(await isFilePath(fs, entryPath))) continue;
        await parseAndRegister(entryPath, root);
      } catch (error) {
        if (error instanceof HostFsError && error.code === 'os.fs.unavailable') {
          throw error;
        }
        warnCapped(entryPath, `Skipping unreadable agent path ${entryPath}: ${errorMessage(error)}`);
      }
    }
  }

  for (const root of roots) {
    try {
      await walk(root.path, root, 0);
    } catch (error) {
      if (error instanceof HostFsError && error.code === 'os.fs.unavailable') {
        throw error;
      }
      warnCapped(root.path, `Skipping unreadable agent root ${root.path}: ${errorMessage(error)}`);
    }
  }

  if (suppressedWarnings > 0) {
    const examples = suppressedSubjects.map((subject) => `"${subject}"`).join(', ');
    warn?.(
      `Suppressed ${suppressedWarnings} further agent-discovery skip warnings (e.g. ${examples}); fix or remove the offending files/directories to silence them`,
    );
  }

  return {
    agents: [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    skipped,
    scannedRoots: roots.map((root) => root.path),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
