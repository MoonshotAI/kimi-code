/**
 * `sessionFs` domain (L2) — `ISessionFsService` implementation.
 *
 * Backs the fs REST surface (search / grep / git status / git diff) by
 * orchestrating the os `IHostFileSystem` (file IO, resolved against the
 * workspace root), `ISessionProcessRunner` (`rg`), and `IGitService` (git
 * root and execution environment come from the scope, so no `sessionId` is
 * threaded through. Git operations are delegated to the App-scoped
 * `IGitService`; this service only confines paths and computes repo-relative
 * paths before calling it.
 *
 * Path confinement applies the lexical `ISessionWorkspaceContext.isWithin`
 * check first, then re-verifies the candidate through `IHostFileSystem.realpath`
 * (resolving the longest existing prefix, so not-yet-created paths still work):
 * a symlink inside the workspace must not steer fs actions to files outside it.
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
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
  type FsReadRequest,
  type FsReadResponse,
  type FsSearchHit,
  type FsSearchRequest,
  type FsSearchResponse,
  type FsStatManyRequest,
  type FsStatManyResponse,
  type FsStatRequest,
  type FsStatResponse,
} from './fs';

/**
 * The v1 numeric wire codes this edge surface throws inside its
 * `{ code, msg }` wire errors (`toWireError`). Mirrors the envelope error
 * table owned by the transport (kap-server); kept as local literals because
 * they are part of this service's v1 edge contract.
 */
const FsWireErrorCode = {
  FS_PATH_NOT_FOUND: 40409,
  FS_IS_DIRECTORY: 40906,
  FS_IS_BINARY: 40907,
  FS_TOO_LARGE: 41302,
  FS_TOO_MANY_RESULTS: 41303,
  INTERNAL_ERROR: 50001,
} as const;
import ignore, { type Ignore } from 'ignore';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  buildEtag,
  countLines,
  detectBinary,
  FS_BINARY_SAMPLE_BYTES,
  guessLanguageId,
  guessMime,
} from '#/_base/utils/fileMeta';
import { ErrorCodes, Error2, isError2, unwrapErrorCause } from '#/errors';
import { IGitService } from '#/app/git/git';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostFileSystem, type HostDirEntry, type HostFileStat } from '#/os/interface/hostFileSystem';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { type FsDownloadResolved, type FsPathResolved, ISessionFsService } from './fs';
import { readStream, runCommand } from './fsProcess';
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

const FS_READ_MAX_BYTES = 10 * 1024 * 1024;

const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set(['.DS_Store', '.AppleDouble', '.LSOverride']);

export class SessionFsService implements ISessionFsService {
  declare readonly _serviceBrand: undefined;

  private readonly gitignoreCache = new Map<string, Ignore>();
  private rgResolution: RgResolution | null | undefined = undefined;

  constructor(
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionProcessRunner private readonly runner: ISessionProcessRunner,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IGitService private readonly git: IGitService,
  ) {}

  private absOf(rel: string): string {
    return rel === '' || rel === '.' ? this.workspace.workDir : join(this.workspace.workDir, rel);
  }

  async list(req: FsListRequest): Promise<FsListResponse> {
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);

    let topStat: HostFileStat;
    try {
      topStat = await this.hostFs.stat(abs);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    if (!topStat.isDirectory) {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${req.path}`, {
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
      readonly stat: HostFileStat;
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      let names: readonly string[];
      try {
        names = (await this.hostFs.readdir(this.absOf(entry.relPath))).map((e) => e.name);
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
        const st = await this.hostFs.lstat(this.absOf(childRel)).catch(() => undefined);
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
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);

    let st: HostFileStat;
    try {
      st = await this.hostFs.stat(abs);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    if (st.isDirectory) {
      throw new Error2(ErrorCodes.FS_IS_DIRECTORY, `path is a directory: ${req.path}`, {
        details: { path: req.path },
      });
    }
    if (st.size > FS_READ_MAX_BYTES) {
      throw new Error2(
        ErrorCodes.FS_TOO_LARGE,
        `file too large: ${req.path} (${st.size} bytes > ${FS_READ_MAX_BYTES})`,
        { details: { path: req.path, size: st.size } },
      );
    }

    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await this.hostFs.readBytes(abs, sampleSize);
    const isBinary = detectBinary(sample);

    if (isBinary && req.encoding === 'utf-8') {
      throw new Error2(ErrorCodes.FS_IS_BINARY, `file is binary: ${req.path}`, {
        details: { path: req.path },
      });
    }

    const effectiveLength = Math.min(req.length, st.size - req.offset);
    let bytes: Uint8Array;
    if (effectiveLength <= 0) {
      bytes = new Uint8Array();
    } else {
      const window = await this.hostFs.readBytes(abs, req.offset + effectiveLength);
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
          if (err instanceof Error2 && err.code === ErrorCodes.FS_PATH_ESCAPES) throw err;
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
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.lstat(abs);
    } catch (err) {
      throw mapFsError(err, req.path);
    }
    const name = rel === '.' ? basename(this.workspace.workDir) : basename(abs);
    return buildFsEntry(rel, name, st, true);
  }

  async statMany(req: FsStatManyRequest): Promise<FsStatManyResponse> {
    const resolved = await Promise.all(
      req.paths.map(async (p) => {
        const abs = await this.resolveWithin(p);
        return { raw: p, rel: this.toRel(abs), abs };
      }),
    );

    const entries: Record<string, FsEntry | null> = {};
    await Promise.all(
      resolved.map(async ({ raw, rel, abs }) => {
        try {
          const st = await this.hostFs.lstat(abs);
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
    const abs = await this.resolveWithin(req.path);
    const rel = this.toRel(abs);
    try {
      await this.hostFs.mkdir(abs, { recursive: req.recursive });
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EEXIST') {
        throw new Error2(ErrorCodes.FS_ALREADY_EXISTS, `path already exists: ${req.path}`, {
          details: { path: req.path },
        });
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `parent not found: ${req.path}`, {
          details: { path: req.path },
        });
      }
      throw err;
    }
    const st = await this.hostFs.lstat(abs);
    return buildFsEntry(rel, basename(abs), st, false);
  }

  async resolvePath(relPath: string): Promise<FsPathResolved> {
    const abs = await this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.lstat(abs);
    } catch (err) {
      throw mapFsError(err, relPath);
    }
    return { absolute: abs, relative: rel, isDirectory: st.isDirectory };
  }

  async resolveDownload(relPath: string): Promise<FsDownloadResolved> {
    const abs = await this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.stat(abs);
    } catch (err) {
      throw mapFsError(err, relPath);
    }
    if (st.isDirectory) {
      throw new Error2(ErrorCodes.FS_IS_DIRECTORY, `path is a directory: ${relPath}`, {
        details: { path: relPath },
      });
    }
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await this.hostFs.readBytes(abs, sampleSize);
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
      this.telemetry.track2('fs_grep_node_fallback', { reason: 'rg_missing' });
      return await this.grepWithNode(req, controller.signal, startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse> {
    const cwd = this.workspace.workDir;

    let filter: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filter = new Set();
      for (const p of req.paths) {
        filter.add(this.toRel(await this.resolveWithin(p)));
      }
    }

    return this.git.status(cwd, filter);
  }

  async diff(req: FsDiffRequest): Promise<FsDiffResponse> {
    const cwd = this.workspace.workDir;
    const abs = await this.resolveWithin(req.path);
    return this.git.diff(cwd, this.toRel(abs), abs);
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

    const proc = await this.runner.exec([rgPath, ...args], { cwd: this.workspace.workDir });

    const acc = new RgJsonAccumulator(req);
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      void proc.kill('SIGKILL');
    };
    const onAbort = (): void => kill();
    if (signal.aborted) kill();
    else signal.addEventListener('abort', onAbort, { once: true });

    let stdoutBuf = '';
    const drainStdout = async (): Promise<void> => {
      proc.stdout.setEncoding('utf-8');
      try {
        for await (const chunk of proc.stdout) {
          stdoutBuf += chunk as string;
          let nl = stdoutBuf.indexOf('\n');
          while (nl >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (line.length > 0) {
              acc.feed(line);
              if (acc.capped) kill();
            }
            nl = stdoutBuf.indexOf('\n');
          }
        }
        if (stdoutBuf.length > 0) acc.feed(stdoutBuf);
      } catch (error) {
        if (!(killed && isPrematureCloseError(error))) throw error;
      }
    };

    try {
      await Promise.all([drainStdout(), readStream(proc.stderr), proc.wait().catch(() => -1)]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        void proc.dispose();
      } catch {
      }
    }

    return acc.finish(signal.aborted, Date.now() - startedAt);
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
          throw new Error2(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${Date.now() - startedAt}ms`);
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
        content = await this.hostFs.readText(this.absOf(rel));
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
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(this.absOf(rootRel));
    } catch {
      return;
    }
    for (const entry of entries) {
      const { name } = entry;
      if (name === '.git') continue;
      const childRel = rootRel === '' ? name : `${rootRel}/${name}`;
      const isDir = entry.isDirectory && entry.isSymbolicLink !== true;
      if (matcher) {
        const probe = isDir ? `${childRel}/` : childRel;
        if (matcher.ignores(probe)) continue;
      }
      const kind: 'file' | 'directory' | 'symlink' = entry.isSymbolicLink
        ? 'symlink'
        : isDir
          ? 'directory'
          : 'file';
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
      const contents = await this.hostFs.readText(join(this.workspace.workDir, '.gitignore'));
      ig.add(contents);
    } catch {
    }
    this.gitignoreCache.set(cwd, ig);
    return ig;
  }

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

  private realRootsCache: { readonly key: string; readonly roots: readonly string[] } | undefined;

  private async realRoots(): Promise<readonly string[]> {
    const dirs = [this.workspace.workDir, ...this.workspace.additionalDirs];
    const key = dirs.join('\n');
    if (this.realRootsCache?.key === key) return this.realRootsCache.roots;
    const roots: string[] = [];
    for (const dir of dirs) {
      try {
        roots.push(await this.hostFs.realpath(dir));
      } catch {
        roots.push(dir);
      }
    }
    this.realRootsCache = { key, roots };
    return roots;
  }

  private async realpathExistingPrefix(abs: string): Promise<string> {
    const tail: string[] = [];
    let current = abs;
    for (let i = 0; i < 256; i++) {
      try {
        const real = await this.hostFs.realpath(current);
        return tail.length === 0 ? real : join(real, ...tail.reverse());
      } catch (err) {
        if (!isMissingPathError(err)) throw err;
        const parent = dirname(current);
        if (parent === current) return abs;
        tail.push(basename(current));
        current = parent;
      }
    }
    return abs;
  }

  private async resolveWithin(inputPath: string): Promise<string> {
    if (inputPath === '' || inputPath === '/') {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (empty)`, {
        details: { path: inputPath, reason: 'empty' },
      });
    }
    if (isAbsolute(inputPath)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (absolute)`, {
        details: { path: inputPath, reason: 'absolute' },
      });
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (dotdot segment)`, {
        details: { path: inputPath, reason: 'dotdot_segment' },
      });
    }
    const abs = this.workspace.resolve(inputPath);
    if (!this.workspace.isWithin(abs)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" escapes workspace`, {
        details: { path: inputPath, reason: 'resolved_outside' },
      });
    }
    const resolved = await this.realpathExistingPrefix(abs);
    const roots = await this.realRoots();
    if (!roots.some((root) => isInsideOrEqual(resolved, root))) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `path "${inputPath}" escapes workspace through a symlink`,
        { details: { path: inputPath, reason: 'symlink_outside' } },
      );
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
}

class RgJsonAccumulator {
  private readonly fileBuf = new Map<
    string,
    { matches: FsGrepMatch[]; pending: string[]; lastMatchLine: number }
  >();
  private readonly files: FsGrepFileHit[] = [];
  private totalMatches = 0;
  private filesScanned = 0;
  private truncated = false;

  constructor(private readonly req: FsGrepRequest) {}

  get capped(): boolean {
    return (
      this.totalMatches >= this.req.max_total_matches || this.filesScanned >= this.req.max_files
    );
  }

  feed(line: string): void {
    let rec: RgJsonRecord;
    try {
      rec = JSON.parse(line) as RgJsonRecord;
    } catch {
      return;
    }
    const t = rec.type;
    if (t === 'begin') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      if (this.filesScanned >= this.req.max_files) {
        this.truncated = true;
        return;
      }
      this.fileBuf.set(p, { matches: [], pending: [], lastMatchLine: -1 });
      this.filesScanned += 1;
    } else if (t === 'context') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      const buf = this.fileBuf.get(p);
      if (buf === undefined) return;
      buf.pending.push(stripTrailingNewline(rgText(rec.data?.lines)));
      if (buf.pending.length > this.req.context_lines * 2) {
        buf.pending.shift();
      }
    } else if (t === 'match') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      const buf = this.fileBuf.get(p);
      if (buf === undefined) return;
      if (this.totalMatches >= this.req.max_total_matches) {
        this.truncated = true;
        return;
      }
      if (buf.matches.length >= this.req.max_matches_per_file) return;
      const text = stripTrailingNewline(rgText(rec.data?.lines));
      const lineNo = rec.data?.line_number ?? 0;
      const col = (rec.data?.submatches?.[0]?.start ?? 0) + 1;
      const before = buf.pending.slice(-this.req.context_lines);
      buf.pending.length = 0;
      buf.matches.push({ line: lineNo, col, text, before, after: [] });
      buf.lastMatchLine = lineNo;
      this.totalMatches += 1;
      if (this.totalMatches >= this.req.max_total_matches) this.truncated = true;
    } else if (t === 'end') {
      const p = rgPath(rec.data?.path);
      if (p === undefined) return;
      this.finalize(p);
    }
  }

  finish(aborted: boolean, elapsedMs: number): FsGrepResponse {
    for (const p of this.fileBuf.keys()) {
      this.finalize(p);
    }
    let truncated = this.truncated;
    if (aborted) {
      if (this.totalMatches === 0 && this.filesScanned === 0) {
        throw new Error2(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${elapsedMs}ms`);
      }
      truncated = true;
    }
    return {
      files: this.files,
      files_scanned: this.filesScanned,
      truncated,
      elapsed_ms: elapsedMs,
    };
  }

  private finalize(p: string): void {
    const buf = this.fileBuf.get(p);
    if (buf === undefined) return;
    if (buf.matches.length > 0 && buf.pending.length > 0) {
      const last = buf.matches[buf.matches.length - 1]!;
      last.after = buf.pending.slice(0, this.req.context_lines);
    }
    if (buf.matches.length > 0) {
      this.files.push({ path: p, matches: buf.matches });
    }
    this.fileBuf.delete(p);
  }
}


function isHidden(name: string): boolean {
  return HIDDEN_NAME_RE.test(name) || MACOS_NOISE.has(name);
}

function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

function sortChildren(
  children: { name: string; stat: HostFileStat }[],
  sort: FsListRequest['sort'],
): void {
  const cmp = {
    type_first: (a: { name: string; stat: HostFileStat }, b: { name: string; stat: HostFileStat }) => {
      const ad = a.stat.isDirectory ? 0 : 1;
      const bd = b.stat.isDirectory ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    },
    name_asc: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
    name_desc: (a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name),
    mtime_desc: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
    size_desc: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
  }[sort];
  children.sort(cmp);
}

function buildFsEntry(
  relPath: string,
  name: string,
  st: HostFileStat,
  withMime: boolean,
): FsEntry {
  const kind: FsEntry['kind'] = st.isSymbolicLink
    ? 'symlink'
    : st.isDirectory
      ? 'directory'
      : 'file';
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

function errnoCode(err: unknown): string | undefined {
  const unwrapped = unwrapErrorCause(err);
  if (typeof unwrapped === 'object' && unwrapped !== null && 'code' in unwrapped) {
    const c = (unwrapped as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function isMissingPathError(err: unknown): boolean {
  if (isError2(err)) {
    return (
      err.code === ErrorCodes.OS_FS_NOT_FOUND || err.code === ErrorCodes.OS_FS_NOT_DIRECTORY
    );
  }
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function mapFsError(err: unknown, inputPath: string): Error {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${inputPath}`, {
      details: { path: inputPath },
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

function toWireError(err: unknown): { code: number; msg: string } {
  if (err instanceof Error2) {
    switch (err.code) {
      case ErrorCodes.FS_PATH_NOT_FOUND:
        return { code: FsWireErrorCode.FS_PATH_NOT_FOUND, msg: err.message };
      case ErrorCodes.FS_IS_DIRECTORY:
        return { code: FsWireErrorCode.FS_IS_DIRECTORY, msg: err.message };
      case ErrorCodes.FS_IS_BINARY:
        return { code: FsWireErrorCode.FS_IS_BINARY, msg: err.message };
      case ErrorCodes.FS_TOO_LARGE:
        return { code: FsWireErrorCode.FS_TOO_LARGE, msg: err.message };
      case ErrorCodes.FS_TOO_MANY_RESULTS:
        return { code: FsWireErrorCode.FS_TOO_MANY_RESULTS, msg: err.message };
    }
  }
  return {
    code: FsWireErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : 'internal error',
  };
}

registerScopedService(
  LifecycleScope.Session,
  ISessionFsService,
  SessionFsService,
  InstantiationType.Eager,
  'sessionFs',
);
