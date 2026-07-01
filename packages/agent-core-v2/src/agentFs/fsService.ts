/**
 * `agentFs` domain (L2) — `ISessionFsService` implementation.
 *
 * Backs the fs REST surface (search / grep / git status / git diff) by
 * orchestrating `ISessionAgentFileSystem` (file IO) and `ISessionProcessRunner` (`rg` /
 * `git` / `gh`). Bound at Session scope — the workspace root and execution
 * environment come from the scope, so no `sessionId` is threaded through.
 *
 * Path confinement is lexical (`ISessionWorkspaceContext.isWithin`); it does not
 * follow symlinks, matching the rest of v2 (`_base/tools/policies/path-access.ts`).
 */

import { basename, extname, isAbsolute, relative, sep } from 'node:path';

import {
  ErrorCode,
  type FsDiffRequest,
  type FsDiffResponse,
  type FsEntry,
  type FsGitStatusRequest,
  type FsGitStatusResponse,
  type FsGrepFileHit,
  type FsGrepMatch,
  type FsGrepRequest,
  type FsGrepResponse,
  type FsListManyRequest,
  type FsListManyResponse,
  type FsListRequest,
  type FsListResponse,
  type FsMkdirRequest,
  type FsMkdirResponse,
  type FsPullRequest,
  type FsReadRequest,
  type FsReadResponse,
  type FsSearchHit,
  type FsSearchRequest,
  type FsSearchResponse,
  type FsStatManyRequest,
  type FsStatManyResponse,
  type FsStatRequest,
  type FsStatResponse,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';
import { ISessionProcessRunner } from '#/process';
import { ITelemetryService } from '#/telemetry';
import { ISessionWorkspaceContext } from '#/workspaceContext';

import { type AgentFileStat, ISessionAgentFileSystem } from './agentFs';
import { type FsDownloadResolved, type FsPathResolved, ISessionFsService } from './fs';
import { parseNumstat, parsePorcelain, parsePullRequest } from './fsGit';
import { runCommand } from './fsProcess';
import { ensureRgPath, type RgProbe, type RgResolution } from './rgLocator';
import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  matchesAnyGlob,
  type RgJsonRecord,
  rgPath,
  rgText,
  stripTrailingNewline,
} from './fsSearch';

const SEARCH_HARD_CAP = 500;
const GREP_TIMEOUT_MS = 30_000;
const WALK_MAX_DEPTH = 64;
const DIFF_MAX_BYTES = 1_048_576;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

/** Hard cap for `fs:read` payloads (10 MiB). */
const FS_READ_MAX_BYTES = 10 * 1024 * 1024;
/** Sample size used to sniff binary content. */
const FS_BINARY_SAMPLE_BYTES = 4096;
/** Fraction of non-printable bytes above which a sample is treated as binary. */
const FS_BINARY_NONPRINTABLE_FRACTION = 0.3;

const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set(['.DS_Store', '.AppleDouble', '.LSOverride']);

export class SessionFsService implements ISessionFsService {
  declare readonly _serviceBrand: undefined;

  private readonly gitignoreCache = new Map<string, Ignore>();
  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();
  /**
   * Cached ripgrep resolution. `undefined` = not probed yet; `null` = probed
   * and unavailable (use the node fallback). Mirrors the old `rgAvailable`
   * boolean cache so we probe at most once per session.
   */
  private rgResolution: RgResolution | null | undefined = undefined;

  constructor(
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionAgentFileSystem private readonly fs: ISessionAgentFileSystem,
    @ISessionProcessRunner private readonly runner: ISessionProcessRunner,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async list(req: FsListRequest): Promise<FsListResponse> {
    const abs = this.resolveWithin(req.path);
    const rel = this.toRel(abs);

    let topStat: AgentFileStat;
    try {
      topStat = await this.fs.stat(rel);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    if (!topStat.isDirectory) {
      throw new KimiError(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${req.path}`, {
        details: { path: req.path },
      });
    }

    const gitignore = req.follow_gitignore ? await this.matcher() : undefined;

    const items: FsEntry[] = [];
    const childrenByPath: Record<string, FsEntry[]> = {};
    let truncated = false;

    interface QueueEntry {
      readonly relPath: string;
      readonly depthRemaining: number;
    }
    const queue: QueueEntry[] = [
      { relPath: rel === '.' ? '' : rel, depthRemaining: req.depth },
    ];

    interface Child {
      readonly name: string;
      readonly relPath: string;
      readonly stat: AgentFileStat;
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      let names: readonly string[];
      try {
        names = await this.fs.readdir(entry.relPath === '' ? '.' : entry.relPath);
      } catch (err) {
        if (entry.relPath === (rel === '.' ? '' : rel)) {
          throw mapFsError(err, req.path);
        }
        continue;
      }

      const visible: Child[] = [];
      for (const name of names) {
        if (!req.show_hidden && isHidden(name)) continue;
        const childRel = entry.relPath === '' ? name : `${entry.relPath}/${name}`;
        if (gitignore && (gitignore.ignores(childRel) || gitignore.ignores(`${childRel}/`))) {
          continue;
        }
        if (req.exclude_globs && matchesAnyGlob(childRel, req.exclude_globs)) continue;
        const st = await this.fs.stat(childRel).catch(() => undefined);
        if (st === undefined) continue;
        visible.push({ name, relPath: childRel, stat: st });
      }

      sortChildren(visible, req.sort);

      const parentKey = entry.relPath === '' ? '.' : entry.relPath;
      const bucket: FsEntry[] = [];
      for (const child of visible) {
        if (items.length >= req.limit && entry.depthRemaining === req.depth) {
          truncated = true;
          break;
        }
        const fsEntry = buildFsEntry(child.relPath, child.name, child.stat, false);
        if (entry.depthRemaining === req.depth) {
          items.push(fsEntry);
        }
        bucket.push(fsEntry);
        if (child.stat.isDirectory && entry.depthRemaining > 1) {
          queue.push({ relPath: child.relPath, depthRemaining: entry.depthRemaining - 1 });
        }
      }

      if (entry.depthRemaining < req.depth) {
        childrenByPath[parentKey] = bucket;
      }
    }

    const response: FsListResponse = { items, truncated };
    if (Object.keys(childrenByPath).length > 0) {
      response.children_by_path = childrenByPath;
    }
    return response;
  }

  async read(req: FsReadRequest): Promise<FsReadResponse> {
    const abs = this.resolveWithin(req.path);
    const rel = this.toRel(abs);

    let st: AgentFileStat;
    try {
      st = await this.fs.stat(rel);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    if (st.isDirectory) {
      throw new KimiError(ErrorCodes.FS_IS_DIRECTORY, `path is a directory: ${req.path}`, {
        details: { path: req.path },
      });
    }
    if (st.size > FS_READ_MAX_BYTES) {
      throw new KimiError(
        ErrorCodes.FS_TOO_LARGE,
        `file too large: ${req.path} (${st.size} bytes > ${FS_READ_MAX_BYTES})`,
        { details: { path: req.path, size: st.size } },
      );
    }

    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await this.fs.readBytes(rel, sampleSize);
    const isBinary = detectBinary(sample);

    if (isBinary && req.encoding === 'utf-8') {
      throw new KimiError(ErrorCodes.FS_IS_BINARY, `file is binary: ${req.path}`, {
        details: { path: req.path },
      });
    }

    const effectiveLength = Math.min(req.length, st.size - req.offset);
    let bytes: Uint8Array;
    if (effectiveLength <= 0) {
      bytes = new Uint8Array();
    } else {
      const window = await this.fs.readBytes(rel, req.offset + effectiveLength);
      bytes = window.subarray(req.offset, req.offset + effectiveLength);
    }

    const encoding: 'utf-8' | 'base64' =
      req.encoding === 'base64' || (req.encoding === 'auto' && isBinary) ? 'base64' : 'utf-8';
    const content =
      encoding === 'utf-8'
        ? Buffer.from(bytes).toString('utf-8')
        : Buffer.from(bytes).toString('base64');
    const truncated = req.offset + effectiveLength < st.size;

    const out: FsReadResponse = {
      path: rel,
      content,
      encoding,
      size: st.size,
      truncated,
      etag: buildEtag(st),
      mime: guessMime(rel, isBinary),
      is_binary: isBinary,
    };
    const languageId = encoding === 'utf-8' ? guessLanguageId(rel) : undefined;
    if (languageId !== undefined) out.language_id = languageId;
    if (encoding === 'utf-8') out.line_count = countLines(content);
    return out;
  }

  async listMany(req: FsListManyRequest): Promise<FsListManyResponse> {
    const results: Record<string, FsEntry[]> = {};
    const partialErrors: Record<string, { code: number; msg: string }> = {};
    const truncatedPaths: string[] = [];

    await Promise.all(
      req.paths.map(async (p) => {
        try {
          const sub = await this.list({
            path: p,
            depth: req.depth,
            limit: req.limit,
            show_hidden: req.show_hidden,
            follow_gitignore: req.follow_gitignore,
            exclude_globs: req.exclude_globs,
            sort: req.sort,
            include_git_status: req.include_git_status,
          });
          results[p] = sub.items;
          if (sub.truncated) truncatedPaths.push(p);
        } catch (err) {
          if (err instanceof KimiError && err.code === ErrorCodes.FS_PATH_ESCAPES) throw err;
          partialErrors[p] = toWireError(err);
        }
      }),
    );

    const out: FsListManyResponse = { results };
    if (truncatedPaths.length > 0) out.truncated_paths = truncatedPaths;
    if (Object.keys(partialErrors).length > 0) out.partial_errors = partialErrors;
    return out;
  }

  async stat(req: FsStatRequest): Promise<FsStatResponse> {
    const abs = this.resolveWithin(req.path);
    const rel = this.toRel(abs);
    let st: AgentFileStat;
    try {
      st = await this.fs.stat(rel);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    const name = rel === '.' ? basename(this.workspace.workDir) : basename(abs);
    return buildFsEntry(rel, name, st, true);
  }

  async statMany(req: FsStatManyRequest): Promise<FsStatManyResponse> {
    const resolved = req.paths.map((p) => {
      const abs = this.resolveWithin(p);
      return { raw: p, rel: this.toRel(abs), abs };
    });

    const entries: Record<string, FsEntry | null> = {};
    await Promise.all(
      resolved.map(async ({ raw, rel, abs }) => {
        try {
          const st = await this.fs.stat(rel);
          const name = rel === '.' ? basename(this.workspace.workDir) : basename(abs);
          entries[raw] = buildFsEntry(rel, name, st, false);
        } catch {
          entries[raw] = null;
        }
      }),
    );
    return { entries };
  }

  async mkdir(req: FsMkdirRequest): Promise<FsMkdirResponse> {
    const abs = this.resolveWithin(req.path);
    const rel = this.toRel(abs);
    try {
      await this.fs.mkdir(rel, { parents: req.recursive, existOk: req.recursive });
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EEXIST') {
        throw new KimiError(ErrorCodes.FS_ALREADY_EXISTS, `path already exists: ${req.path}`, {
          details: { path: req.path },
        });
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new KimiError(ErrorCodes.FS_PATH_NOT_FOUND, `parent not found: ${req.path}`, {
          details: { path: req.path },
        });
      }
      throw err;
    }
    const st = await this.fs.stat(rel);
    return buildFsEntry(rel, basename(abs), st, false);
  }

  async resolvePath(relPath: string): Promise<FsPathResolved> {
    const abs = this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: AgentFileStat;
    try {
      st = await this.fs.stat(rel);
    } catch (err) {
      throw mapFsError(err, relPath);
    }
    return { absolute: abs, relative: rel, isDirectory: st.isDirectory };
  }

  async resolveDownload(relPath: string): Promise<FsDownloadResolved> {
    const abs = this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: AgentFileStat;
    try {
      st = await this.fs.stat(rel);
    } catch (err) {
      throw mapFsError(err, relPath);
    }
    if (st.isDirectory) {
      throw new KimiError(ErrorCodes.FS_IS_DIRECTORY, `path is a directory: ${relPath}`, {
        details: { path: relPath },
      });
    }
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await this.fs.readBytes(rel, sampleSize);
    const isBinary = detectBinary(sample);
    return {
      absolute: abs,
      relative: rel,
      size: st.size,
      etag: buildEtag(st),
      mime: guessMime(rel, isBinary),
      modifiedAt: new Date(st.mtimeMs ?? 0),
    };
  }

  async search(req: FsSearchRequest): Promise<FsSearchResponse> {
    const matcher = req.follow_gitignore ? await this.matcher() : undefined;
    const candidates: FsSearchHit[] = [];
    const queryLower = req.query.toLowerCase();

    await this.walk('', matcher, async (relPath, name, kind) => {
      const score = computeFuzzyScore(name, queryLower);
      if (score <= 0) return;
      if (req.include_globs && !matchesAnyGlob(relPath, req.include_globs)) {
        return;
      }
      if (req.exclude_globs && matchesAnyGlob(relPath, req.exclude_globs)) {
        return;
      }
      candidates.push({
        path: relPath,
        name,
        kind,
        score,
        match_positions: computeMatchPositions(relPath, queryLower),
      });
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });

    const effectiveCap = Math.min(req.limit, SEARCH_HARD_CAP);
    const truncated = candidates.length > effectiveCap;
    return { items: candidates.slice(0, effectiveCap), truncated };
  }

  async grep(req: FsGrepRequest): Promise<FsGrepResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GREP_TIMEOUT_MS);
    timer.unref?.();
    try {
      const resolution = await this.resolveRg();
      if (resolution !== null) {
        return await this.grepWithRg(req, controller.signal, startedAt, resolution.path);
      }
      this.telemetry.track('fs_grep_node_fallback', { reason: 'rg_missing' });
      return await this.grepWithNode(req, controller.signal, startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse> {
    const cwd = this.workspace.workDir;

    let filterSet: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filterSet = new Set();
      for (const p of req.paths) {
        filterSet.add(this.toRel(this.resolveWithin(p)));
      }
    }

    const inside = await runCommand(
      this.runner,
      ['git', 'rev-parse', '--is-inside-work-tree'],
      { cwd },
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await runCommand(
      this.runner,
      ['git', 'status', '--porcelain=v1', '--branch'],
      { cwd },
    );
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, filterSet);

    const dirty = porc.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('## '));
    if (dirty) {
      const head = await runCommand(
        this.runner,
        ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'],
        { cwd },
      );
      if (head.exitCode === 0) {
        const numstat = await runCommand(
          this.runner,
          ['git', 'diff', '--no-color', '--numstat', 'HEAD', '--'],
          { cwd },
        );
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd);
    return result;
  }

  async diff(req: FsDiffRequest): Promise<FsDiffResponse> {
    const cwd = this.workspace.workDir;
    const rel = this.toRel(this.resolveWithin(req.path));

    const inside = await runCommand(
      this.runner,
      ['git', 'rev-parse', '--is-inside-work-tree'],
      { cwd },
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await runCommand(
      this.runner,
      ['git', 'status', '--porcelain=v1', '--', rel],
      { cwd },
    );
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await runCommand(
      this.runner,
      ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'],
      { cwd },
    );
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      const res = await runCommand(
        this.runner,
        ['git', 'diff', '--no-color', '--no-index', '--', '/dev/null', rel],
        { cwd },
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await runCommand(
        this.runner,
        ['git', 'diff', '--no-color', 'HEAD', '--', rel],
        { cwd },
      );
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await this.fs.stat(rel).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new KimiError(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${req.path}`, {
            details: { path: req.path },
          });
        }
      }
      diffStdout = res.stdout;
    }

    const truncated = diffStdout.length > DIFF_MAX_BYTES;
    return {
      path: rel,
      diff: truncated ? diffStdout.slice(0, DIFF_MAX_BYTES) : diffStdout,
      truncated,
    };
  }

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PR_SPAWN_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await runCommand(
        this.runner,
        ['gh', 'pr', 'view', '--json', 'number,url,state'],
        {
          cwd,
          env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
          signal: controller.signal,
        },
      );
      const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
      this.pullRequestCache.set(cwd, { value, fetchedAt: now });
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  private async grepWithRg(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
    rgPath: string,
  ): Promise<FsGrepResponse> {
    const args = ['--json'];
    if (req.context_lines > 0) {
      args.push('--context', String(req.context_lines));
    }
    if (!req.case_sensitive) args.push('--ignore-case');
    if (!req.regex) args.push('--fixed-strings');
    if (req.follow_gitignore) {
      args.push('--no-require-git');
    } else {
      args.push('--no-ignore');
    }
    if (req.include_globs) {
      for (const g of req.include_globs) args.push('--glob', g);
    }
    if (req.exclude_globs) {
      for (const g of req.exclude_globs) args.push('--glob', `!${g}`);
    }
    args.push('--max-count', String(req.max_matches_per_file));
    args.push(req.pattern);
    args.push('.');

    const res = await runCommand(this.runner, [rgPath, ...args], {
      cwd: this.workspace.workDir,
      signal,
    });

    return parseRgJsonOutput(res.stdout, req, signal.aborted, Date.now() - startedAt);
  }

  private async grepWithNode(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FsGrepResponse> {
    const matcher = req.follow_gitignore ? await this.matcher() : undefined;
    const re = compileGrepPattern(req);

    const files: FsGrepFileHit[] = [];
    let filesScanned = 0;
    let totalMatches = 0;
    let truncated = false;

    const filePaths: string[] = [];
    await this.walk('', matcher, async (rel, _name, kind) => {
      if (kind !== 'file') return;
      if (req.include_globs && !matchesAnyGlob(rel, req.include_globs)) return;
      if (req.exclude_globs && matchesAnyGlob(rel, req.exclude_globs)) return;
      filePaths.push(rel);
    });

    for (const rel of filePaths) {
      if (signal.aborted) {
        if (totalMatches === 0 && filesScanned === 0) {
          throw new KimiError(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${Date.now() - startedAt}ms`);
        }
        truncated = true;
        break;
      }
      if (filesScanned >= req.max_files) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      let content: string;
      try {
        content = await this.fs.readText(rel);
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const matches: FsGrepMatch[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m === null) continue;
        if (matches.length >= req.max_matches_per_file) break;
        const before: string[] = [];
        for (let k = Math.max(0, i - req.context_lines); k < i; k++) {
          before.push(lines[k] ?? '');
        }
        const after: string[] = [];
        for (let k = i + 1; k < Math.min(lines.length, i + 1 + req.context_lines); k++) {
          after.push(lines[k] ?? '');
        }
        matches.push({ line: i + 1, col: m.index + 1, text: line, before, after });
        totalMatches += 1;
        if (totalMatches >= req.max_total_matches) {
          truncated = true;
          break;
        }
      }
      if (matches.length > 0) {
        files.push({ path: rel, matches });
      }
      if (totalMatches >= req.max_total_matches) break;
    }

    return { files, files_scanned: filesScanned, truncated, elapsed_ms: Date.now() - startedAt };
  }

  private async walk(
    rootRel: string,
    matcher: Ignore | undefined,
    visit: (
      relPath: string,
      name: string,
      kind: 'file' | 'directory' | 'symlink',
    ) => Promise<void>,
    depth = 0,
  ): Promise<void> {
    if (depth > WALK_MAX_DEPTH) return;
    let names: readonly string[];
    try {
      names = await this.fs.readdir(rootRel === '' ? '.' : rootRel);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const childRel = rootRel === '' ? name : `${rootRel}/${name}`;
      const st = await this.fs.stat(childRel).catch(() => undefined);
      if (st === undefined) continue;
      const isDir = st.isDirectory;
      if (matcher) {
        const probe = isDir ? `${childRel}/` : childRel;
        if (matcher.ignores(probe)) continue;
      }
      const kind: 'file' | 'directory' | 'symlink' = isDir ? 'directory' : 'file';
      await visit(childRel, name, kind);
      if (isDir) {
        await this.walk(childRel, matcher, visit, depth + 1);
      }
    }
  }

  private async matcher(): Promise<Ignore | undefined> {
    const cwd = this.workspace.workDir;
    const cached = this.gitignoreCache.get(cwd);
    if (cached !== undefined) return cached;
    const ig = ignore();
    ig.add('.git/');
    try {
      const contents = await this.fs.readText('.gitignore');
      ig.add(contents);
    } catch {
      // No .gitignore — keep the `.git/` default only.
    }
    this.gitignoreCache.set(cwd, ig);
    return ig;
  }

  /**
   * Resolve a usable `rg` once per session via the shared locator. Probes
   * `rg --version` through the session runner (so it respects the execution
   * environment). Returns `null` when `rg` is unavailable so the caller can
   * fall back to the pure-node walker. The cached-binary fallback is disabled
   * here — Grep's node fallback already covers the missing-`rg` case and
   * keeping it off makes the fallback deterministic.
   */
  private async resolveRg(): Promise<RgResolution | null> {
    if (this.rgResolution !== undefined) return this.rgResolution;
    const probe: RgProbe = {
      exec: (args) => runCommand(this.runner, args, { cwd: this.workspace.workDir }),
    };
    try {
      this.rgResolution = await ensureRgPath(probe);
    } catch {
      this.rgResolution = null;
    }
    return this.rgResolution;
  }

  private resolveWithin(inputPath: string): string {
    if (inputPath === '' || inputPath === '/') {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (empty)`, {
        details: { path: inputPath, reason: 'empty' },
      });
    }
    if (isAbsolute(inputPath)) {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (absolute)`, {
        details: { path: inputPath, reason: 'absolute' },
      });
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (dotdot segment)`, {
        details: { path: inputPath, reason: 'dotdot_segment' },
      });
    }
    const abs = this.workspace.resolve(inputPath);
    if (!this.workspace.isWithin(abs)) {
      throw new KimiError(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" escapes workspace`, {
        details: { path: inputPath, reason: 'resolved_outside' },
      });
    }
    return abs;
  }

  private toRel(abs: string): string {
    const cwd = this.workspace.workDir;
    if (abs === cwd) return '.';
    const rel = relative(cwd, abs);
    if (rel === '') return '.';
    return rel.split(sep).join('/');
  }

  private gitUnavailable(cwd: string, detail: string): KimiError {
    return new KimiError(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: ${detail}`, {
      details: { cwd, detail },
    });
  }
}

function parseRgJsonOutput(
  stdout: string,
  req: FsGrepRequest,
  aborted: boolean,
  elapsedMs: number,
): FsGrepResponse {
  const fileBuf = new Map<
    string,
    { matches: FsGrepMatch[]; pending: string[]; lastMatchLine: number }
  >();
  const files: FsGrepFileHit[] = [];
  let totalMatches = 0;
  let truncated = false;
  let filesScanned = 0;

  const finalize = (p: string): void => {
    const buf = fileBuf.get(p);
    if (buf === undefined) return;
    if (buf.matches.length > 0 && buf.pending.length > 0) {
      const last = buf.matches[buf.matches.length - 1]!;
      last.after = buf.pending.slice(0, req.context_lines);
    }
    if (buf.matches.length > 0) {
      files.push({ path: p, matches: buf.matches });
    }
    fileBuf.delete(p);
  };

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    let rec: RgJsonRecord;
    try {
      rec = JSON.parse(line) as RgJsonRecord;
    } catch {
      continue;
    }
    const t = rec.type;
    if (t === 'begin') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      if (filesScanned >= req.max_files) {
        truncated = true;
        continue;
      }
      fileBuf.set(p, { matches: [], pending: [], lastMatchLine: -1 });
      filesScanned += 1;
    } else if (t === 'context') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      const buf = fileBuf.get(p);
      if (buf === undefined) continue;
      buf.pending.push(stripTrailingNewline(rgText(rec.data?.lines)));
      if (buf.pending.length > req.context_lines * 2) {
        buf.pending.shift();
      }
    } else if (t === 'match') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      const buf = fileBuf.get(p);
      if (buf === undefined) continue;
      if (totalMatches >= req.max_total_matches) {
        truncated = true;
        continue;
      }
      if (buf.matches.length >= req.max_matches_per_file) continue;
      const text = stripTrailingNewline(rgText(rec.data?.lines));
      const lineNo = rec.data?.line_number ?? 0;
      const col = (rec.data?.submatches?.[0]?.start ?? 0) + 1;
      const before = buf.pending.slice(-req.context_lines);
      buf.pending.length = 0;
      buf.matches.push({ line: lineNo, col, text, before, after: [] });
      buf.lastMatchLine = lineNo;
      totalMatches += 1;
      if (totalMatches >= req.max_total_matches) truncated = true;
    } else if (t === 'end') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) continue;
      finalize(p);
    }
  }

  for (const p of [...fileBuf.keys()]) {
    finalize(p);
  }

  if (aborted) {
    if (totalMatches === 0 && filesScanned === 0) {
      throw new KimiError(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${elapsedMs}ms`);
    }
    truncated = true;
  }

  return { files, files_scanned: filesScanned, truncated, elapsed_ms: elapsedMs };
}

// ---------------------------------------------------------------------------
// Helpers shared by the list/read/stat/mkdir methods. Ported from the v1
// `SessionFsService` so the `/api/v1` mirror stays byte-compatible.
// ---------------------------------------------------------------------------

function isHidden(name: string): boolean {
  return HIDDEN_NAME_RE.test(name) || MACOS_NOISE.has(name);
}

function sortChildren(
  children: { name: string; stat: AgentFileStat }[],
  sort: FsListRequest['sort'],
): void {
  const cmp = {
    type_first: (a: { name: string; stat: AgentFileStat }, b: { name: string; stat: AgentFileStat }) => {
      const ad = a.stat.isDirectory ? 0 : 1;
      const bd = b.stat.isDirectory ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    },
    name_asc: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
    name_desc: (a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name),
    // v1 does not implement mtime/size ordering; keep the same name fallback.
    mtime_desc: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
    size_desc: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
  }[sort];
  children.sort(cmp);
}

function buildEtag(st: AgentFileStat): string {
  const mtime = Math.floor(st.mtimeMs ?? 0);
  const ino = st.ino ?? 0;
  return [mtime.toString(36), st.size.toString(36), ino.toString(36)].join('-');
}

function buildFsEntry(
  relPath: string,
  name: string,
  st: AgentFileStat,
  withMime: boolean,
): FsEntry {
  const kind: FsEntry['kind'] = st.isDirectory ? 'directory' : 'file';
  const entry: FsEntry = {
    path: relPath,
    name,
    kind,
    modified_at: new Date(st.mtimeMs ?? 0).toISOString(),
    etag: buildEtag(st),
  };
  if (kind === 'file') {
    entry.size = st.size;
  }
  if (withMime && kind === 'file') {
    entry.mime = guessMime(relPath, false);
    const lang = guessLanguageId(relPath);
    if (lang !== undefined) entry.language_id = lang;
  }
  return entry;
}

function detectBinary(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 32 && b <= 126) continue;
    nonPrintable++;
  }
  return nonPrintable / buf.length > FS_BINARY_NONPRINTABLE_FRACTION;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  if (text.charCodeAt(text.length - 1) === 10) n--;
  return Math.max(0, n);
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function mapFsError(err: unknown, inputPath: string): Error {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new KimiError(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${inputPath}`, {
      details: { path: inputPath },
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

function toWireError(err: unknown): { code: number; msg: string } {
  if (err instanceof KimiError) {
    switch (err.code) {
      case ErrorCodes.FS_PATH_NOT_FOUND:
        return { code: ErrorCode.FS_PATH_NOT_FOUND, msg: err.message };
      case ErrorCodes.FS_IS_DIRECTORY:
        return { code: ErrorCode.FS_IS_DIRECTORY, msg: err.message };
      case ErrorCodes.FS_IS_BINARY:
        return { code: ErrorCode.FS_IS_BINARY, msg: err.message };
      case ErrorCodes.FS_TOO_LARGE:
        return { code: ErrorCode.FS_TOO_LARGE, msg: err.message };
      case ErrorCodes.FS_TOO_MANY_RESULTS:
        return { code: ErrorCode.FS_TOO_MANY_RESULTS, msg: err.message };
    }
  }
  return {
    code: ErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : 'internal error',
  };
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'application/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/rust',
  '.go': 'text/x-go',
};

function guessMime(relPath: string, isBinary: boolean): string {
  const ext = extname(relPath).toLowerCase();
  const mapped = EXT_TO_MIME[ext];
  if (mapped !== undefined) return mapped;
  return isBinary ? 'application/octet-stream' : 'text/plain';
}

const EXT_TO_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shellscript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

function guessLanguageId(relPath: string): string | undefined {
  return EXT_TO_LANGUAGE[extname(relPath).toLowerCase()];
}

registerScopedService(
  LifecycleScope.Session,
  ISessionFsService,
  SessionFsService,
  InstantiationType.Delayed,
  'agentFs',
);
