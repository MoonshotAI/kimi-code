/**
 * `FsService` — implementation of `IFsService`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Disposable } from '@moonshot-ai/agent-core';
import type {
  FsEntry,
  FsListManyRequest,
  FsListManyResponse,
  FsListRequest,
  FsListResponse,
  FsReadRequest,
  FsReadResponse,
  FsStatManyRequest,
  FsStatManyResponse,
  FsStatRequest,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { ISessionService, SessionNotFoundError } from '@moonshot-ai/services';

import {
  IFsService,
  FsPathNotFoundError,
  FsIsDirectoryError,
  FsIsBinaryError,
  FsTooLargeError,
  FsTooManyResultsError,
  type FsDownloadResolved,
} from './fs';
import { FsPathEscapesError, resolveSafePath } from './fsPathSafety';

/** 10 MB cap on `:read` total file size (SCHEMAS §10 / REST.md §3.9). */
const FS_READ_MAX_BYTES = 10 * 1024 * 1024;
/** 4 KB sample window for the binary heuristic. */
const FS_BINARY_SAMPLE_BYTES = 4096;
/** Fraction of non-printable chars in the sample that flips `is_binary = true`. */
const FS_BINARY_NONPRINTABLE_FRACTION = 0.3;

// Hidden file patterns we strip when `show_hidden: false`. Hidden = leading
// dot OR macOS-specific noise files. Matches REST.md §3.9 line 465.
const HIDDEN_NAME_RE = /^\./;
const MACOS_NOISE = new Set(['.DS_Store', '.AppleDouble', '.LSOverride']);

export class FsService extends Disposable implements IFsService {
  readonly _serviceBrand: undefined;

  /**
   * Per-cwd compiled `.gitignore` matcher cache. Lazily populated on the
   * first list call. Cleared on `dispose()`.
   *
   * Why per-cwd: two sessions may share a `cwd`; sharing the compiled
   * matcher is cheaper and safer (no stale state between sessions). On
   * `.gitignore` mutation we'd want to bust the cache, but we accept the
   * staleness because later file-watcher invalidation can clear it.
   */
  protected gitignoreCache = new Map<string, Ignore>();

  constructor(@ISessionService protected readonly sessions: ISessionService) {
    super();
  }

  override dispose(): void {
    this.gitignoreCache.clear();
    super.dispose();
  }

  // -----------------------------------------------------------------
  // :list
  // -----------------------------------------------------------------

  async list(sessionId: string, req: FsListRequest): Promise<FsListResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const safe = await resolveSafePath(cwd, req.path);

    // Ensure the target exists and is a directory; otherwise surface the
    // matching error code.
    let topStat: import('node:fs').Stats;
    try {
      topStat = await fs.stat(safe.absolute);
    } catch (err) {
      throw mapStatError(err, req.path);
    }
    if (!topStat.isDirectory()) {
      // For `:list` we want the path to be a directory. The dir-not-found
      // path uses 40409 per REST.md §3.9 line 484.
      throw new FsPathNotFoundError(req.path);
    }

    const realCwd = await fs.realpath(cwd);
    const matcher = req.follow_gitignore ? await this.matcher(realCwd) : undefined;

    const items: FsEntry[] = [];
    const childrenByPath: Record<string, FsEntry[]> = {};
    let truncated = false;

    // Walk the requested root + (depth-1) deeper. We collect children in
    // BFS order so the `limit` cap is fairly distributed across siblings.
    interface QueueEntry {
      absPath: string;
      // POSIX relative path from cwd; '' for the root.
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
        // Permission denied / disappearing dir mid-walk: skip silently
        // for non-root entries; surface for the root.
        if (entry.absPath === safe.absolute) {
          throw mapStatError(err, req.path);
        }
        continue;
      }

      // Apply hidden + gitignore + exclude filters BEFORE sort.
      const visible: import('node:fs').Dirent[] = [];
      for (const d of dirents) {
        if (!req.show_hidden && isHidden(d.name)) continue;
        const childRel = entry.relPath === '' ? d.name : `${entry.relPath}/${d.name}`;
        if (matcher) {
          // ignore expects a POSIX path; suffix '/' for directories so
          // patterns like `node_modules/` match.
          const probe = d.isDirectory() ? `${childRel}/` : childRel;
          if (matcher.ignores(probe)) continue;
        }
        if (req.exclude_globs && matchesAnyGlob(childRel, req.exclude_globs)) {
          continue;
        }
        visible.push(d);
      }

      sortDirents(visible, req.sort);

      // Materialize FsEntry rows, capped at limit.
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
          // Top-level items[] capture
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

  // -----------------------------------------------------------------
  // :read
  // -----------------------------------------------------------------

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

    // Read the bytes we care about. The 4 KB binary sniff is always at
    // the START of the file regardless of `offset`.
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample = await readFileRange(safe.absolute, 0, sampleSize);
    const isBinaryHeuristic = detectBinary(sample);

    if (isBinaryHeuristic && req.encoding === 'utf-8') {
      // explicit utf-8 + binary file → 40907 per SCHEMAS §10 / REST.md §3.9
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

  // -----------------------------------------------------------------
  // :list_many
  //
  // Per-path failures land in `partial_errors` and don't poison the
  // whole response. We re-use `list()` for each path so the path-safety,
  // gitignore filter, depth recursion, and limit behaviour stays in one
  // implementation (the alternative — duplicating the dir walk — would
  // be a maintenance burden and a subtle-bug risk).
  //
  // Path-safety failures (41304) DO fail batch-wide. They indicate the
  // client tried to escape the session cwd; reporting per-path success
  // for the safe paths would leak that the daemon walked the unsafe one
  // far enough to compute its absolute path.
  // -----------------------------------------------------------------

  async listMany(
    sessionId: string,
    req: FsListManyRequest,
  ): Promise<FsListManyResponse> {
    // Touch the session once (40401 surfaces before any list call).
    await this.sessions.get(sessionId);

    const results: Record<string, FsEntry[]> = {};
    const partialErrors: Record<string, { code: number; msg: string }> = {};
    const truncatedPaths: string[] = [];

    // Parallel — `list()` does its own safety + readdir per call.
    // Order is preserved by collecting into the keyed maps using the
    // input path string verbatim (REST.md §3.9 line 507 mandates the
    // input string is the result key).
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
          // Re-throw safety + session errors batch-wide.
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

  // -----------------------------------------------------------------
  // :stat
  //
  // Single-path `FsEntry` lookup. Same path-safety guard as `:list` and
  // `:read`. Surfaces `40409` when the file is missing, `41304` on
  // safety, `40401` on unknown session.
  // -----------------------------------------------------------------

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
    // `withMimeAndBinary: true` because `:stat` is the "give me everything
    // you know about this file" endpoint per SCHEMAS §9.2 line 549.
    return buildFsEntryFromStat(safe.relative, name, safe.absolute, st, true);
  }

  // -----------------------------------------------------------------
  // :stat_many
  //
  // Batch stat. Per-path misses surface as `null` (REST.md §3.9 line 524
  // + SCHEMAS §9.2 line 524). Path-safety failures (41304) fail batch-wide
  // — we resolve safety for ALL paths up-front so a bad path crashes the
  // whole call before any I/O lands.
  //
  // **Performance**: run `fs.stat` under `Promise.all` so large batches stay
  // responsive; each syscall is ~µs, keeping the 1000-path bench well under
  // the target on typical CI/dev hardware.
  // -----------------------------------------------------------------

  async statMany(
    sessionId: string,
    req: FsStatManyRequest,
  ): Promise<FsStatManyResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;

    // Resolve safety up-front. If ANY input string escapes the session,
    // we throw `FsPathEscapesError` — caller maps to envelope 41304.
    const resolved = await Promise.all(
      req.paths.map(async (p) => ({
        raw: p,
        safe: await resolveSafePath(cwd, p),
      })),
    );

    // Parallel `fs.stat`. Per-path errors → `null`. We use stat (not lstat)
    // so symlinks resolve through to their target — symmetric with
    // `:list`'s readdir behaviour where the kind is derived from the
    // dirent type. Path-safety is already enforced by `resolveSafePath`,
    // so following symlinks here is safe.
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
              /* withMimeAndBinary */ false,
            ),
          };
        } catch {
          // 40409 etc. → null per spec.
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

  // -----------------------------------------------------------------
  // resolveDownload
  //
  // Returns enough metadata for the route layer to drive a streaming GET
  // response without doing the path-safety dance again. The route owns
  // mime negotiation, Range / If-None-Match parsing, and the actual
  // `fs.createReadStream`. We just confirm the file exists and isn't a
  // directory; the rest is HTTP-layer logic.
  //
  // Errors:
  //   - 41304 FsPathEscapesError      (safety violation)
  //   - 40409 FsPathNotFoundError     (missing file)
  //   - 40906 FsIsDirectoryError      (path resolves to a directory)
  //
  // No 41302 size cap on download — the whole point of `:download` is
  // pulling bytes that `:read`'s 10MB cap blocks.
  // -----------------------------------------------------------------

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
    // Detect binary so we pick a sensible default MIME if the extension
    // doesn't map to one. We sample 4KB at the front of the file —
    // mirrors `:read`'s sniff. Cheap enough to do unconditionally.
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

  // -----------------------------------------------------------------
  // .gitignore matcher
  // -----------------------------------------------------------------

  protected async matcher(realCwd: string): Promise<Ignore | undefined> {
    const cached = this.gitignoreCache.get(realCwd);
    if (cached !== undefined) return cached;
    const ig = ignore();
    // Always ignore the .git dir itself — git-managed but never useful in
    // a list. (Matches git's own behaviour and VSCode's default.)
    ig.add('.git/');
    try {
      const contents = await fs.readFile(path.join(realCwd, '.gitignore'), 'utf-8');
      ig.add(contents);
    } catch {
      // No .gitignore — that's fine, only the .git/ rule applies.
    }
    this.gitignoreCache.set(realCwd, ig);
    return ig;
  }
}

// ===========================================================================
// Helpers (pure functions / no `this` access)
// ===========================================================================

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
    // mtime_desc and size_desc would need stat calls per entry; we currently
    // only sort dirents which don't carry mtime. Fall back to name_asc and
    // upgrade in a later chain when telemetry shows demand. SCHEMAS §9.2
    // permits this — the field is a hint, not a hard contract.
    mtime_desc: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
      a.name.localeCompare(b.name),
    size_desc: (a: import('node:fs').Dirent, b: import('node:fs').Dirent) =>
      a.name.localeCompare(b.name),
  }[sort];
  ds.sort(cmp);
}

/**
 * Minimal glob → RegExp converter — handles `*`, `**`, `?`. Mirrors the
 * subset used by VSCode `files.exclude` (we don't accept `{a,b}` brace
 * groups since SCHEMAS §3.9 doesn't pin a glob grammar). Patterns that
 * don't contain `**` are anchored to the FULL path so `*.log` matches
 * any `.log` filename.
 */
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
    // Disappeared between readdir and lstat — surface a minimal record.
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

/**
 * Build an `FsEntry` directly from a `Stats` object (no `Dirent`). Used by
 * `:stat` / `:stat_many` where we only have the path, not a parent
 * `readdir` result. The kind is derived from the Stats accessors instead
 * of Dirent flags.
 *
 * `withMimeAndBinary: true` means the entry is the FULL response (e.g.
 * `:stat`), where SCHEMAS §9.2 line 549 mandates mime + language_id.
 * `false` means a lighter shape (e.g. `:stat_many` items where the same
 * data could be fetched in bulk later via `:read` per file).
 */
function buildFsEntryFromStat(
  relPath: string,
  name: string,
  absPath: string,
  st: import('node:fs').Stats,
  withMimeAndBinary: boolean,
): FsEntry {
  // `fs.stat` follows symlinks; we get the target's kind. The wire kind
  // for a followed-through symlink is the underlying file/dir, not
  // `symlink` — which matches what most clients want. Use `fs.lstat`
  // upstream if symlink-as-symlink visibility is needed.
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
  // `mtimeMs + size + ino` packed into a hex string — cheap, stable per
  // file, invalidates on write. Not a cryptographic hash; SCHEMAS §9.2
  // explicitly permits this approach.
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
    if (b === 0) return true; // null byte = binary
    // Printable ASCII range: 9 (tab), 10 (LF), 13 (CR), 32-126.
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 32 && b <= 126) continue;
    // UTF-8 continuation / multibyte: 0x80-0xFF treated as non-ASCII; we
    // don't try to decode here — we just count.
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
  // Trailing newline shouldn't add an extra empty line per common convention.
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

/**
 * Map a thrown service error to the wire `{code, msg}` shape used by
 * `:list_many.partial_errors`. Used ONLY for per-path failures inside the
 * batch handler; safety + session errors are re-thrown batch-wide before
 * reaching this helper (see `listMany`).
 *
 * Unknown errors fall through to `50001 internal.error` rather than
 * propagating — a single broken path shouldn't poison the whole batch.
 */
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
