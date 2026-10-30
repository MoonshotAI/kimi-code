import {
  type FsDiffRequest,
  type FsDiffResponse,
  type FsEntry,
  type FsGitStatusRequest,
  type FsGitStatusResponse,
  type FsGitStatusBatchRequest,
  type FsGitStatusBatchResponse,
  type FsBatchError,
  type FsPullRequest,
  type FsPullRequestRequest,
  type FsPullRequestBatchRequest,
  type FsPullRequestBatchResponse,
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
  type FsSuggestRequest,
  type FsSuggestResponse,
} from './fs';

const FsWireErrorCode = {
  VALIDATION_FAILED: 40001,
  FS_PATH_NOT_FOUND: 40409,
  ENVIRONMENT_NOT_FOUND: 40420,
  SESSION_BUSY: 40901,
  FS_IS_DIRECTORY: 40906,
  FS_IS_BINARY: 40907,
  ENVIRONMENT_UNAVAILABLE: 40926,
  FS_TOO_LARGE: 41302,
  FS_TOO_MANY_RESULTS: 41303,
  FS_PATH_ESCAPES_SESSION: 41304,
  INTERNAL_ERROR: 50001,
} as const;
import ignore, { type Ignore } from 'ignore';

import { classifyTextSample, decodeUtfText } from '#/_base/text/encoding';
import {
  buildEtag,
  countLines,
  FS_BINARY_SAMPLE_BYTES,
  guessLanguageId,
  guessMime,
} from '#/_base/utils/fileMeta';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { HandshakeError } from '#/remote/client/connection';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostFileSystem, type HostDirEntry, type HostFileStat } from '#/os/interface/hostFileSystem';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';
import {
  HOST_WALK_MAX_DEPTH,
  HOST_WALK_MAX_DIRECTORIES,
  HOST_WALK_MAX_ENTRIES,
  HOST_WALK_MAX_RESPONSE_BYTES,
} from '#/os/interface/hostFsWalk';
import { type EnvironmentPath } from '#/environment/environment';
import { POSIX_ENVIRONMENT_PATH } from '#/environment/environmentDefaults';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IWorkspaceGitService } from '#/workspace/workspaceGit/workspaceGit';

import { type FsDownloadResolved, type FsPathResolved, IWorkspaceFsService } from './fs';
import { readStream, runCommand } from './internal/fsProcess';
import { ensureRgPath, type RgProbe, type RgResolution } from './internal/rgLocator';
import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  evaluateSuggestCandidate,
  globCanMatchBelow,
  matchesAnyGlob,
  type RgJsonRecord,
  rgPath,
  rgText,
  stripTrailingNewline,
  SuggestTopHeap,
  type SuggestCandidate,
  type SuggestQuery,
  VCS_METADATA_DIRS,
} from './internal/fsSearch';

const SEARCH_HARD_CAP = 500;
const LIST_LSTAT_CONCURRENCY = 16;
const LIST_TOTAL_ENTRY_BUDGET = 10_000;
const PROBE_MAX_DEPTH = 6;
const PROBE_MAX_ENTRIES = 500;
const GREP_TIMEOUT_MS = 30_000;
const SUGGEST_TIMEOUT_MS = 10_000;
const WALK_DEFAULT_IGNORE = ['.git/'];

interface SuggestRoot {
  readonly dir: string;
  readonly real: string;
  readonly primary: boolean;
}

const FS_READ_MAX_BYTES = 10 * 1024 * 1024;

const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set(['.DS_Store', '.AppleDouble', '.LSOverride']);

export class WorkspaceFsService implements IWorkspaceFsService {
  declare readonly _serviceBrand: undefined;

  private readonly gitignoreCache = new Map<string, {
    readonly matcher: Ignore;
    readonly walkRules: readonly string[];
  }>();
  private rgResolution: RgResolution | null | undefined = undefined;
  private realRootsCache:
    | { readonly key: string; readonly roots: readonly { dir: string; real: string }[] }
    | undefined = undefined;
  private readonly workDir: string;
  private readonly workspaceId: string;
  private readonly path: EnvironmentPath;

  constructor(
    @IWorkspaceContext workspace: Pick<IWorkspaceContext, 'workspaceId' | 'cwd'>,
    @IWorkspaceDirs private readonly workspaceDirs: Pick<IWorkspaceDirs, 'additionalDirs'>,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IEnvironmentService private readonly resolver: EnvironmentResolver,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWorkspaceGitService private readonly git: IWorkspaceGitService,
    private readonly environmentId = 'local',
  ) {
    this.workspaceId = workspace.workspaceId;
    this.path = resolver.inspect({ environmentId }).path ?? POSIX_ENVIRONMENT_PATH;
    this.workDir = this.path.resolve(workspace.cwd);
  }

  private resolvePathInput(rel: string): string {
    return this.path.isAbsolute(rel) ? this.path.resolve(rel) : this.path.resolve(this.workDir, rel);
  }

  private isWithinWorkspace(absPath: string): boolean {
    const target = this.path.resolve(absPath);
    if (target === this.workDir) return true;
    const rel = this.path.relative(this.workDir, target);
    if (rel !== '' && !rel.startsWith('..') && !this.path.isAbsolute(rel)) return true;
    return this.workspaceDirs.additionalDirs.some((dir) => {
      const r = this.path.relative(this.path.resolve(dir), target);
      return r === '' || (!r.startsWith('..') && !this.path.isAbsolute(r));
    });
  }

  async list(req: FsListRequest): Promise<FsListResponse> {
    const abs = await this.resolveWithin(req.path, req.allow_external_symlinks === true);
    const anchored = this.path.isAbsolute(req.path);
    const base = anchored ? this.anchorRoot(abs) : this.workDir;
    const rel = anchored ? this.toRelFrom(base, abs) : this.toRel(abs);
    const absOf = (relPath: string): string =>
      relPath === '' || relPath === '.' ? base : this.path.join(base, relPath);

    let topStat: HostFileStat;
    try {
      topStat = await this.hostFs.stat(abs);
    } catch (error) {
      throw mapFsError(error, req.path);
    }
    if (!topStat.isDirectory) {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${req.path}`, {
        details: { path: req.path },
      });
    }

    const gitignore = req.follow_gitignore ? await this.matcherFor(base) : undefined;

    const items: FsEntry[] = [];
    const childrenByPath: Record<string, FsEntry[]> = {};
    const probeBudget = { visited: 0 };
    let symlinkEntries = 0;
    let budgetExhausted = false;
    let truncated = false;

    interface QueueEntry {
      readonly relPath: string;
      readonly depthRemaining: number;
      readonly ancestors: readonly string[];
      readonly viaSymlink: boolean;
    }
    const rootRel = rel === '.' ? '' : rel;
    const rootIsSymlink = await this.pathHasSymlink(absOf(rootRel));
    const queue: QueueEntry[] = [
      {
        relPath: rootRel,
        depthRemaining: req.depth,
        ancestors: [await this.realpathExistingPrefix(absOf(rootRel))],
        viaSymlink: rootIsSymlink,
      },
    ];

    interface Child {
      readonly name: string;
      readonly relPath: string;
      readonly stat: HostFileStat;
      readonly isDirectory: boolean;
      readonly realPath?: string;
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (budgetExhausted && entry.viaSymlink) continue;
      let names: readonly string[];
      try {
        names = (await this.hostFs.readdir(absOf(entry.relPath))).map((e) => e.name);
      } catch (error) {
        if (entry.relPath === (rel === '.' ? '' : rel) ||
          (error instanceof Error2 && error.code === ErrorCodes.OS_FS_DIRECTORY_TOO_LARGE)) {
          throw mapFsError(error, req.path);
        }
        continue;
      }

      const candidates: {
        readonly name: string;
        readonly childRel: string;
        readonly ancestorOfAllowed: boolean;
      }[] = [];
      for (const name of names) {
        if (!req.show_hidden && isHidden(name)) continue;
        const childRel = entry.relPath === '' ? name : `${entry.relPath}/${name}`;
        let ancestorOfAllowed = false;
        if (gitignore && (gitignore.ignores(childRel) || gitignore.ignores(`${childRel}/`))) {
          if (req.allow_ignored_globs === undefined) continue;
          if (!matchesAnyGlob(childRel, req.allow_ignored_globs)) {
            if (!globCanMatchBelow(childRel, req.allow_ignored_globs)) continue;
            ancestorOfAllowed = true;
          }
        }
        if (req.exclude_globs && matchesAnyGlob(childRel, req.exclude_globs)) continue;
        candidates.push({ name, childRel, ancestorOfAllowed });
      }
      const stats = await mapWithConcurrency(candidates, LIST_LSTAT_CONCURRENCY, (candidate) =>
        this.hostFs.lstat(absOf(candidate.childRel)).catch(() => undefined),
      );
      const visible: Child[] = [];
      for (const [index, candidate] of candidates.entries()) {
        const st = stats[index];
        if (st === undefined) continue;
        let isDirectory = st.isDirectory;
        let realPath: string | undefined;
        if (st.isSymbolicLink === true) {
          const target = await this.symlinkDirectoryTarget(
            candidate.childRel,
            req.allow_external_symlinks === true,
            absOf,
          );
          isDirectory = target.isDirectory;
          realPath = target.realPath;
        }
        if (candidate.ancestorOfAllowed && !isDirectory) continue;
        if (
          candidate.ancestorOfAllowed &&
          !(await this.hasAllowedDescendant(
            candidate.childRel,
            req.allow_ignored_globs!,
            req.exclude_globs,
            req.show_hidden,
            req.allow_external_symlinks === true,
            probeBudget,
            absOf,
          ))
        ) continue;
        visible.push({
          name: candidate.name,
          relPath: candidate.childRel,
          stat: st,
          isDirectory,
          realPath,
        });
      }

      sortChildren(visible, req.sort);

      const parentKey = entry.relPath === '' ? '.' : entry.relPath;
      const bucket: FsEntry[] = [];
      for (const child of visible) {
        if (items.length >= req.limit && entry.depthRemaining === req.depth) {
          truncated = true;
          break;
        }
        const viaSymlink = entry.viaSymlink;
        if (viaSymlink && symlinkEntries >= LIST_TOTAL_ENTRY_BUDGET) {
          truncated = true;
          budgetExhausted = true;
          break;
        }
        const fsEntry = buildFsEntry(child.relPath, child.name, child.stat, false);
        if (child.stat.isSymbolicLink === true && child.isDirectory) {
          fsEntry.is_directory = true;
        }
        if (entry.depthRemaining === req.depth) {
          items.push(fsEntry);
        }
        bucket.push(fsEntry);
        if (viaSymlink) symlinkEntries += 1;
        if (child.isDirectory && entry.depthRemaining > 1) {
          const realPath =
            child.realPath ??
            (await this.realpathExistingPrefix(absOf(child.relPath)).catch(() => undefined));
          const childViaSymlink = viaSymlink || child.stat.isSymbolicLink === true;
          if (
            realPath !== undefined &&
            !entry.ancestors.includes(realPath) &&
            (!budgetExhausted || !childViaSymlink)
          ) {
            queue.push({
              relPath: child.relPath,
              depthRemaining: entry.depthRemaining - 1,
              ancestors: [...entry.ancestors, realPath],
              viaSymlink: childViaSymlink,
            });
          }
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

  private async pathHasSymlink(absPath: string): Promise<boolean> {
    let current = absPath;
    for (;;) {
      const st = await this.hostFs.lstat(current).catch(() => undefined);
      if (st?.isSymbolicLink === true) return true;
      const parent = this.path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  private async symlinkDirectoryTarget(
    relPath: string,
    allowExternal: boolean,
    absOf: (rel: string) => string,
  ): Promise<{ readonly isDirectory: boolean; readonly realPath?: string }> {
    try {
      const target = await this.hostFs.stat(absOf(relPath));
      if (!target.isDirectory) return { isDirectory: false };
      const realPath = await this.realpathExistingPrefix(absOf(relPath));
      if (!allowExternal) {
        const roots = await this.realRoots();
        if (!roots.some((root) => isInsideOrEqual(this.path, realPath, root))) {
          return { isDirectory: false };
        }
      }
      return { isDirectory: true, realPath };
    } catch {
      return { isDirectory: false };
    }
  }

  private async hasAllowedDescendant(
    relDir: string,
    globs: readonly string[],
    excludeGlobs: readonly string[] | undefined,
    showHidden: boolean,
    allowExternalSymlinks: boolean,
    budget: { visited: number },
    absOf: (rel: string) => string,
  ): Promise<boolean> {
    const walk = async (rel: string, depth: number): Promise<boolean> => {
      if (depth > PROBE_MAX_DEPTH || budget.visited >= PROBE_MAX_ENTRIES) return true;
      let names: readonly string[];
      try {
        names = (await this.hostFs.readdir(absOf(rel))).map((e) => e.name);
      } catch {
        return false;
      }
      const candidates: string[] = [];
      for (const name of names) {
        if (budget.visited >= PROBE_MAX_ENTRIES) return true;
        budget.visited += 1;
        if (!showHidden && isHidden(name)) continue;
        const childRel = `${rel}/${name}`;
        if (excludeGlobs !== undefined && matchesAnyGlob(childRel, excludeGlobs)) continue;
        if (matchesAnyGlob(childRel, globs)) return true;
        candidates.push(childRel);
      }
      const stats = await mapWithConcurrency(candidates, LIST_LSTAT_CONCURRENCY, (childRel) =>
        this.hostFs.lstat(absOf(childRel)).catch(() => undefined),
      );
      for (const [index, childRel] of candidates.entries()) {
        const st = stats[index];
        const isDirectory =
          st?.isSymbolicLink === true
            ? (await this.symlinkDirectoryTarget(childRel, allowExternalSymlinks, absOf)).isDirectory
            : st?.isDirectory === true;
        if (isDirectory && globCanMatchBelow(childRel, globs)) {
          if (await walk(childRel, depth + 1)) return true;
        }
      }
      return false;
    };
    return walk(relDir, 1);
  }

  async read(req: FsReadRequest): Promise<FsReadResponse> {
    const abs = await this.resolveWithin(req.path, req.allow_external_symlinks === true);
    const rel = this.toRel(abs);

    let st: HostFileStat;
    try {
      st = await this.hostFs.stat(abs);
    } catch (error) {
      throw mapFsError(error, req.path);
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
    const rawLength = Math.max(0, Math.min(req.length, st.size - req.offset));
    const readSample = (): Promise<Uint8Array> =>
      sampleSize === 0 ? Promise.resolve(new Uint8Array()) : this.hostFs.readBytes(abs, sampleSize);
    const readWindow = (): Promise<Uint8Array> =>
      rawLength === 0
        ? Promise.resolve(new Uint8Array())
        : this.hostFs.readBytes(abs, rawLength, req.offset);

    let sample: Uint8Array;
    let rawWindow: Uint8Array;
    if (req.offset === 0 && rawLength >= sampleSize) {
      rawWindow = await readWindow();
      sample = rawWindow.subarray(0, sampleSize);
    } else {
      [sample, rawWindow] = await Promise.all([readSample(), readWindow()]);
    }

    const classification = classifyTextSample(sample);
    const transcodeEncoding =
      !classification.isBinary && classification.encoding !== 'utf-8' && req.encoding !== 'base64'
        ? classification.encoding
        : undefined;
    const isBinary =
      classification.isBinary ||
      (classification.encoding !== 'utf-8' && transcodeEncoding === undefined);

    if (isBinary && req.encoding === 'utf-8') {
      throw new Error2(ErrorCodes.FS_IS_BINARY, `file is binary: ${req.path}`, {
        details: { path: req.path },
      });
    }

    let totalLength = st.size;
    let decodedBytes: Uint8Array | undefined;
    if (transcodeEncoding !== undefined) {
      decodedBytes = Buffer.from(
        decodeUtfText(await this.hostFs.readBytes(abs), transcodeEncoding),
        'utf-8',
      );
      totalLength = decodedBytes.length;
    }

    const effectiveLength = Math.min(req.length, totalLength - req.offset);
    let bytes: Uint8Array;
    if (effectiveLength <= 0) {
      bytes = new Uint8Array();
    } else if (decodedBytes !== undefined) {
      bytes = decodedBytes.subarray(req.offset, req.offset + effectiveLength);
    } else {
      bytes = rawWindow.subarray(0, effectiveLength);
    }

    const encoding: 'utf-8' | 'base64' =
      req.encoding === 'base64' || (req.encoding === 'auto' && isBinary) ? 'base64' : 'utf-8';
    const content =
      encoding === 'utf-8'
        ? Buffer.from(bytes).toString('utf-8')
        : Buffer.from(bytes).toString('base64');
    const truncated = req.offset + effectiveLength < totalLength;

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
        } catch (error) {
          if (error instanceof Error2 && error.code === ErrorCodes.FS_PATH_ESCAPES) throw error;
          partialErrors[p] = toWireError(error);
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
    } catch (error) {
      throw mapFsError(error, req.path);
    }
    const name = rel === '.' ? this.path.basename(this.workDir) : this.path.basename(abs);
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
          const name = rel === '.' ? this.path.basename(this.workDir) : this.path.basename(abs);
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
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') {
        throw new Error2(ErrorCodes.FS_ALREADY_EXISTS, `path already exists: ${req.path}`, {
          details: { path: req.path },
        });
      }
      if (isHostFsNotFound(error) || isHostFsNotDirectory(error)) {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `parent not found: ${req.path}`, {
          details: { path: req.path },
        });
      }
      throw error;
    }
    const st = await this.hostFs.lstat(abs);
    return buildFsEntry(rel, this.path.basename(abs), st, false);
  }

  async resolvePath(relPath: string): Promise<FsPathResolved> {
    const abs = await this.resolveWithin(relPath);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.lstat(abs);
    } catch (error) {
      throw mapFsError(error, relPath);
    }
    return { absolute: abs, relative: rel, isDirectory: st.isDirectory };
  }

  async resolveDownload(relPath: string, allowExternalSymlinks = false): Promise<FsDownloadResolved> {
    const abs = await this.resolveWithin(relPath, allowExternalSymlinks);
    const rel = this.toRel(abs);
    let st: HostFileStat;
    try {
      st = await this.hostFs.stat(abs);
    } catch (error) {
      throw mapFsError(error, relPath);
    }
    if (st.isDirectory) {
      throw new Error2(ErrorCodes.FS_IS_DIRECTORY, `path is a directory: ${relPath}`, {
        details: { path: relPath },
      });
    }
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await this.hostFs.readBytes(abs, sampleSize);
    const classification = classifyTextSample(sample);
    const isBinary = classification.isBinary || classification.encoding !== 'utf-8';
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
    const roots = await this.suggestRoots();
    if (req.query === '') {
      const items: FsSearchHit[] = [];
      const seenPaths = new Set<string>();
      let truncated = false;
      for (const root of roots) {
        let listed: FsListResponse;
        try {
          listed = await this.list({
            path: root.dir,
            depth: 1,
            limit: req.limit,
            show_hidden: false,
            follow_gitignore: req.follow_gitignore,
            exclude_globs: req.exclude_globs,
            sort: 'type_first',
            include_git_status: false,
          });
        } catch (error) {
          if (!root.primary && isMissingPathError(error)) continue;
          throw error;
        }
        truncated = truncated || listed.truncated;
        for (const entry of listed.items) {
          if (req.include_globs !== undefined && !matchesAnyGlob(entry.path, req.include_globs)) {
            continue;
          }
          const pathKey = `${root.real}/${entry.path}`;
          if (seenPaths.has(pathKey)) continue;
          seenPaths.add(pathKey);
          items.push({
            path: this.suggestDisplayPath(root, entry.path),
            name: entry.name,
            kind: entry.kind,
            score: 1,
            match_positions: [],
          });
        }
      }
      return {
        items: items.slice(0, req.limit),
        truncated: truncated || items.length > req.limit,
      };
    }

    const candidates: FsSearchHit[] = [];
    const queryLower = req.query.toLowerCase();
    const seenPaths = new Set<string>();
    let inventoryTruncated = false;
    for (const root of roots) {
      const ignoreRules = req.follow_gitignore ? await this.walkIgnoreFor(root.dir) : WALK_DEFAULT_IGNORE;
      inventoryTruncated = await this.walk(root.dir, ignoreRules, async (relPath, name, kind) => {
        const pathKey = `${root.real}/${relPath}`;
        if (seenPaths.has(pathKey)) return;
        seenPaths.add(pathKey);
        const score = computeFuzzyScore(name, queryLower);
        if (score <= 0) return;
        if (req.include_globs && !matchesAnyGlob(relPath, req.include_globs)) {
          return;
        }
        if (req.exclude_globs && matchesAnyGlob(relPath, req.exclude_globs)) {
          return;
        }
        const path = this.suggestDisplayPath(root, relPath);
        candidates.push({
          path,
          name,
          kind,
          score,
          match_positions: computeMatchPositions(path, queryLower),
        });
      }) || inventoryTruncated;
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });

    const effectiveCap = Math.min(req.limit, SEARCH_HARD_CAP);
    const truncated = candidates.length > effectiveCap;
    return { items: candidates.slice(0, effectiveCap), truncated: truncated || inventoryTruncated };
  }

  async suggest(req: FsSuggestRequest): Promise<FsSuggestResponse> {
    const roots = await this.suggestRoots();
    if (req.query === '') {
      return this.suggestTopLevel(req, roots);
    }

    const queryLower = req.query.toLowerCase();
    const pathSegments = queryLower.includes('/')
      ? queryLower.split('/').filter((seg) => seg.length > 0)
      : [];
    if (queryLower.includes('/') && pathSegments.length === 0) {
      return { items: [], truncated: false };
    }
    const query: SuggestQuery = {
      nameQuery: queryLower,
      pathSegments,
      showHidden: req.show_hidden,
      followGitignore: req.follow_gitignore,
      includeGlobs: req.include_globs,
      excludeGlobs: req.exclude_globs,
    };
    const cap = req.limit;

    const deadline = Date.now() + SUGGEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      let resolution: RgResolution | null = null;
      try {
        resolution = await this.resolveRg();
      } catch {
        resolution = null;
      }
      if (resolution !== null) {
        try {
          return await this.suggestWithRg(query, cap, controller.signal, resolution.path, roots);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          this.telemetry.track2('fs_suggest_node_fallback', { reason: 'rg_error' });
          return await this.suggestWithNode(query, cap, controller.signal, roots, deadline);
        }
      }
      this.telemetry.track2('fs_suggest_node_fallback', { reason: 'rg_missing' });
      return await this.suggestWithNode(query, cap, controller.signal, roots, deadline);
    } finally {
      clearTimeout(timer);
    }
  }

  private async suggestRoots(): Promise<readonly SuggestRoot[]> {
    const pairs = await this.realRootPairs();
    const roots: SuggestRoot[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      if (roots.some((root) => isInsideOrEqual(this.path, pair.real, root.real))) continue;
      roots.push({ dir: pair.dir, real: pair.real, primary: i === 0 });
    }
    return roots;
  }

  private suggestRootDirSlashes(root: SuggestRoot): string {
    const sep = this.path.separator;
    return sep === '/' ? root.dir : root.dir.split(sep).join('/');
  }

  private suggestDisplayPath(root: SuggestRoot, rel: string): string {
    if (root.primary) return rel;
    const dir = this.suggestRootDirSlashes(root);
    return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`;
  }

  private displayCandidate(root: SuggestRoot, candidate: SuggestCandidate): SuggestCandidate {
    if (root.primary) return candidate;
    const path = this.suggestDisplayPath(root, candidate.path);
    const offset = path.length - candidate.path.length;
    return {
      ...candidate,
      path,
      positions: candidate.positions.map((position) => position + offset),
    };
  }

  private async suggestTopLevel(
    req: FsSuggestRequest,
    roots: readonly SuggestRoot[],
  ): Promise<FsSuggestResponse> {
    interface TopEntry {
      readonly path: string;
      readonly name: string;
      readonly kind: 'file' | 'directory' | 'symlink';
    }
    const all: TopEntry[] = [];
    let capped = false;
    for (const root of roots) {
      const matcher = req.follow_gitignore ? await this.matcherFor(root.dir) : undefined;
      let entries: readonly HostDirEntry[];
      try {
        entries = await this.hostFs.readdir(root.dir);
      } catch (error) {
        if (!root.primary && isMissingPathError(error)) continue;
        throw mapFsError(error, root.dir);
      }
      const visible: { name: string; kind: TopEntry['kind'] }[] = [];
      for (const entry of entries) {
        const name = entry.name;
        if (!req.show_hidden && isHidden(name)) continue;
        if (matcher !== undefined && (matcher.ignores(name) || matcher.ignores(`${name}/`))) {
          continue;
        }
        if (req.exclude_globs !== undefined && matchesAnyGlob(name, req.exclude_globs)) continue;
        const kind: TopEntry['kind'] = entry.isSymbolicLink === true
          ? 'symlink'
          : entry.isDirectory
            ? 'directory'
            : 'file';
        visible.push({ name, kind });
      }
      visible.sort((a, b) => {
        const ad = a.kind === 'directory' ? 0 : 1;
        const bd = b.kind === 'directory' ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
      if (visible.length > SEARCH_HARD_CAP) {
        visible.length = SEARCH_HARD_CAP;
        capped = true;
      }
      for (const entry of visible) {
        if (VCS_METADATA_DIRS.has(entry.name)) continue;
        if (req.include_globs !== undefined && !matchesAnyGlob(entry.name, req.include_globs)) {
          continue;
        }
        all.push({
          path: this.suggestDisplayPath(root, entry.name),
          name: entry.name,
          kind: entry.kind,
        });
      }
    }
    const items = all.slice(0, req.limit).map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      score: 1,
      match_positions: [],
    }));
    return { items, truncated: capped || all.length > req.limit };
  }

  private async suggestWithRg(
    query: SuggestQuery,
    cap: number,
    signal: AbortSignal,
    rgBinary: string,
    roots: readonly SuggestRoot[],
  ): Promise<FsSuggestResponse> {
    const args = ['--files'];
    if (query.followGitignore) {
      args.push('--no-require-git');
    } else {
      args.push('--no-ignore');
    }
    if (query.showHidden) args.push('--hidden');
    for (const dir of VCS_METADATA_DIRS) args.push('-g', `!${dir}`, '-g', `!${dir}/**`);
    const multi = roots.length > 1;
    if (multi) {
      for (const root of roots) args.push(root.dir);
    }

    const lease = this.resolver.acquire(
      { environmentId: this.environmentId },
      ['process'],
    );
    const proc = await lease.environment.process!.spawn(rgBinary, args, { cwd: this.workDir });

    const top = new SuggestTopHeap(cap);
    const seenDirs = new Set<string>();
    const seenPaths = new Set<string>();
    let matched = 0;
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      void proc.kill('SIGKILL');
    };
    const onAbort = (): void => kill();
    if (signal.aborted) kill();
    else signal.addEventListener('abort', onAbort, { once: true });

    const sep = this.path.separator;
    const rootMatchers = roots.map((root) => {
      const dir = this.suggestRootDirSlashes(root);
      return { root, prefix: dir.endsWith('/') ? dir : `${dir}/` };
    });

    const matchRoot = (line: string): { root: SuggestRoot; rel: string } | undefined => {
      let best: { root: SuggestRoot; prefix: string } | undefined;
      for (const matcher of rootMatchers) {
        if (line.startsWith(matcher.prefix) && (best === undefined || matcher.prefix.length > best.prefix.length)) {
          best = matcher;
        }
      }
      if (best === undefined) return undefined;
      return { root: best.root, rel: line.slice(best.prefix.length) };
    };

    const handleLine = (raw: string): void => {
      let line = raw;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (sep !== '/') line = line.split(sep).join('/');
      if (line.startsWith('./')) line = line.slice(2);
      if (line.length === 0) return;
      let root = roots[0]!;
      let rel = line;
      if (multi) {
        const located = matchRoot(line);
        if (located === undefined) return;
        root = located.root;
        rel = located.rel;
        const pathKey = `${root.real}/${rel}`;
        if (seenPaths.has(pathKey)) return;
        seenPaths.add(pathKey);
      }
      const file = evaluateSuggestCandidate(rel, 'file', query);
      if (file !== null) {
        matched += 1;
        top.push(this.displayCandidate(root, file));
      }
      let slash = rel.lastIndexOf('/');
      while (slash > 0) {
        const dir = rel.slice(0, slash);
        const dirKey = multi ? `${root.real}/${dir}` : dir;
        if (!seenDirs.has(dirKey)) {
          seenDirs.add(dirKey);
          const candidate = evaluateSuggestCandidate(dir, 'directory', query);
          if (candidate !== null) {
            matched += 1;
            top.push(this.displayCandidate(root, candidate));
          }
        }
        slash = rel.lastIndexOf('/', slash - 1);
      }
    };

    let stdoutBuf = '';
    const drainStdout = async (): Promise<void> => {
      proc.stdout.setEncoding('utf-8');
      try {
        for await (const chunk of proc.stdout) {
          stdoutBuf += chunk as string;
          let nl = stdoutBuf.indexOf('\n');
          while (nl >= 0) {
            handleLine(stdoutBuf.slice(0, nl));
            stdoutBuf = stdoutBuf.slice(nl + 1);
            nl = stdoutBuf.indexOf('\n');
          }
        }
        if (stdoutBuf.length > 0) handleLine(stdoutBuf);
      } catch (error) {
        if (!(killed && isPrematureCloseError(error))) throw error;
      }
    };

    let exitCode: number;
    try {
      [, , exitCode] = await Promise.all([
        drainStdout(),
        readStream(proc.stderr),
        proc.wait().catch(() => -1),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        void proc.dispose();
      } catch {
      }
      lease.dispose();
    }

    if (!killed && exitCode !== 0 && exitCode !== 1) {
      throw new Error(`rg --files exited with code ${exitCode}`);
    }

    const items = top.drain().map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      kind: candidate.kind,
      score: candidate.score,
      match_positions: [...candidate.positions],
    }));
    return { items, truncated: matched > cap || signal.aborted };
  }

  private async suggestWithNode(
    query: SuggestQuery,
    cap: number,
    signal: AbortSignal,
    roots: readonly SuggestRoot[],
    deadline: number,
  ): Promise<FsSuggestResponse> {
    const multi = roots.length > 1;
    const top = new SuggestTopHeap(cap);
    const seenPaths = new Set<string>();
    let matched = 0;
    let inventoryTruncated = false;
    for (const root of roots) {
      const ignoreRules = query.followGitignore ? await this.walkIgnoreFor(root.dir) : WALK_DEFAULT_IGNORE;
      inventoryTruncated = await this.walk(root.dir, ignoreRules, async (relPath, _name, kind) => {
        if (multi) {
          const pathKey = `${root.real}/${relPath}`;
          if (seenPaths.has(pathKey)) return;
          seenPaths.add(pathKey);
        }
        const candidate = evaluateSuggestCandidate(relPath, kind, query);
        if (candidate === null) return;
        matched += 1;
        top.push(this.displayCandidate(root, candidate));
      }, { deadlineMs: deadline }) || inventoryTruncated;
      if (signal.aborted || Date.now() >= deadline) break;
    }
    const items = top.drain().map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      kind: candidate.kind,
      score: candidate.score,
      match_positions: [...candidate.positions],
    }));
    return { items, truncated: matched > cap || signal.aborted || inventoryTruncated };
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
    const cwd = await this.resolveGitRoot(req.root);
    let filter: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filter = new Set();
      for (const p of req.paths) {
        const inputPath = req.root !== undefined && !this.path.isAbsolute(p) ? this.path.join(cwd, p) : p;
        const abs = await this.resolveWithin(inputPath);
        const rel = this.path.relative(cwd, abs).split(this.path.separator).join('/');
        if (req.root !== undefined && (rel === '..' || rel.startsWith('../') || this.path.isAbsolute(rel))) {
          throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${p}" escapes git root`, {
            details: { cwd, path: p },
          });
        }
        filter.add(rel);
      }
    }

    return this.git.statusAt(cwd, {
      pathFilter: filter,
      scopeToCwd: req.root !== undefined,
      includePullRequest: req.include_pull_request !== false,
    });
  }

  gitStatusBatch(req: FsGitStatusBatchRequest): Promise<FsGitStatusBatchResponse> {
    return this.batchGitValues(req.roots, (root) => this.gitStatus({ root, include_pull_request: req.include_pull_request }));
  }

  pullRequestBatch(req: FsPullRequestBatchRequest): Promise<FsPullRequestBatchResponse> {
    return this.batchGitValues(req.roots, (root) => this.pullRequest({ root }));
  }

  async pullRequest(req: FsPullRequestRequest): Promise<FsPullRequest | null> {
    const cwd = await this.resolveGitRoot(req.root);
    return this.git.pullRequestAt(cwd);
  }

  private async batchGitValues<T>(
    inputRoots: readonly string[],
    read: (root: string) => Promise<T>,
  ): Promise<{ results: Record<string, T>; errors: Record<string, FsBatchError> }> {
    const roots = [...new Set(inputRoots)];
    const results = Object.create(null) as Record<string, T>;
    const errors = Object.create(null) as Record<string, FsBatchError>;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < roots.length) {
        const root = roots[cursor++]!;
        try {
          results[root] = await read(root);
        } catch (error) {
          errors[root] = toGitBatchError(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, roots.length) }, () => worker()));
    return { results, errors };
  }

  async diff(req: FsDiffRequest): Promise<FsDiffResponse> {
    const cwd = await this.resolveGitRoot(req.root);
    const inputPath = req.root !== undefined && !this.path.isAbsolute(req.path) ? this.path.join(cwd, req.path) : req.path;
    const abs = await this.resolveWithin(inputPath);
    const rel = this.path.relative(cwd, abs).split(this.path.separator).join('/');
    if (req.root !== undefined && (rel === '..' || rel.startsWith('../') || this.path.isAbsolute(rel))) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${req.path}" escapes git root`, {
        details: { cwd, path: req.path },
      });
    }
    return this.git.diffAt(cwd, rel, abs);
  }

  private async resolveGitRoot(root?: string): Promise<string> {
    if (root === undefined) return this.workDir;
    const cwd = root === '/' && this.isWithinWorkspace(root) ? this.path.resolve(root) : await this.resolveWithin(root);
    const stat = await this.hostFs.stat(cwd).catch(() => undefined);
    if (stat?.isDirectory !== true) {
      throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `git root is not a directory: ${root}`, {
        details: { cwd, path: root },
      });
    }
    return cwd;
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
    const roots = await this.suggestRoots();
    args.push('.', ...roots.filter((root) => !root.primary).map((root) => root.dir));

    const lease = this.resolver.acquire({ environmentId: this.environmentId }, ['process']);
    const proc = await lease.environment.process!.spawn(rgPath, args, { cwd: this.workDir });

    const primary = roots.find((root) => root.primary);
    const acc = new RgJsonAccumulator(req, (path) => {
      if (!this.path.isAbsolute(path) || primary === undefined) return path;
      return isInsideOrEqual(this.path, path, primary.dir)
        ? this.toRelFrom(primary.dir, path)
        : path;
    });
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
      lease.dispose();
    }

    return acc.finish(signal.aborted, Date.now() - startedAt);
  }

  private async grepWithNode(
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FsGrepResponse> {
    const re = compileGrepPattern(req);

    const files: FsGrepFileHit[] = [];
    let filesScanned = 0;
    let totalMatches = 0;
    let truncated = false;

    const filePaths: { path: string; absolute: string }[] = [];
    const seenPaths = new Set<string>();
    const roots = await this.suggestRoots();
    const deadline = startedAt + GREP_TIMEOUT_MS;
    for (const root of roots) {
      const ignoreRules = req.follow_gitignore ? await this.walkIgnoreFor(root.dir) : WALK_DEFAULT_IGNORE;
      truncated = await this.walk(root.dir, ignoreRules, async (rel, _name, kind) => {
        if (kind !== 'file') return;
        if (req.include_globs && !matchesAnyGlob(rel, req.include_globs)) return;
        if (req.exclude_globs && matchesAnyGlob(rel, req.exclude_globs)) return;
        const pathKey = `${root.real}/${rel}`;
        if (seenPaths.has(pathKey)) return;
        seenPaths.add(pathKey);
        filePaths.push({
          path: this.suggestDisplayPath(root, rel),
          absolute: this.path.join(root.dir, rel),
        });
      }, { deadlineMs: deadline }) || truncated;
      if (signal.aborted || Date.now() >= deadline) break;
    }

    if ((signal.aborted || Date.now() >= deadline) && filesScanned === 0 && filePaths.length === 0) {
      throw new Error2(ErrorCodes.FS_GREP_TIMEOUT, `grep timed out after ${Date.now() - startedAt}ms`);
    }

    for (const file of filePaths) {
      if ((signal.aborted || Date.now() >= deadline) && filesScanned > 0) {
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
        content = await this.hostFs.readText(file.absolute);
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
        files.push({ path: file.path, matches });
      }
      if (totalMatches >= req.max_total_matches) break;
    }

    return { files, files_scanned: filesScanned, truncated, elapsed_ms: Date.now() - startedAt };
  }

  private async walk(
    baseAbs: string,
    ignoreRules: readonly string[] | undefined,
    visit: (
      relPath: string,
      name: string,
      kind: 'file' | 'directory' | 'symlink',
    ) => Promise<void>,
    options: { deadlineMs?: number } = {},
  ): Promise<boolean> {
    const result = await this.hostFs.walk(baseAbs, {
      maxDepth: HOST_WALK_MAX_DEPTH,
      maxDirectories: HOST_WALK_MAX_DIRECTORIES,
      maxEntries: HOST_WALK_MAX_ENTRIES,
      maxResponseBytes: HOST_WALK_MAX_RESPONSE_BYTES,
      ignore: ignoreRules,
      deadlineMs: options.deadlineMs,
    });
    for (const { path, error } of result.errors) {
      if (error instanceof Error2 && error.code === ErrorCodes.OS_FS_DIRECTORY_TOO_LARGE) {
        throw mapFsError(error, path);
      }
    }
    const byParent = new Map<string, { entry: HostDirEntry; relPath: string }[]>();
    for (const entry of result.entries) {
      const relPath = this.path.relative(baseAbs, entry.name).split(this.path.separator).join('/');
      if (relPath === '' || relPath === '..' || relPath.startsWith('../')) continue;
      const slash = relPath.lastIndexOf('/');
      const parent = slash < 0 ? '' : relPath.slice(0, slash);
      const name = slash < 0 ? relPath : relPath.slice(slash + 1);
      const siblings = byParent.get(parent) ?? [];
      siblings.push({ entry: { ...entry, name }, relPath });
      byParent.set(parent, siblings);
    }
    const visitDirectory = async (parent: string): Promise<void> => {
      for (const { entry, relPath } of byParent.get(parent) ?? []) {
        const { name } = entry;
        if (name === '.git') continue;
        const isDir = entry.isDirectory && entry.isSymbolicLink !== true;
        const kind: 'file' | 'directory' | 'symlink' = entry.isSymbolicLink
          ? 'symlink'
          : isDir
            ? 'directory'
            : 'file';
        await visit(relPath, name, kind);
        if (isDir) await visitDirectory(relPath);
      }
    };
    await visitDirectory('');
    return result.truncated;
  }

  private async matcherFor(rootDir: string): Promise<Ignore | undefined> {
    return (await this.ignoreFor(rootDir)).matcher;
  }

  private async walkIgnoreFor(rootDir: string): Promise<readonly string[]> {
    return (await this.ignoreFor(rootDir)).walkRules;
  }

  private async ignoreFor(rootDir: string): Promise<{
    readonly matcher: Ignore;
    readonly walkRules: readonly string[];
  }> {
    const cached = this.gitignoreCache.get(rootDir);
    if (cached !== undefined) return cached;
    const ig = ignore();
    ig.add('.git/');
    let contents = '';
    try {
      contents = await this.hostFs.readText(this.path.join(rootDir, '.gitignore'));
      ig.add(contents);
    } catch {
    }
    const rules = ['.git/', ...contents.split(/\r?\n/)];
    const result = { matcher: ig, walkRules: rules };
    this.gitignoreCache.set(rootDir, result);
    return result;
  }

  private async resolveRg(): Promise<RgResolution | null> {
    if (this.rgResolution !== undefined) return this.rgResolution;
    const lease = this.resolver.acquire({ environmentId: this.environmentId }, ['process']);
    const probe: RgProbe = {
      exec: (args) => runCommand(lease.environment.process!, args, { cwd: this.workDir }),
    };
    try {
      this.rgResolution = await ensureRgPath(probe, {
        allowCachedFallback: true,
        environment: lease.environment,
      });
    } catch {
      this.rgResolution = null;
    } finally {
      lease.dispose();
    }
    return this.rgResolution;
  }

  private async realRootPairs(): Promise<readonly { dir: string; real: string }[]> {
    const dirs = [this.workDir, ...this.workspaceDirs.additionalDirs.map((d) => this.path.resolve(d))];
    const key = dirs.join('\n');
    if (this.realRootsCache?.key === key) return this.realRootsCache.roots;
    const roots: { dir: string; real: string }[] = [];
    for (const dir of dirs) {
      try {
        roots.push({ dir, real: await this.hostFs.realpath(dir) });
      } catch {
        roots.push({ dir, real: dir });
      }
    }
    this.realRootsCache = { key, roots };
    return roots;
  }

  private async realRoots(): Promise<readonly string[]> {
    return (await this.realRootPairs()).map((pair) => pair.real);
  }

  private async realpathExistingPrefix(abs: string): Promise<string> {
    const tail: string[] = [];
    let current = abs;
    for (let i = 0; i < 256; i++) {
      try {
        const real = await this.hostFs.realpath(current);
        return tail.length === 0 ? real : this.path.join(real, ...tail.toReversed());
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const parent = this.path.dirname(current);
        if (parent === current) return abs;
        tail.push(this.path.basename(current));
        current = parent;
      }
    }
    return abs;
  }

  private async resolveWithin(inputPath: string, allowExternalSymlinks = false): Promise<string> {
    if (inputPath === '' || inputPath === '/') {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (empty)`, {
        details: { path: inputPath, reason: 'empty' },
      });
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" rejected (dotdot segment)`, {
        details: { path: inputPath, reason: 'dotdot_segment' },
      });
    }
    const abs = this.resolvePathInput(inputPath);
    if (!this.isWithinWorkspace(abs)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `path "${inputPath}" escapes workspace`, {
        details: { path: inputPath, reason: 'resolved_outside' },
      });
    }
    if (!allowExternalSymlinks) {
      const resolved = await this.realpathExistingPrefix(abs);
      const roots = await this.realRoots();
      if (!roots.some((root) => isInsideOrEqual(this.path, resolved, root))) {
        throw new Error2(
          ErrorCodes.FS_PATH_ESCAPES,
          `path "${inputPath}" escapes workspace through a symlink`,
          { details: { path: inputPath, reason: 'symlink_outside' } },
        );
      }
    }
    return abs;
  }

  private toRel(abs: string): string {
    const cwd = this.workDir;
    if (abs === cwd) return '.';
    const rel = this.path.relative(cwd, abs);
    if (rel === '') return '.';
    return rel.split(this.path.separator).join('/');
  }

  private anchorRoot(abs: string): string {
    const dirs = [this.workDir, ...this.workspaceDirs.additionalDirs.map((d) => this.path.resolve(d))];
    let best: string | undefined;
    for (const dir of dirs) {
      if (!isInsideOrEqual(this.path, abs, dir)) continue;
      if (best === undefined || dir.length > best.length) best = dir;
    }
    return best ?? this.workDir;
  }

  private toRelFrom(base: string, abs: string): string {
    if (abs === base) return '.';
    const rel = this.path.relative(base, abs);
    if (rel === '') return '.';
    return rel.split(this.path.separator).join('/');
  }
}

class RgJsonAccumulator {
  private readonly fileBuf = new Map<
    string,
    { matches: FsGrepMatch[]; pending: string[]; lastMatchLine: number }
  >();
  private readonly files: FsGrepFileHit[] = [];
  private readonly seenPaths = new Set<string>();
  private totalMatches = 0;
  private filesScanned = 0;
  private truncated = false;

  constructor(
    private readonly req: FsGrepRequest,
    private readonly normalizePath: (path: string) => string = (path) => path,
  ) {}

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
      const p = this.pathOf(rec);
      if (p === undefined) return;
      if (this.seenPaths.has(p)) {
        this.finalize(p);
        return;
      }
      if (this.filesScanned >= this.req.max_files) {
        this.truncated = true;
        return;
      }
      this.seenPaths.add(p);
      this.fileBuf.set(p, { matches: [], pending: [], lastMatchLine: -1 });
      this.filesScanned += 1;
    } else if (t === 'context') {
      const p = this.pathOf(rec);
      if (p === undefined) return;
      const buf = this.fileBuf.get(p);
      if (buf === undefined) return;
      buf.pending.push(stripTrailingNewline(rgText(rec.data?.lines)));
      if (buf.pending.length > this.req.context_lines * 2) {
        buf.pending.shift();
      }
    } else if (t === 'match') {
      const p = this.pathOf(rec);
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
      const p = this.pathOf(rec);
      if (p === undefined) return;
      this.finalize(p);
    }
  }

  private pathOf(rec: RgJsonRecord): string | undefined {
    const path = rgPath(rec.data?.path);
    return path === undefined ? undefined : this.normalizePath(path);
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
      const last = buf.matches.at(-1)!;
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function sortChildren(
  children: { name: string; isDirectory: boolean }[],
  sort: FsListRequest['sort'],
): void {
  const cmp = {
    type_first: (a: { name: string; isDirectory: boolean }, b: { name: string; isDirectory: boolean }) => {
      const ad = a.isDirectory ? 0 : 1;
      const bd = b.isDirectory ? 0 : 1;
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
  return isHostFsNotFound(err) || isHostFsNotDirectory(err);
}

function isInsideOrEqual(path: EnvironmentPath, child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function mapFsError(err: unknown, inputPath: string): Error {
  if (err instanceof Error2 && err.code === ErrorCodes.OS_FS_DIRECTORY_TOO_LARGE) {
    return new Error2(ErrorCodes.FS_TOO_MANY_RESULTS, err.message, { details: err.details, cause: err });
  }
  if (isHostFsNotFound(err) || isHostFsNotDirectory(err)) {
    return new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${inputPath}`, {
      details: { path: inputPath },
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

function toGitBatchError(err: unknown): FsBatchError {
  if (err instanceof EnvironmentError) {
    switch (err.code) {
      case 'environment.not_found':
        return { code: FsWireErrorCode.ENVIRONMENT_NOT_FOUND, msg: err.message };
      case 'environment.invalid_cwd':
        return { code: FsWireErrorCode.VALIDATION_FAILED, msg: err.message };
      case 'environment.conflict':
        return { code: FsWireErrorCode.SESSION_BUSY, msg: err.message };
      case 'environment.unavailable':
      case 'environment.capability_unavailable':
        return { code: FsWireErrorCode.ENVIRONMENT_UNAVAILABLE, msg: err.message };
    }
  }
  if (err instanceof HandshakeError) {
    return { code: FsWireErrorCode.ENVIRONMENT_UNAVAILABLE, msg: err.message };
  }
  if (err instanceof Error2) {
    if (err.code === ErrorCodes.FS_GIT_UNAVAILABLE) return { code: 40908, msg: err.message };
    if (err.code === ErrorCodes.FS_PATH_ESCAPES) {
      return { code: FsWireErrorCode.FS_PATH_ESCAPES_SESSION, msg: err.message };
    }
  }
  return toWireError(err);
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
