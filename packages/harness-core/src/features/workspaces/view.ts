import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

import type { HostDirEntry, HostFileStat, OsFsPort } from '#/features/os/host/index';

import { mapHostFsError, missingPathError, WorkspaceFsError } from './errors';
import {
  buildEtag,
  classifyTextSample,
  countLines,
  decodeUtfText,
  FS_BINARY_SAMPLE_BYTES,
  guessLanguageId,
  guessMime,
} from './fileMeta';
import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  evaluateSuggestCandidate,
  matchesAnyGlob,
  SuggestTopHeap,
  VCS_METADATA_DIRS,
  type SuggestCandidate,
  type SuggestQuery,
} from './fsSearch';
import type { WorkspaceGitPort } from './git';
import { createGitignore, type GitignoreMatcher } from './gitignore';
import type {
  FsDiffRequest,
  FsDiffResponse,
  FsDownloadResolved,
  FsEntry,
  FsGitStatusRequest,
  FsGitStatusResponse,
  FsGrepFileHit,
  FsGrepMatch,
  FsGrepRequest,
  FsGrepResponse,
  FsListManyRequest,
  FsListManyResponse,
  FsListRequest,
  FsListResponse,
  FsMkdirRequest,
  FsMkdirResponse,
  FsPathResolved,
  FsReadRequest,
  FsReadResponse,
  FsSearchHit,
  FsSearchRequest,
  FsSearchResponse,
  FsStatManyRequest,
  FsStatManyResponse,
  FsStatRequest,
  FsStatResponse,
  FsSuggestRequest,
  FsSuggestResponse,
} from './wire';

const SEARCH_HARD_CAP = 500;
const GREP_TIMEOUT_MS = 30_000;
const SUGGEST_TIMEOUT_MS = 10_000;
const SUGGEST_WALK_ABORTED = new Error('suggest walk aborted');
const WALK_MAX_DEPTH = 64;
const FS_READ_MAX_BYTES = 10 * 1024 * 1024;
const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set(['.DS_Store', '.AppleDouble', '.LSOverride']);

const FS_WIRE_ERROR_CODE = {
  FS_PATH_NOT_FOUND: 40409,
  FS_IS_DIRECTORY: 40906,
  FS_IS_BINARY: 40907,
  FS_TOO_LARGE: 41302,
  FS_TOO_MANY_RESULTS: 41303,
  INTERNAL_ERROR: 50001,
} as const;

export interface WorkspaceFsRoots {
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface WorkspaceFsView {
  list(req: FsListRequest): Promise<FsListResponse>;
  read(req: FsReadRequest): Promise<FsReadResponse>;
  listMany(req: FsListManyRequest): Promise<FsListManyResponse>;
  stat(req: FsStatRequest): Promise<FsStatResponse>;
  statMany(req: FsStatManyRequest): Promise<FsStatManyResponse>;
  mkdir(req: FsMkdirRequest): Promise<FsMkdirResponse>;
  search(req: FsSearchRequest): Promise<FsSearchResponse>;
  suggest(req: FsSuggestRequest): Promise<FsSuggestResponse>;
  grep(req: FsGrepRequest): Promise<FsGrepResponse>;
  gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse>;
  diff(req: FsDiffRequest): Promise<FsDiffResponse>;
  resolvePath(relPath: string): Promise<FsPathResolved>;
  resolveDownload(relPath: string): Promise<FsDownloadResolved>;
}

interface SuggestRoot {
  readonly dir: string;
  readonly real: string;
  readonly primary: boolean;
}

export function createWorkspaceFsView(
  fs: OsFsPort,
  roots: WorkspaceFsRoots,
  git?: WorkspaceGitPort,
): WorkspaceFsView {
  const workDir = resolve(roots.workDir);
  const additionalDirs = (roots.additionalDirs ?? []).map((dir) => resolve(dir));
  const gitignoreCache = new Map<string, GitignoreMatcher>();
  let realRootsCache:
    | { readonly key: string; readonly roots: readonly { dir: string; real: string }[] }
    | undefined;

  const resolvePathInput = (rel: string): string =>
    isAbsolute(rel) ? resolve(rel) : resolve(workDir, rel);

  const isWithinWorkspace = (absPath: string): boolean => {
    const target = resolve(absPath);
    if (target === workDir) return true;
    const rel = relative(workDir, target);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
    return additionalDirs.some((dir) => {
      const r = relative(dir, target);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    });
  };

  const absOf = (rel: string): string => (rel === '' || rel === '.' ? workDir : join(workDir, rel));

  const toRel = (abs: string): string => {
    if (abs === workDir) return '.';
    const rel = relative(workDir, abs);
    if (rel === '') return '.';
    return rel.split('/').join('/');
  };

  const isMissingPathError = (error: unknown): boolean => {
    const mapped = mapHostFsError(error, '');
    return mapped instanceof WorkspaceFsError && mapped.code === 'fs.path_not_found';
  };

  const realRootPairs = async (): Promise<readonly { dir: string; real: string }[]> => {
    const dirs = [workDir, ...additionalDirs];
    const key = dirs.join('\n');
    if (realRootsCache?.key === key) return realRootsCache.roots;
    const pairs: { dir: string; real: string }[] = [];
    for (const dir of dirs) {
      try {
        pairs.push({ dir, real: await fs.realpath(dir) });
      } catch {
        pairs.push({ dir, real: dir });
      }
    }
    realRootsCache = { key, roots: pairs };
    return pairs;
  };

  const realRoots = async (): Promise<readonly string[]> =>
    (await realRootPairs()).map((pair) => pair.real);

  const realpathExistingPrefix = async (abs: string): Promise<string> => {
    const tail: string[] = [];
    let current = abs;
    for (let i = 0; i < 256; i++) {
      try {
        const real = await fs.realpath(current);
        return tail.length === 0 ? real : join(real, ...tail.toReversed());
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const parent = dirname(current);
        if (parent === current) return abs;
        tail.push(basename(current));
        current = parent;
      }
    }
    return abs;
  };

  const resolveWithin = async (inputPath: string): Promise<string> => {
    if (inputPath === '' || inputPath === '/') {
      throw new WorkspaceFsError('fs.path_escapes', `path "${inputPath}" rejected (empty)`, {
        path: inputPath,
        reason: 'empty',
      });
    }
    if (isAbsolute(inputPath)) {
      throw new WorkspaceFsError('fs.path_escapes', `path "${inputPath}" rejected (absolute)`, {
        path: inputPath,
        reason: 'absolute',
      });
    }
    const segments = inputPath.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) {
      throw new WorkspaceFsError('fs.path_escapes', `path "${inputPath}" rejected (dotdot segment)`, {
        path: inputPath,
        reason: 'dotdot_segment',
      });
    }
    const abs = resolvePathInput(inputPath);
    if (!isWithinWorkspace(abs)) {
      throw new WorkspaceFsError('fs.path_escapes', `path "${inputPath}" escapes workspace`, {
        path: inputPath,
        reason: 'resolved_outside',
      });
    }
    const resolved = await realpathExistingPrefix(abs);
    const real = await realRoots();
    if (!real.some((root) => isInsideOrEqual(resolved, root))) {
      throw new WorkspaceFsError(
        'fs.path_escapes',
        `path "${inputPath}" escapes workspace through a symlink`,
        { path: inputPath, reason: 'symlink_outside' },
      );
    }
    return abs;
  };

  const matcherFor = async (rootDir: string): Promise<GitignoreMatcher> => {
    const cached = gitignoreCache.get(rootDir);
    if (cached !== undefined) return cached;
    let contents = '';
    try {
      contents = await fs.readText(join(rootDir, '.gitignore'));
    } catch {
    }
    const matcher = createGitignore(contents);
    gitignoreCache.set(rootDir, matcher);
    return matcher;
  };

  const matcher = (): Promise<GitignoreMatcher> => matcherFor(workDir);

  const walk = async (
    baseAbs: string,
    rootRel: string,
    matcherArg: GitignoreMatcher | undefined,
    visit: (relPath: string, name: string, kind: 'file' | 'directory' | 'symlink') => Promise<void>,
    depth = 0,
  ): Promise<void> => {
    if (depth > WALK_MAX_DEPTH) return;
    let entries: readonly HostDirEntry[];
    try {
      entries = await fs.readdir(rootRel === '' ? baseAbs : join(baseAbs, rootRel));
    } catch {
      return;
    }
    for (const entry of entries) {
      const { name } = entry;
      if (name === '.git') continue;
      const childRel = rootRel === '' ? name : `${rootRel}/${name}`;
      const isDir = entry.isDirectory && entry.isSymbolicLink !== true;
      if (matcherArg) {
        const probe = isDir ? `${childRel}/` : childRel;
        if (matcherArg.ignores(probe)) continue;
      }
      const kind: 'file' | 'directory' | 'symlink' = entry.isSymbolicLink
        ? 'symlink'
        : isDir
          ? 'directory'
          : 'file';
      await visit(childRel, name, kind);
      if (isDir) {
        await walk(baseAbs, childRel, matcherArg, visit, depth + 1);
      }
    }
  };

  const list = async (req: FsListRequest): Promise<FsListResponse> => {
    const abs = await resolveWithin(req.path);
    const rel = toRel(abs);

    let topStat: HostFileStat;
    try {
      topStat = await fs.stat(abs);
    } catch (error) {
      throw mapHostFsError(error, req.path);
    }
    if (!topStat.isDirectory) {
      throw missingPathError(req.path);
    }

    const gitignore = req.follow_gitignore ? await matcher() : undefined;

    const items: FsEntry[] = [];
    const childrenByPath: Record<string, FsEntry[]> = {};
    let truncated = false;

    interface QueueEntry {
      readonly relPath: string;
      readonly depthRemaining: number;
    }
    const queue: QueueEntry[] = [{ relPath: rel === '.' ? '' : rel, depthRemaining: req.depth }];

    interface Child {
      readonly name: string;
      readonly relPath: string;
      readonly stat: HostFileStat;
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      let names: readonly string[];
      try {
        names = (await fs.readdir(absOf(entry.relPath))).map((e) => e.name);
      } catch (error) {
        if (entry.relPath === (rel === '.' ? '' : rel)) {
          throw mapHostFsError(error, req.path);
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
        const st = await fs.lstat(absOf(childRel)).catch(() => undefined);
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
  };

  const read = async (req: FsReadRequest): Promise<FsReadResponse> => {
    const abs = await resolveWithin(req.path);
    const rel = toRel(abs);

    let st: HostFileStat;
    try {
      st = await fs.stat(abs);
    } catch (error) {
      throw mapHostFsError(error, req.path);
    }
    if (st.isDirectory) {
      throw new WorkspaceFsError('fs.is_directory', `path is a directory: ${req.path}`, {
        path: req.path,
      });
    }
    if (st.size > FS_READ_MAX_BYTES) {
      throw new WorkspaceFsError(
        'fs.too_large',
        `file too large: ${req.path} (${st.size} bytes > ${FS_READ_MAX_BYTES})`,
        { path: req.path, size: st.size },
      );
    }

    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample = sampleSize === 0 ? new Uint8Array() : await fs.readBytes(abs, sampleSize);
    const classification = classifyTextSample(sample);
    const transcodeEncoding =
      !classification.isBinary && classification.encoding !== 'utf-8' && req.encoding !== 'base64'
        ? classification.encoding
        : undefined;
    const isBinary =
      classification.isBinary ||
      (classification.encoding !== 'utf-8' && transcodeEncoding === undefined);

    if (isBinary && req.encoding === 'utf-8') {
      throw new WorkspaceFsError('fs.is_binary', `file is binary: ${req.path}`, { path: req.path });
    }

    let totalLength = st.size;
    let decodedBytes: Uint8Array | undefined;
    if (transcodeEncoding !== undefined) {
      decodedBytes = Buffer.from(
        decodeUtfText(await fs.readBytes(abs), transcodeEncoding),
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
      const window = await fs.readBytes(abs, req.offset + effectiveLength);
      bytes = window.subarray(req.offset, req.offset + effectiveLength);
    }

    const encoding: 'utf-8' | 'base64' =
      req.encoding === 'base64' || (req.encoding === 'auto' && isBinary) ? 'base64' : 'utf-8';
    const content =
      encoding === 'utf-8' ? Buffer.from(bytes).toString('utf-8') : Buffer.from(bytes).toString('base64');
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
  };

  const listMany = async (req: FsListManyRequest): Promise<FsListManyResponse> => {
    const results: Record<string, FsEntry[]> = {};
    const partialErrors: Record<string, { code: number; msg: string }> = {};
    const truncatedPaths: string[] = [];

    await Promise.all(
      req.paths.map(async (p) => {
        try {
          const sub = await list({
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
          if (error instanceof WorkspaceFsError && error.code === 'fs.path_escapes') throw error;
          partialErrors[p] = toWireError(error);
        }
      }),
    );

    const out: FsListManyResponse = { results };
    if (truncatedPaths.length > 0) out.truncated_paths = truncatedPaths;
    if (Object.keys(partialErrors).length > 0) out.partial_errors = partialErrors;
    return out;
  };

  const stat = async (req: FsStatRequest): Promise<FsStatResponse> => {
    const abs = await resolveWithin(req.path);
    const rel = toRel(abs);
    let st: HostFileStat;
    try {
      st = await fs.lstat(abs);
    } catch (error) {
      throw mapHostFsError(error, req.path);
    }
    const name = rel === '.' ? basename(workDir) : basename(abs);
    return buildFsEntry(rel, name, st, true);
  };

  const statMany = async (req: FsStatManyRequest): Promise<FsStatManyResponse> => {
    const resolved = await Promise.all(
      req.paths.map(async (p) => {
        const abs = await resolveWithin(p);
        return { raw: p, rel: toRel(abs), abs };
      }),
    );

    const entries: Record<string, FsEntry | null> = {};
    await Promise.all(
      resolved.map(async ({ raw, rel, abs }) => {
        try {
          const st = await fs.lstat(abs);
          const name = rel === '.' ? basename(workDir) : basename(abs);
          entries[raw] = buildFsEntry(rel, name, st, false);
        } catch {
          entries[raw] = null;
        }
      }),
    );
    return { entries };
  };

  const mkdirView = async (req: FsMkdirRequest): Promise<FsMkdirResponse> => {
    const abs = await resolveWithin(req.path);
    const rel = toRel(abs);
    try {
      await fs.mkdir(abs, { recursive: req.recursive });
    } catch (error) {
      const mapped = mapHostFsError(error, req.path);
      if (mapped instanceof WorkspaceFsError && mapped.code === 'fs.path_not_found') {
        throw new WorkspaceFsError('fs.path_not_found', `parent not found: ${req.path}`, {
          path: req.path,
        });
      }
      throw mapped;
    }
    const st = await fs.lstat(abs);
    return buildFsEntry(rel, basename(abs), st, false);
  };

  const resolvePathView = async (relPath: string): Promise<FsPathResolved> => {
    const abs = await resolveWithin(relPath);
    const rel = toRel(abs);
    let st: HostFileStat;
    try {
      st = await fs.lstat(abs);
    } catch (error) {
      throw mapHostFsError(error, relPath);
    }
    return { absolute: abs, relative: rel, isDirectory: st.isDirectory };
  };

  const resolveDownload = async (relPath: string): Promise<FsDownloadResolved> => {
    const abs = await resolveWithin(relPath);
    const rel = toRel(abs);
    let st: HostFileStat;
    try {
      st = await fs.stat(abs);
    } catch (error) {
      throw mapHostFsError(error, relPath);
    }
    if (st.isDirectory) {
      throw new WorkspaceFsError('fs.is_directory', `path is a directory: ${relPath}`, {
        path: relPath,
      });
    }
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample = sampleSize === 0 ? new Uint8Array() : await fs.readBytes(abs, sampleSize);
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
  };

  const search = async (req: FsSearchRequest): Promise<FsSearchResponse> => {
    if (req.query === '') {
      const listed = await list({
        path: '.',
        depth: 1,
        limit: req.limit,
        show_hidden: false,
        follow_gitignore: req.follow_gitignore,
        exclude_globs: req.exclude_globs,
        sort: 'type_first',
        include_git_status: false,
      });
      const items = listed.items
        .filter(
          (entry) =>
            req.include_globs === undefined || matchesAnyGlob(entry.path, req.include_globs),
        )
        .map((entry) => ({
          path: entry.path,
          name: entry.name,
          kind: entry.kind,
          score: 1,
          match_positions: [],
        }));
      return { items, truncated: listed.truncated };
    }

    const gitignore = req.follow_gitignore ? await matcher() : undefined;
    const candidates: FsSearchHit[] = [];
    const queryLower = req.query.toLowerCase();

    await walk(workDir, '', gitignore, async (relPath, name, kind) => {
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
  };

  const suggestRoots = async (): Promise<readonly SuggestRoot[]> => {
    const pairs = await realRootPairs();
    const result: SuggestRoot[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      if (result.some((root) => isInsideOrEqual(pair.real, root.real))) continue;
      result.push({ dir: pair.dir, real: pair.real, primary: i === 0 });
    }
    return result;
  };

  const suggestRootDirSlashes = (root: SuggestRoot): string => root.dir.split('\\').join('/');

  const suggestDisplayPath = (root: SuggestRoot, rel: string): string => {
    if (root.primary) return rel;
    const dir = suggestRootDirSlashes(root);
    return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`;
  };

  const displayCandidate = (root: SuggestRoot, candidate: SuggestCandidate): SuggestCandidate => {
    if (root.primary) return candidate;
    const path = suggestDisplayPath(root, candidate.path);
    const offset = path.length - candidate.path.length;
    return {
      ...candidate,
      path,
      positions: candidate.positions.map((position) => position + offset),
    };
  };

  const suggestTopLevel = async (
    req: FsSuggestRequest,
    suggestRootList: readonly SuggestRoot[],
  ): Promise<FsSuggestResponse> => {
    interface TopEntry {
      readonly path: string;
      readonly name: string;
      readonly kind: 'file' | 'directory' | 'symlink';
    }
    const all: TopEntry[] = [];
    let capped = false;
    for (const root of suggestRootList) {
      const gitignore = req.follow_gitignore ? await matcherFor(root.dir) : undefined;
      let entries: readonly HostDirEntry[];
      try {
        entries = await fs.readdir(root.dir);
      } catch (error) {
        throw mapHostFsError(error, root.dir);
      }
      const visible: { name: string; kind: TopEntry['kind'] }[] = [];
      for (const entry of entries) {
        const name = entry.name;
        if (!req.show_hidden && isHidden(name)) continue;
        if (gitignore !== undefined && (gitignore.ignores(name) || gitignore.ignores(`${name}/`))) {
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
        if (req.include_globs !== undefined && matchesAnyGlob(entry.name, req.include_globs)) {
          continue;
        }
        all.push({
          path: suggestDisplayPath(root, entry.name),
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
  };

  const suggestWithNode = async (
    query: SuggestQuery,
    cap: number,
    signal: AbortSignal,
    suggestRootList: readonly SuggestRoot[],
  ): Promise<FsSuggestResponse> => {
    const multi = suggestRootList.length > 1;
    const top = new SuggestTopHeap(cap);
    const seenPaths = new Set<string>();
    let matched = 0;
    try {
      for (const root of suggestRootList) {
        const gitignore = query.followGitignore ? await matcherFor(root.dir) : undefined;
        await walk(root.dir, '', gitignore, async (relPath, _name, kind) => {
          if (signal.aborted) throw SUGGEST_WALK_ABORTED;
          if (multi) {
            const pathKey = `${root.real}/${relPath}`;
            if (seenPaths.has(pathKey)) return;
            seenPaths.add(pathKey);
          }
          const candidate = evaluateSuggestCandidate(relPath, kind, query);
          if (candidate === null) return;
          matched += 1;
          top.push(displayCandidate(root, candidate));
        });
      }
    } catch (error) {
      if (error !== SUGGEST_WALK_ABORTED) throw error;
    }
    const items = top.drain().map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      kind: candidate.kind,
      score: candidate.score,
      match_positions: [...candidate.positions],
    }));
    return { items, truncated: matched > cap || signal.aborted };
  };

  const suggest = async (req: FsSuggestRequest): Promise<FsSuggestResponse> => {
    const suggestRootList = await suggestRoots();
    if (req.query === '') {
      return suggestTopLevel(req, suggestRootList);
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await suggestWithNode(query, cap, controller.signal, suggestRootList);
    } finally {
      clearTimeout(timer);
    }
  };

  const grepWithNode = async (
    req: FsGrepRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<FsGrepResponse> => {
    const gitignore = req.follow_gitignore ? await matcher() : undefined;
    const re = compileGrepPattern(req);

    const files: FsGrepFileHit[] = [];
    let filesScanned = 0;
    let totalMatches = 0;
    let truncated = false;

    const filePaths: string[] = [];
    await walk(workDir, '', gitignore, async (rel, _name, kind) => {
      if (kind !== 'file') return;
      if (req.include_globs && !matchesAnyGlob(rel, req.include_globs)) return;
      if (req.exclude_globs && matchesAnyGlob(rel, req.exclude_globs)) return;
      filePaths.push(rel);
    });

    for (const rel of filePaths) {
      if (signal.aborted) {
        if (totalMatches === 0 && filesScanned === 0) {
          throw new WorkspaceFsError(
            'fs.grep_timeout',
            `grep timed out after ${Date.now() - startedAt}ms`,
          );
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
        content = await fs.readText(absOf(rel));
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
  };

  const grep = async (req: FsGrepRequest): Promise<FsGrepResponse> => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GREP_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await grepWithNode(req, controller.signal, startedAt);
    } finally {
      clearTimeout(timer);
    }
  };

  const requireGit = (): WorkspaceGitPort => {
    if (git === undefined) {
      throw new WorkspaceFsError('fs.git_unavailable', 'git is unavailable on this runtime');
    }
    return git;
  };

  const gitStatus = async (req: FsGitStatusRequest): Promise<FsGitStatusResponse> => {
    const port = requireGit();
    let filter: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filter = new Set();
      for (const p of req.paths) {
        filter.add(toRel(await resolveWithin(p)));
      }
    }
    return port.status(workDir, filter);
  };

  const diff = async (req: FsDiffRequest): Promise<FsDiffResponse> => {
    const port = requireGit();
    const abs = await resolveWithin(req.path);
    return port.diff(workDir, toRel(abs), abs);
  };

  return {
    list,
    read,
    listMany,
    stat,
    statMany,
    mkdir: mkdirView,
    search,
    suggest,
    grep,
    gitStatus,
    diff,
    resolvePath: resolvePathView,
    resolveDownload,
  };
}

function isHidden(name: string): boolean {
  return HIDDEN_NAME_RE.test(name) || MACOS_NOISE.has(name);
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
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

function toWireError(error: unknown): { code: number; msg: string } {
  if (error instanceof WorkspaceFsError) {
    switch (error.code) {
      case 'fs.path_not_found':
        return { code: FS_WIRE_ERROR_CODE.FS_PATH_NOT_FOUND, msg: error.message };
      case 'fs.is_directory':
        return { code: FS_WIRE_ERROR_CODE.FS_IS_DIRECTORY, msg: error.message };
      case 'fs.is_binary':
        return { code: FS_WIRE_ERROR_CODE.FS_IS_BINARY, msg: error.message };
      case 'fs.too_large':
        return { code: FS_WIRE_ERROR_CODE.FS_TOO_LARGE, msg: error.message };
      case 'fs.too_many_results':
        return { code: FS_WIRE_ERROR_CODE.FS_TOO_MANY_RESULTS, msg: error.message };
    }
  }
  return {
    code: FS_WIRE_ERROR_CODE.INTERNAL_ERROR,
    msg: error instanceof Error ? error.message : 'internal error',
  };
}
