import { basename, dirname, isAbsolute, join, normalize } from 'pathe';

import {
  createHistoryMessageBuilder,
  extractText,
  type AgentCommands,
  type HistoryMessage,
  type ToolAfterHook,
  type ToolCall,
  type TurnBeforeStep,
} from '@moonshot-ai/agent-core';
import { parse } from '@moonshot-ai/tree-sitter-bash';

import type { OsHost } from '#/features/os/host/index';
import { normalizeUserPath, type PathClass } from '#/features/os/path-access';

import {
  AGENTS_MD_PLAIN_NAMES,
  agentsMdCandidatePaths,
  agentsMdWatchCandidates,
  dirsRootToLeaf,
  findAgentsMdInDir,
  findProjectRoot,
  loadAgentsMdPaths,
} from './agents-md-files';
import { extractBashTargetDirs } from './bash-targets';

const AGENTS_MD_BASENAMES: ReadonlySet<string> = new Set<string>(AGENTS_MD_PLAIN_NAMES);

const BASH_PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

export const AGENTS_MD_DISCOVERY_REMIND_KEY = 'agents-md-reminder';
export const AGENTS_MD_CHANGE_REMIND_KEY = 'agents-md-change';

export interface AgentsMdChange {
  readonly path: string;
  readonly action: 'created' | 'modified' | 'deleted';
}

export function agentsMdDiscoveryReminderText(paths: readonly string[]): string {
  return (
    'The following AGENTS.md file(s) apply to paths accessed by your recent tool call, but were not included in your system prompt:\n' +
    paths.map((path) => `- ${path}`).join('\n') +
    '\nRead them before making changes in those directories.'
  );
}

export function agentsMdChangeReminderText(changes: readonly AgentsMdChange[]): string {
  return (
    'The AGENTS.md instruction file(s) below changed on disk after they were injected into the system prompt:\n' +
    changes
      .map((change) => `- ${change.path}${change.action === 'deleted' ? ' (deleted)' : ''}`)
      .join('\n') +
    '\nRead the current file(s) and follow the latest contents; the copies injected in the system prompt are stale.'
  );
}

export interface OpenAgentsMdReminderDeps {
  readonly agent: AgentCommands;
  readonly host: OsHost;
  readonly workDir: string;
  readonly brandHome?: string;
}

export interface AgentsMdReminderService {
  seed(paths: readonly string[]): void;
  readonly afterTool: ToolAfterHook;
  readonly beforeStep: TurnBeforeStep;
}

interface HostEnv {
  readonly pathClass: PathClass;
  readonly homeDir: string;
}

interface WatchEntry {
  readonly path: string;
  mtime: number | undefined;
  canonical?: string;
}

export function openAgentsMdReminder(deps: OpenAgentsMdReminderDeps): AgentsMdReminderService {
  const { agent, host, workDir } = deps;
  const known = new Set<string>();
  const readRecently = new Set<string>();
  const flushed = new Set<string>();
  let disclosed = new Set<string>();
  let seeded = false;
  let seeding: Promise<void> | undefined;
  let watch: Promise<readonly WatchEntry[] | undefined> | undefined;
  let envPromise: Promise<HostEnv> | undefined;
  let queue: Promise<void> = Promise.resolve();

  function environment(): Promise<HostEnv> {
    envPromise ??= host.environment.ready.then(() => ({
      pathClass: host.environment.pathClass,
      homeDir: host.environment.homeDir,
    }));
    return envPromise;
  }

  function brandHomeOf(homeDir: string): string {
    return deps.brandHome ?? join(homeDir, '.kimi-code');
  }

  function seed(paths: readonly string[]): void {
    for (const path of paths) known.add(normalize(path));
    seeded = true;
    armWatch();
  }

  function armWatch(): void {
    watch ??= computeWatch().catch(() => {
      watch = undefined;
      return undefined;
    });
  }

  async function computeWatch(): Promise<WatchEntry[]> {
    const env = await environment();
    const candidates = await agentsMdWatchCandidates(
      { fs: host.fs, homeDir: env.homeDir },
      workDir,
      brandHomeOf(env.homeDir),
    );
    const entries: WatchEntry[] = [];
    for (const candidate of candidates) {
      const path = normalize(candidate);
      const mtime = await statMtime(path);
      const entry: WatchEntry = { path, mtime };
      if (mtime !== undefined) entry.canonical = await canonicalOf(path);
      entries.push(entry);
    }
    return entries;
  }

  async function statMtime(path: string): Promise<number | undefined> {
    const stat = await host.fs.stat(path).catch(() => undefined);
    return stat?.isFile === true ? stat.mtimeMs : undefined;
  }

  async function canonicalOf(path: string): Promise<string> {
    return normalize(await host.fs.realpath(path).catch(() => path));
  }

  async function ensureSeeded(): Promise<void> {
    if (seeded) return;
    seeding ??= (async () => {
      const env = await environment();
      const paths = await loadAgentsMdPaths(
        { fs: host.fs, homeDir: env.homeDir },
        workDir,
        brandHomeOf(env.homeDir),
      );
      seed(paths);
    })().catch((error: unknown) => {
      seeding = undefined;
      throw error;
    });
    await seeding;
  }

  function baseDir(pathClass: PathClass): string {
    return hostPath(workDir, pathClass);
  }

  function resolveAgainstWorkDir(raw: string, pathClass: PathClass): string {
    const normalized = normalizeUserPath(raw, pathClass);
    return normalize(
      isAbsolute(normalized) ? normalized : join(baseDir(pathClass), normalized),
    );
  }

  function targetDirs(
    toolCall: ToolCall,
    env: HostEnv,
  ): { dirs: string[]; selfKnown: string[] } | undefined {
    const args = parseToolArgs(toolCall.arguments);
    if (args === undefined) return undefined;
    switch (toolCall.name) {
      case 'Read':
      case 'Edit':
      case 'Write': {
        const raw = stringArg(args, 'file_path') ?? stringArg(args, 'path');
        if (raw === undefined) return { dirs: [], selfKnown: [] };
        const resolved = resolveAgainstWorkDir(raw, env.pathClass);
        const selfKnown = AGENTS_MD_BASENAMES.has(basename(resolved)) ? [resolved] : [];
        return { dirs: [dirname(resolved)], selfKnown };
      }
      case 'Glob':
      case 'Grep': {
        const raw = stringArg(args, 'path');
        const dir =
          raw === undefined ? baseDir(env.pathClass) : resolveAgainstWorkDir(raw, env.pathClass);
        return { dirs: [dir], selfKnown: [] };
      }
      case 'Bash': {
        const command = stringArg(args, 'command');
        if (command === undefined) return { dirs: [], selfKnown: [] };
        const cwdArg = stringArg(args, 'cwd');
        const base = baseDir(env.pathClass);
        const normalizedCwdArg =
          cwdArg === undefined ? undefined : normalizeUserPath(cwdArg, env.pathClass);
        const effectiveCwd =
          normalizedCwdArg === undefined
            ? base
            : normalize(
                isAbsolute(normalizedCwdArg)
                  ? normalizedCwdArg
                  : join(base, normalizedCwdArg),
              );
        const parsed = parse(command, BASH_PARSE_OPTIONS);
        if (!parsed.ok || parsed.hasError) {
          return normalizedCwdArg === undefined
            ? { dirs: [], selfKnown: [] }
            : { dirs: [effectiveCwd], selfKnown: [] };
        }
        const targets = extractBashTargetDirs(parsed.rootNode, effectiveCwd, env.homeDir).map(
          (target) => hostPath(target, env.pathClass),
        );
        if (normalizedCwdArg !== undefined && !targets.includes(effectiveCwd)) {
          targets.unshift(effectiveCwd);
        }
        return { dirs: targets, selfKnown: [] };
      }
      default:
        return { dirs: [], selfKnown: [] };
    }
  }

  async function probeDir(dir: string): Promise<string[]> {
    const anchor = await nearestExistingDir(dir);
    if (anchor === undefined) return [];
    const fsDeps = { fs: host.fs };
    const projectRoot = await findProjectRoot(fsDeps, anchor);
    const chain = dirsRootToLeaf(anchor, projectRoot);
    const found: string[] = [];
    for (const chainDir of chain) {
      const candidates = agentsMdCandidatePaths(chainDir);
      if (candidates.every((candidate) => known.has(normalize(candidate)))) continue;
      for (const path of await findAgentsMdInDir(fsDeps, chainDir)) {
        found.push(normalize(path));
      }
    }
    return found;
  }

  async function nearestExistingDir(path: string): Promise<string | undefined> {
    let current = path;
    for (;;) {
      const stat = await host.fs.stat(current).catch(() => undefined);
      if (stat?.isDirectory === true) return current;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  async function probeAndFlush(toolCall: ToolCall, isError: boolean): Promise<void> {
    try {
      await ensureSeeded();
      const env = await environment();
      const targets = targetDirs(toolCall, env);
      if (targets === undefined) return;
      const selfKnown = new Set<string>();
      if (!isError) {
        for (const candidate of targets.selfKnown) selfKnown.add(candidate);
      }
      const discovered: string[] = [];
      for (const dir of targets.dirs) {
        for (const path of await probeDir(dir)) {
          if (
            known.has(path) ||
            selfKnown.has(path) ||
            readRecently.has(path) ||
            flushed.has(path) ||
            disclosed.has(path) ||
            discovered.includes(path)
          ) {
            continue;
          }
          discovered.push(path);
        }
      }
      for (const path of selfKnown) readRecently.add(path);
      if (discovered.length === 0) return;
      const ack = agent.remind(
        createHistoryMessageBuilder()
          .systemReminder(agentsMdDiscoveryReminderText(discovered))
          .userMessage(),
        { key: AGENTS_MD_DISCOVERY_REMIND_KEY },
      );
      if (ack === undefined) return;
      for (const path of discovered) flushed.add(path);
    } catch {}
  }

  async function pollChanges(): Promise<void> {
    const entries = await watch;
    if (entries === undefined) return;
    const changes: AgentsMdChange[] = [];
    const seenChanges = new Set<string>();
    for (const entry of entries) {
      const mtime = await statMtime(entry.path);
      const before = entry.mtime;
      entry.mtime = mtime;
      if (mtime !== undefined) entry.canonical = await canonicalOf(entry.path);
      let action: AgentsMdChange['action'] | undefined;
      if (before === undefined && mtime !== undefined) {
        action = 'created';
      } else if (before !== undefined && mtime === undefined) {
        action = 'deleted';
      } else if (before !== undefined && mtime !== undefined && mtime !== before) {
        action = 'modified';
      }
      if (action === undefined) continue;
      const key = entry.canonical ?? entry.path;
      if (seenChanges.has(key)) continue;
      seenChanges.add(key);
      changes.push({ path: entry.path, action });
    }
    if (changes.length === 0) return;
    agent.remind(
      createHistoryMessageBuilder()
        .systemReminder(agentsMdChangeReminderText(changes))
        .userMessage(),
      { key: AGENTS_MD_CHANGE_REMIND_KEY },
    );
    for (const change of changes) {
      if (change.action === 'modified') known.add(change.path);
      if (change.action === 'deleted') {
        known.delete(change.path);
        flushed.delete(change.path);
        disclosed.delete(change.path);
        readRecently.delete(change.path);
      }
    }
  }

  return {
    seed,
    afterTool: ({ toolCall, result }) => {
      const run = queue.then(() => probeAndFlush(toolCall, result.isError === true));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    beforeStep: async (context) => {
      disclosed = disclosedPaths(context.messages);
      flushed.clear();
      readRecently.clear();
      if (!seeded) return;
      try {
        await pollChanges();
      } catch {}
    },
  };
}

function disclosedPaths(messages: readonly HistoryMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of messages) {
    if (
      entry.meta?.source !== 'reminder' ||
      entry.meta?.key !== AGENTS_MD_DISCOVERY_REMIND_KEY
    ) {
      continue;
    }
    for (const match of extractText(entry.message).matchAll(/^- (.+)$/gm)) {
      const path = match[1];
      if (path !== undefined) paths.add(normalize(path));
    }
  }
  return paths;
}

function hostPath(path: string, pathClass: PathClass): string {
  return normalize(normalizeUserPath(path, pathClass));
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseToolArgs(raw: string | null): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}
