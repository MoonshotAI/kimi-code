import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Environment, EnvironmentPath } from '#/environment/environment';
import { isRemoteEnvironment } from '#/environment/shareBinRg';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import type { FsSuggestResponse, FsSuggestStreamEvent } from '../fs';
import { computeMatchPositions, matchesAnyGlob, VCS_METADATA_DIRS } from './fsSearch';
import { runCommand } from './fsProcess';

export interface FdResolution {
  readonly path: string;
  readonly source: 'system-path' | 'share-bin-cached';
}

interface FdProbe {
  exec(args: readonly string[]): Promise<{ readonly exitCode: number }>;
}

interface FdRoot {
  readonly dir: string;
  readonly real: string;
  readonly primary: boolean;
}

interface FdTarget {
  readonly root: FdRoot;
  readonly baseDir: string;
  readonly displayBase: string;
  readonly fdQuery: string;
  readonly absolute: boolean;
}

interface FdEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

interface FdGroup {
  readonly target: FdTarget;
  readonly entries: readonly FdEntry[];
  readonly capped: boolean;
}

interface ScoredEntry {
  readonly target: FdTarget;
  readonly entry: FdEntry;
  readonly absolutePath: string;
  readonly ignored: boolean;
  readonly score: number;
}

interface FdSuggestOptions {
  readonly fdBinary: string;
  readonly query: string;
  readonly cap: number;
  readonly followGitignore: boolean;
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly roots: readonly FdRoot[];
  readonly path: EnvironmentPath;
  readonly hostFs: Pick<IHostFileSystem, 'stat' | 'realpath'>;
  readonly process: IHostProcessService;
  readonly workDir: string;
  readonly homeDir?: string;
  readonly signal: AbortSignal;
}

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fdPathQuery(query: string): string {
  const normalized = slash(query);
  if (!normalized.includes('/')) return escapeRegex(normalized);
  const trailing = normalized.endsWith('/');
  const trimmed = normalized.replaceAll(/^\/+|\/+$/g, '');
  if (!trimmed) return normalized;
  const segments = trimmed.split('/').filter(Boolean).map((segment) => escapeRegex(segment));
  let pattern = segments.join('[\\\\/]');
  if (trailing) pattern += '[\\\\/]';
  return pattern;
}

function inside(path: EnvironmentPath, candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function binaryName(): string {
  return process.platform === 'win32' ? 'fd.exe' : 'fd';
}

function cachedBinaryPath(environment: Environment | undefined): string {
  if (isRemoteEnvironment(environment)) {
    const homeDir = environment.host?.homeDir;
    if (homeDir !== undefined) {
      const binary = environment.host?.pathClass === 'win32' ? 'fd.exe' : 'fd';
      return environment.path?.join(homeDir, '.kimi-code', 'bin', binary) ?? `${homeDir}/.kimi-code/bin/${binary}`;
    }
  }
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return join(override, 'bin', binaryName());
  return join(homedir(), '.kimi-code', 'bin', binaryName());
}

export async function ensureFdPath(
  probe: FdProbe,
  options: { readonly signal?: AbortSignal; readonly environment?: Environment } = {},
): Promise<FdResolution> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  for (const binary of ['fd', 'fdfind']) {
    const result = await probe.exec([binary, '--version']).catch(() => ({ exitCode: -1 }));
    if (result.exitCode === 0) return { path: binary, source: 'system-path' };
  }
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cached = cachedBinaryPath(options.environment);
  const result = await probe.exec([cached, '--version']).catch(() => ({ exitCode: -1 }));
  if (result.exitCode === 0) return { path: cached, source: 'share-bin-cached' };
  throw new Error('fd is not available');
}

export async function suggestWithFd(options: FdSuggestOptions): Promise<FsSuggestResponse> {
  for await (const event of suggestWithFdEvents(options)) {
    if (event.phase === 'final') return event.response;
  }
  throw new Error('fd suggestion ended without a final response');
}

export async function* suggestWithFdEvents(options: FdSuggestOptions): AsyncGenerator<FsSuggestStreamEvent> {
  const { path } = options;
  const normalizedQuery = slash(options.query);
  const slashIndex = normalizedQuery.lastIndexOf('/');
  const scopeBase = slashIndex < 0 ? undefined : normalizedQuery.slice(0, slashIndex + 1);
  const scopeQuery = slashIndex < 0 ? normalizedQuery : normalizedQuery.slice(slashIndex + 1);

  const validDirectory = async (candidate: string): Promise<FdRoot | undefined> => {
    if (options.signal.aborted) return undefined;
    try {
      const [stat, real] = await Promise.all([
        options.hostFs.stat(candidate),
        options.hostFs.realpath(candidate),
      ]);
      if (options.signal.aborted || !stat.isDirectory) return undefined;
      return options.roots.find((root) => inside(path, real, root.real));
    } catch {
      return undefined;
    }
  };

  const fullTarget = (root: FdRoot): FdTarget => ({
    root,
    baseDir: root.dir,
    displayBase: '',
    fdQuery: normalizedQuery,
    absolute: false,
  });
  const targets: FdTarget[] = [];
  if (scopeBase !== undefined && (scopeBase.startsWith('/') || scopeBase.startsWith('~/'))) {
    const homeDir = options.homeDir ?? homedir();
    const baseDir = scopeBase.startsWith('~/')
      ? path.join(homeDir, scopeBase.slice(2))
      : scopeBase;
    const owner = await validDirectory(baseDir);
    if (owner !== undefined) {
      targets.push({
        root: owner,
        baseDir,
        displayBase: scopeBase,
        fdQuery: scopeQuery,
        absolute: true,
      });
    }
  } else if (scopeBase !== undefined) {
    for (const root of options.roots) {
      if (options.signal.aborted) break;
      const baseDir = path.resolve(root.dir, scopeBase);
      const owner = await validDirectory(baseDir);
      targets.push(owner === undefined
        ? fullTarget(root)
        : { root, baseDir, displayBase: scopeBase, fdQuery: scopeQuery, absolute: false });
    }
  } else {
    for (const root of options.roots) {
      if (options.signal.aborted) break;
      targets.push(fullTarget(root));
    }
  }
  if (targets.length === 0 || options.signal.aborted) {
    yield { phase: 'final', response: { items: [], truncated: options.signal.aborted } };
    return;
  }

  const runPass = async (target: FdTarget, includeIgnored: boolean, maxDepth?: number): Promise<FdGroup> => {
    const args = [
      options.fdBinary,
      '--base-directory', target.baseDir,
      '--max-results', '100',
      '--type', 'f',
      '--type', 'd',
      '--hidden',
    ];
    for (const dir of VCS_METADATA_DIRS) {
      args.push('--exclude', dir, '--exclude', `${dir}/*`, '--exclude', `${dir}/**`);
    }
    if (includeIgnored) args.push('--no-ignore-vcs');
    if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth));
    if (target.fdQuery.includes('/')) args.push('--full-path');
    if (target.fdQuery) args.push(fdPathQuery(target.fdQuery));
    const result = await runCommand(options.process, args, {
      cwd: options.workDir,
      signal: options.signal,
    });
    if (result.exitCode !== 0 || result.stdout.length === 0 || options.signal.aborted) {
      return { target, entries: [], capped: false };
    }
    const basePrefix = `${slash(target.baseDir).replace(/\/$/, '')}/`;
    const entries: FdEntry[] = [];
    let rawCount = 0;
    for (const raw of result.stdout.split(/\r?\n/)) {
      if (!raw) continue;
      rawCount += 1;
      let line = slash(raw);
      if (line.startsWith(basePrefix)) line = line.slice(basePrefix.length);
      if (line.startsWith('./')) line = line.slice(2);
      const isDirectory = line.endsWith('/');
      const rel = isDirectory ? line.slice(0, -1) : line;
      if (!rel || rel.split('/').some((segment) => VCS_METADATA_DIRS.has(segment))) continue;
      entries.push({ path: rel, isDirectory });
    }
    return { target, entries, capped: rawCount >= 100 };
  };

  const collectGroups = async (includeIgnored: boolean): Promise<readonly FdGroup[]> => {
    return Promise.all(targets.map(async (target) => {
      const base = await runPass(target, includeIgnored, 1);
      const recursive = await runPass(target, includeIgnored);
      const seen = new Set(base.entries.map((entry) => entry.path));
      const entries = [
        ...base.entries,
        ...recursive.entries.filter((entry) => {
          if (seen.has(entry.path)) return false;
          seen.add(entry.path);
          return true;
        }),
      ];
      return { target, entries, capped: base.capped || recursive.capped };
    }));
  };

  const best = new Map<string, ScoredEntry>();
  const collect = (groups: readonly FdGroup[], ignored: boolean): void => {
    for (const group of groups) {
      for (const entry of group.entries) {
        const lowerName = entry.path.slice(entry.path.lastIndexOf('/') + 1).toLowerCase();
        const lowerQuery = group.target.fdQuery.toLowerCase();
        const lowerPath = entry.path.toLowerCase();
        let score = 0;
        if (group.target.fdQuery === '') score = 1;
        else if (lowerName === lowerQuery) score = 100;
        else if (lowerName.startsWith(lowerQuery)) score = 80;
        else if (lowerName.includes(lowerQuery)) score = 50;
        else if (lowerPath.includes(lowerQuery)) score = 30;
        if (entry.isDirectory && group.target.fdQuery !== '' && score > 0) score += 10;
        if (score <= 0) continue;
        const absolutePath = path.join(group.target.baseDir, entry.path);
        const relForGlobs = group.target.absolute
          ? slash(path.relative(group.target.root.dir, absolutePath))
          : `${group.target.displayBase}${entry.path}`;
        if (options.includeGlobs !== undefined && !matchesAnyGlob(relForGlobs, options.includeGlobs)) continue;
        if (options.excludeGlobs !== undefined && matchesAnyGlob(relForGlobs, options.excludeGlobs)) continue;
        const candidate: ScoredEntry = {
          target: group.target,
          entry,
          absolutePath: slash(absolutePath),
          ignored,
          score,
        };
        const existing = best.get(candidate.absolutePath);
        if (
          existing === undefined ||
          (existing.ignored === ignored && score > existing.score) ||
          (existing.ignored && !ignored)
        ) {
          best.set(candidate.absolutePath, candidate);
        }
      }
    }
  };

  const response = (preview: boolean): FsSuggestResponse => {
    const ranked = [...best.values()];
    ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.ignored !== b.ignored) return Number(a.ignored) - Number(b.ignored);
      const aDepth = a.entry.path.split('/').filter(Boolean).length;
      const bDepth = b.entry.path.split('/').filter(Boolean).length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
      return a.entry.path.localeCompare(b.entry.path);
    });
    const items = ranked.slice(0, options.cap).map((candidate) => {
      const displayPath = candidate.target.absolute || !candidate.target.root.primary
        ? candidate.target.absolute
          ? `${candidate.target.displayBase}${candidate.entry.path}`
          : candidate.absolutePath
        : `${candidate.target.displayBase}${candidate.entry.path}`;
      return {
        path: displayPath,
        name: candidate.entry.path.slice(candidate.entry.path.lastIndexOf('/') + 1),
        kind: candidate.entry.isDirectory ? 'directory' as const : 'file' as const,
        score: Math.min(1, candidate.score / 110),
        match_positions: computeMatchPositions(displayPath, options.query.toLowerCase()),
      };
    });
    return {
      items,
      truncated: preview || options.signal.aborted || ranked.length > options.cap || groups.some((group) => group.capped),
    };
  };

  const ordinary = await collectGroups(false);
  collect(ordinary, false);
  const highest = [...best.values()].filter((entry) => entry.score >= 110).length;
  const canSkipIgnored = best.size >= 20 && highest >= 20;
  const groups: FdGroup[] = [...ordinary];
  if (!options.followGitignore && !canSkipIgnored && !options.signal.aborted && best.size > 0) {
    yield { phase: 'preview', response: response(true) };
  }
  if (!options.followGitignore && !canSkipIgnored && !options.signal.aborted) {
    const ignored = await collectGroups(true);
    groups.push(...ignored);
    collect(ignored, true);
  }
  yield { phase: 'final', response: response(false) };
}
