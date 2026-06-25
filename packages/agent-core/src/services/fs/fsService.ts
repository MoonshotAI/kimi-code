

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type {
  FsEntry,
  FsListManyRequest,
  FsListManyResponse,
  FsListRequest,
  FsListResponse,
  FsMkdirRequest,
  FsReadRequest,
  FsReadResponse,
  FsStatManyRequest,
  FsStatManyResponse,
  FsStatRequest,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { ISessionService, SessionNotFoundError } from '../session/session';

import {
  IFsService,
  FsAlreadyExistsError,
  FsPathNotFoundError,
  FsIsDirectoryError,
  FsIsBinaryError,
  FsTooLargeError,
  FsTooManyResultsError,
  type FsDownloadResolved,
  type FsPathResolved,
} from './fs';
import { FsPathEscapesError, resolveSafePath } from './fsPathSafety';

const FS_READ_MAX_BYTES = 10 * 1024 * 1024;

const FS_BINARY_SAMPLE_BYTES = 4096;

const FS_BINARY_NONPRINTABLE_FRACTION = 0.3;

const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set(['.DS_Store', '.AppleDouble', '.LSOverride']);

export class FsService extends Disposable implements IFsService {
  readonly _serviceBrand: undefined;

  protected gitignoreCache = new Map<string, Ignore>();

  constructor(@ISessionService protected readonly sessions: ISessionService) {
    super();
  }

  override dispose(): void {
    this.gitignoreCache.clear();
    super.dispose();
  }

  async list(sessionId: string, req: FsListRequest): Promise<FsListResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, req.path);

    let topStat: import('node:fs').Stats;
    try {
      topStat = await fs.stat(safe.absolute);
    } catch (err) {
      throw mapStatError(err, req.path);
    }
    if (!topStat.isDirectory()) {

      throw new FsPathNotFoundError(req.path);
    }

    const realCwd = await fs.realpath(cwd);
    const matcher = req.follow_gitignore ? await this.matcher(realCwd) : undefined;

    const items: FsEntry[] = [];
    const childrenByPath: Record<string, FsEntry[]> = {};
    let truncated = false;

    interface QueueEntry {
      absPath: string;

      relPath: string;
      depthRemaining: number;
    }
    const queue: QueueEntry[] = [
      {
        absPath: safe.absolute,
        relPath: safe.relative === '.' ? '' : safe.relative,
        depthRemaining: req.depth,
      },
    ];

    while (queue.length > 0) {
      const entry = queue.shift()!;
      let dirents: import('node:fs').Dirent[];
      try {
        dirents = await fs.readdir(entry.absPath, { withFileTypes: true });
      } catch (err) {

        if (entry.absPath === safe.absolute) {
          throw mapStatError(err, req.path);
        }
        continue;
      }

      const visible: import('node:fs').Dirent[] = [];
      for (const d of dirents) {
        if (!req.show_hidden && isHidden(d.name)) continue;
        const childRel = entry.relPath === '' ? d.name : `${entry.relPath}/${d.name}`;
        if (matcher) {

          const probe = d.isDirectory() ? `${childRel}/` : childRel;
          if (matcher.ignores(probe)) continue;
        }
        if (req.exclude_globs && matchesAnyGlob(childRel, req.exclude_globs)) {
          continue;
        }
        visible.push(d);
      }

      sortDirents(visible, req.sort);

      const parentKey = entry.relPath === '' ? '.' : entry.relPath;
      const bucket: FsEntry[] = [];
      for (const d of visible) {
        if (items.length >= req.limit && entry.depthRemaining === req.depth) {
          truncated = true;
          break;
        }
        const childRel = entry.relPath === '' ? d.name : `${entry.relPath}/${d.name}`;
        const childAbs = path.join(entry.absPath, d.name);
        const fsEntry = await buildFsEntry(childRel, d.name, childAbs, d, false);
        if (entry.depthRemaining === req.depth) {

          items.push(fsEntry);
        }
        bucket.push(fsEntry);
        if (d.isDirectory() && entry.depthRemaining > 1) {
          queue.push({
            absPath: childAbs,
            relPath: childRel,
            depthRemaining: entry.depthRemaining - 1,
          });
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

  async read(sessionId: string, req: FsReadRequest): Promise<FsReadResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, req.path);

    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(safe.absolute);
    } catch (err) {
      throw mapStatError(err, req.path);
    }
    if (st.isDirectory()) {
      throw new FsIsDirectoryError(req.path);
    }
    if (st.size > FS_READ_MAX_BYTES) {
      throw new FsTooLargeError(req.path, st.size);
    }

    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample = await readFileRange(safe.absolute, 0, sampleSize);
    const isBinaryHeuristic = detectBinary(sample);

    if (isBinaryHeuristic && req.encoding === 'utf-8') {

      throw new FsIsBinaryError(req.path);
    }

    const effectiveLength = Math.min(req.length, st.size - req.offset);
    const bytes =
      effectiveLength <= 0
        ? Buffer.alloc(0)
        : await readFileRange(
            safe.absolute,
            req.offset,
            req.offset + effectiveLength,
          );

    const encoding: 'utf-8' | 'base64' =
      req.encoding === 'base64' || (req.encoding === 'auto' && isBinaryHeuristic)
        ? 'base64'
        : 'utf-8';
    const content = encoding === 'utf-8' ? bytes.toString('utf-8') : bytes.toString('base64');
    const truncated = req.offset + effectiveLength < st.size;

    const mime = guessMime(safe.relative, isBinaryHeuristic);
    const languageId = encoding === 'utf-8' ? guessLanguageId(safe.relative) : undefined;
    const etag = buildEtag(st);

    const out: FsReadResponse = {
      path: safe.relative,
      content,
      encoding,
      size: st.size,
      truncated,
      etag,
      mime,
      is_binary: isBinaryHeuristic,
    };
    if (languageId !== undefined) out.language_id = languageId;
    if (encoding === 'utf-8') {
      out.line_count = countLines(content);
    }
    return out;
  }

  async listMany(
    sessionId: string,
    req: FsListManyRequest,
  ): Promise<FsListManyResponse> {

    await this.sessions.get(sessionId);

    const results: Record<string, FsEntry[]> = {};
    const partialErrors: Record<string, { code: number; msg: string }> = {};
    const truncatedPaths: string[] = [];

    await Promise.all(
      req.paths.map(async (p) => {
        try {
          const sub = await this.list(sessionId, {
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

          if (err instanceof FsPathEscapesError) throw err;
          if (err instanceof SessionNotFoundError) throw err;
          partialErrors[p] = mapToWireError(err);
        }
      }),
    );

    const out: FsListManyResponse = { results };
    if (truncatedPaths.length > 0) out.truncated_paths = truncatedPaths;
    if (Object.keys(partialErrors).length > 0) out.partial_errors = partialErrors;
    return out;
  }

  async stat(sessionId: string, req: FsStatRequest): Promise<FsEntry> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, req.path);
    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(safe.absolute);
    } catch (err) {
      throw mapStatError(err, req.path);
    }
    const name =
      safe.relative === '.' ? path.basename(cwd) : path.basename(safe.absolute);

    return buildFsEntryFromStat(safe.relative, name, safe.absolute, st, true);
  }

  async statMany(
    sessionId: string,
    req: FsStatManyRequest,
  ): Promise<FsStatManyResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;

    const resolved = await Promise.all(
      req.paths.map(async (p) => ({
        raw: p,
        safe: await resolveSafePath(cwd, p),
      })),
    );

    const stats = await Promise.all(
      resolved.map(async ({ raw, safe }) => {
        try {
          const st = await fs.stat(safe.absolute);
          const name =
            safe.relative === '.'
              ? path.basename(cwd)
              : path.basename(safe.absolute);
          return {
            raw,
            entry: buildFsEntryFromStat(
              safe.relative,
              name,
              safe.absolute,
              st,
               false,
            ),
          };
        } catch {

          return { raw, entry: null };
        }
      }),
    );

    const entries: Record<string, FsEntry | null> = {};
    for (const { raw, entry } of stats) {
      entries[raw] = entry;
    }
    return { entries };
  }

  async mkdir(sessionId: string, req: FsMkdirRequest): Promise<FsEntry> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, req.path);

    try {
      await fs.mkdir(safe.absolute, { recursive: req.recursive });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new FsAlreadyExistsError(req.path);
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Non-recursive mkdir whose parent is missing / not a directory.
        throw new FsPathNotFoundError(req.path);
      }
      throw err;
    }

    const st = await fs.stat(safe.absolute);
    const name = path.basename(safe.absolute);
    return buildFsEntryFromStat(safe.relative, name, safe.absolute, st, false);
  }

  async resolveDownload(
    sessionId: string,
    relPath: string,
  ): Promise<FsDownloadResolved> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, relPath);
    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(safe.absolute);
    } catch (err) {
      throw mapStatError(err, relPath);
    }
    if (st.isDirectory()) {
      throw new FsIsDirectoryError(relPath);
    }

    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0
        ? Buffer.alloc(0)
        : await readFileRange(safe.absolute, 0, sampleSize);
    const isBinary = detectBinary(sample);

    return {
      absolute: safe.absolute,
      relative: safe.relative,
      size: st.size,
      etag: buildEtag(st),
      mime: guessMime(safe.relative, isBinary),
      modifiedAt: new Date(st.mtimeMs),
    };
  }

  async resolvePath(
    sessionId: string,
    relPath: string,
  ): Promise<FsPathResolved> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, relPath);
    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(safe.absolute);
    } catch (err) {
      throw mapStatError(err, relPath);
    }
    return {
      absolute: safe.absolute,
      relative: safe.relative,
      isDirectory: st.isDirectory(),
    };
  }

  protected async matcher(realCwd: string): Promise<Ignore | undefined> {
    const cached = this.gitignoreCache.get(realCwd);
    if (cached !== undefined) return cached;
    const ig = ignore();

    ig.add('.git/');
    try {
      const contents = await fs.readFile(path.join(realCwd, '.gitignore'), 'utf-8');
      ig.add(contents);
    } catch {

    }
    this.gitignoreCache.set(realCwd, ig);
    return ig;
  }
}

function isHidden(name: string): boolean {
  return HIDDEN_NAME_RE.test(name) || MACOS_NOISE.has(name);
}

function sortDirents(
  ds: import('node:fs').Dirent[],
  sort: FsListRequest['sort'],
): void {
  const cmp = {
    type_first: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    },
    name_asc: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
      a.name.localeCompare(b.name),
    name_desc: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
      b.name.localeCompare(a.name),

    mtime_desc: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
      a.name.localeCompare(b.name),
    size_desc: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
      a.name.localeCompare(b.name),
  }[sort];
  ds.sort(cmp);
}

function matchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(rel)) return true;
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

async function buildFsEntry(
  relPath: string,
  name: string,
  absPath: string,
  dirent: import('node:fs').Dirent,
  withMimeAndBinary: boolean,
): Promise<FsEntry> {
  let st: import('node:fs').Stats | undefined;
  try {
    st = await fs.lstat(absPath);
  } catch {

  }
  return buildFsEntryFromDirentAndStat(
    relPath,
    name,
    absPath,
    dirent,
    st,
    withMimeAndBinary,
  );
}

function buildFsEntryFromDirentAndStat(
  relPath: string,
  name: string,
  absPath: string,
  dirent: import('node:fs').Dirent,
  st: import('node:fs').Stats | undefined,
  withMimeAndBinary: boolean,
): FsEntry {
  const kind: FsEntry['kind'] = dirent.isSymbolicLink()
    ? 'symlink'
    : dirent.isDirectory()
      ? 'directory'
      : 'file';
  const entry: FsEntry = {
    path: relPath,
    name,
    kind,
    modified_at: st ? new Date(st.mtimeMs).toISOString() : new Date(0).toISOString(),
  };
  if (kind === 'file' && st !== undefined) {
    entry.size = st.size;
  }
  if (st !== undefined) {
    entry.etag = buildEtag(st);
  }
  if (withMimeAndBinary && kind === 'file') {
    entry.mime = guessMime(relPath, false);
    const lang = guessLanguageId(relPath);
    if (lang !== undefined) entry.language_id = lang;
  }
  void absPath;
  return entry;
}

function buildFsEntryFromStat(
  relPath: string,
  name: string,
  absPath: string,
  st: import('node:fs').Stats,
  withMimeAndBinary: boolean,
): FsEntry {

  const kind: FsEntry['kind'] = st.isDirectory() ? 'directory' : 'file';
  const entry: FsEntry = {
    path: relPath,
    name,
    kind,
    modified_at: new Date(st.mtimeMs).toISOString(),
    etag: buildEtag(st),
  };
  if (kind === 'file') {
    entry.size = st.size;
  }
  if (withMimeAndBinary && kind === 'file') {
    entry.mime = guessMime(relPath, false);
    const lang = guessLanguageId(relPath);
    if (lang !== undefined) entry.language_id = lang;
  }
  void absPath;
  return entry;
}

function buildEtag(st: import('node:fs').Stats): string {

  return [
    Math.floor(st.mtimeMs).toString(36),
    st.size.toString(36),
    st.ino.toString(36),
  ].join('-');
}

function detectBinary(buf: Buffer): boolean {
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

async function readFileRange(
  absPath: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const fh = await fs.open(absPath, 'r');
  try {
    const length = end - start;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
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
  const ext = path.extname(relPath).toLowerCase();
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
  return EXT_TO_LANGUAGE[path.extname(relPath).toLowerCase()];
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

function mapStatError(err: unknown, inputPath: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FsPathNotFoundError(inputPath);
  }
  return err as Error;
}

function mapToWireError(err: unknown): { code: number; msg: string } {
  if (err instanceof FsPathNotFoundError) {
    return { code: 40409, msg: err.message };
  }
  if (err instanceof FsIsDirectoryError) {
    return { code: 40906, msg: err.message };
  }
  if (err instanceof FsIsBinaryError) {
    return { code: 40907, msg: err.message };
  }
  if (err instanceof FsTooLargeError) {
    return { code: 41302, msg: err.message };
  }
  if (err instanceof FsTooManyResultsError) {
    return { code: 41303, msg: err.message };
  }
  return { code: 50001, msg: (err as Error)?.message ?? 'internal error' };
}

registerSingleton(IFsService, FsService, InstantiationType.Delayed);
