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
import { isDirectoryPath, isFilePath } from './paths';
import type {
  AgentFileDefinition,
  AgentFileDiscoveryResult,
  AgentFileRoot,
  SkippedAgentFile,
} from './types';

const MAX_AGENT_SCAN_DEPTH = 8;
const MAX_SKIP_WARNINGS = 5;

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

  // Skip warnings are capped: a misconfigured root (e.g. an extra dir pointing
  // at a docs-heavy tree) must not spam one line per non-agent markdown file.
  // The returned `skipped` list keeps the parse-failure detail regardless;
  // the summary below names a few suppressed paths so the rest stay findable.
  let emittedWarnings = 0;
  let suppressedWarnings = 0;
  const suppressedSubjects: string[] = [];
  const warnCapped = (subject: string, message: string, error?: unknown): void => {
    if (emittedWarnings < MAX_SKIP_WARNINGS) {
      emittedWarnings += 1;
      warn?.(message, error);
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
      if (
        error instanceof HostFsError &&
        error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE
      ) {
        throw error;
      }
      if (error instanceof AgentFileParseError) {
        skipped.push({ path: filePath, reason: error.message });
        warnCapped(filePath, `Skipping invalid agent file at ${filePath}: ${error.message}`, error);
      } else {
        warnCapped(filePath, `Skipping agent file at ${filePath} due to unexpected error`, error);
      }
    }
  }

  async function walk(dirPath: string, root: AgentFileRoot, depth: number): Promise<void> {
    if (depth > MAX_AGENT_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = (await fs.readdir(dirPath)).map((entry) => entry.name).toSorted();
    } catch (error) {
      // Below the root, ANY readdir failure (notably EACCES) skips just this
      // directory — one unreadable subdirectory must not zero the whole
      // source, mirroring fileSkillDiscovery's per-directory tolerance.
      if (depth > 0) {
        warnCapped(dirPath, `Skipping unreadable directory ${dirPath}: ${errorMessage(error)}`, error);
        return;
      }
      // At the root, a missing directory is simply "no agents here"; other
      // failures propagate so the session catalog keeps its previous
      // contribution instead of wiping it over a transient fs error.
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
      try {
        if (await isDirectoryPath(fs, entryPath)) {
          await walk(entryPath, root, depth + 1);
          continue;
        }
        if (!entry.endsWith('.md') || !(await isFilePath(fs, entryPath))) continue;
        await parseAndRegister(entryPath, root);
      } catch (error) {
        if (
          error instanceof HostFsError &&
          error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE
        ) {
          throw error;
        }
        warnCapped(entryPath, `Skipping unreadable agent path ${entryPath}: ${errorMessage(error)}`, error);
      }
    }
  }

  for (const root of roots) {
    try {
      await walk(root.path, root, 0);
    } catch (error) {
      // A transient whole-fs outage (`os.fs.unavailable`) propagates so the
      // session catalog keeps its previous contribution instead of replacing
      // it with a partial scan. Any other root-level failure (notably EACCES)
      // skips just this root — one bad root must not take its siblings down.
      if (
        error instanceof HostFsError &&
        error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE
      ) {
        throw error;
      }
      warnCapped(root.path, `Skipping unreadable agent root ${root.path}: ${errorMessage(error)}`, error);
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
