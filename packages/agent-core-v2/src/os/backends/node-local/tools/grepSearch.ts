/**
 * `fileTools` domain — grep search execution (ripgrep + node fallback).
 *
 * Runs the actual content search behind {@link GrepTool}: resolves a working
 * `rg`, streams `--json` output through the host `IHostProcessService`, and
 * parses it into the protocol `FsGrepResponse`. When `rg` is unavailable it
 * falls back to a pure-node walker (gitignore-aware, JS regex) so Grep still
 * works on hosts without ripgrep — matching the previous `sessionFs`
 * `ISessionFsService.grep` behavior.
 *
 * Ported from `session/sessionFs/fsService` (`grep` / `grepWithRg` /
 * `grepWithNode` / `parseRgJsonOutput`) onto the os domains: subprocesses go
 * through `IHostProcessService` and the node walker through `IHostFileSystem`.
 */

import { join } from 'node:path';

import type {
  FsGrepFileHit,
  FsGrepMatch,
  FsGrepRequest,
  FsGrepResponse,
} from '@moonshot-ai/protocol';
import ignore, { type Ignore } from 'ignore';

import { ErrorCodes, KimiError } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import { ensureRgPath, type RgProbe, type RgResolution } from './rgLocator';

const GREP_TIMEOUT_MS = 30_000;
const WALK_MAX_DEPTH = 64;

export interface GrepSearchDeps {
  readonly processService: IHostProcessService;
  readonly fs: IHostFileSystem;
  /** Absolute working directory the search is confined to. */
  readonly cwd: string;
}

/**
 * Execute a grep search. Resolves `rg` and runs it when available, otherwise
 * falls back to a pure-node walker. Times out after {@link GREP_TIMEOUT_MS};
 * if the timeout fires before any match is found, throws a coded
 * `FS_GREP_TIMEOUT` error (the tool maps it to a friendly message).
 */
export async function executeGrepSearch(
  req: FsGrepRequest,
  deps: GrepSearchDeps,
): Promise<FsGrepResponse> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GREP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const resolution = await resolveRg(deps.processService, deps.cwd, controller.signal);
    if (resolution !== null) {
      return await grepWithRg(req, controller.signal, startedAt, resolution.path, deps);
    }
    return await grepWithNode(req, controller.signal, startedAt, deps);
  } finally {
    clearTimeout(timer);
  }
}

// ── ripgrep path ─────────────────────────────────────────────────────

async function grepWithRg(
  req: FsGrepRequest,
  signal: AbortSignal,
  startedAt: number,
  rgPath: string,
  deps: GrepSearchDeps,
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

  const res = await runCommand(deps.processService, rgPath, args, {
    cwd: deps.cwd,
    signal,
  });

  return parseRgJsonOutput(res.stdout, req, signal.aborted, Date.now() - startedAt);
}

// ── node fallback path ───────────────────────────────────────────────

async function grepWithNode(
  req: FsGrepRequest,
  signal: AbortSignal,
  startedAt: number,
  deps: GrepSearchDeps,
): Promise<FsGrepResponse> {
  const matcher = req.follow_gitignore ? await loadGitignoreMatcher(deps.fs, deps.cwd) : undefined;
  const re = compileGrepPattern(req);

  const files: FsGrepFileHit[] = [];
  let filesScanned = 0;
  let totalMatches = 0;
  let truncated = false;

  const filePaths: string[] = [];
  await walk(deps.fs, deps.cwd, '', matcher, async (_abs, rel, _name, kind) => {
    if (kind !== 'file') return;
    if (req.include_globs && !matchesAnyGlob(rel, req.include_globs)) return;
    if (req.exclude_globs && matchesAnyGlob(rel, req.exclude_globs)) return;
    filePaths.push(rel);
  });

  for (const rel of filePaths) {
    if (signal.aborted) {
      if (totalMatches === 0 && filesScanned === 0) {
        throw new KimiError(
          ErrorCodes.FS_GREP_TIMEOUT,
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
      content = await deps.fs.readText(join(deps.cwd, rel));
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

async function walk(
  fs: IHostFileSystem,
  absRoot: string,
  relRoot: string,
  matcher: Ignore | undefined,
  visit: (
    absPath: string,
    relPath: string,
    name: string,
    kind: 'file' | 'directory',
  ) => Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > WALK_MAX_DEPTH) return;
  let entries: Awaited<ReturnType<IHostFileSystem['readdir']>>;
  try {
    entries = await fs.readdir(absRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const childAbs = join(absRoot, entry.name);
    const childRel = relRoot === '' ? entry.name : `${relRoot}/${entry.name}`;
    const isDir = entry.isDirectory;
    if (matcher) {
      const probe = isDir ? `${childRel}/` : childRel;
      if (matcher.ignores(probe)) continue;
    }
    const kind: 'file' | 'directory' = isDir ? 'directory' : 'file';
    await visit(childAbs, childRel, entry.name, kind);
    if (isDir) {
      await walk(fs, childAbs, childRel, matcher, visit, depth + 1);
    }
  }
}

async function loadGitignoreMatcher(
  fs: IHostFileSystem,
  cwd: string,
): Promise<Ignore | undefined> {
  const ig = ignore();
  ig.add('.git/');
  try {
    const contents = await fs.readText(join(cwd, '.gitignore'));
    ig.add(contents);
  } catch {
    // No .gitignore — keep the `.git/` default only.
  }
  return ig;
}

/**
 * Resolve a usable `rg`. Probes `rg --version` through the host process
 * service. Returns `null` when `rg` is unavailable so the caller can fall
 * back to the pure-node walker. The cached-binary fallback is disabled here —
 * Grep's node fallback already covers the missing-`rg` case and keeping it
 * off makes the fallback deterministic.
 */
async function resolveRg(
  processService: IHostProcessService,
  cwd: string,
  signal: AbortSignal,
): Promise<RgResolution | null> {
  const probe: RgProbe = {
    exec: (args) => {
      const [command, ...rest] = args;
      if (command === undefined) return Promise.resolve({ exitCode: -1 });
      return runCommand(processService, command, rest, { cwd, signal }).then((r) => ({
        exitCode: r.exitCode,
      }));
    },
  };
  try {
    return await ensureRgPath(probe, { signal });
  } catch {
    return null;
  }
}

// ── subprocess helper ────────────────────────────────────────────────

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(
  processService: IHostProcessService,
  command: string,
  args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const proc: IHostProcess = await processService.spawn(command, args, { cwd: options.cwd });

  const signal = options.signal;
  const onAbort = (): void => {
    void proc.kill('SIGKILL');
  };
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.wait().catch(() => -1),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    try {
      proc.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      data += chunk;
    });
    stream.once('end', () => resolve(data));
    stream.once('error', reject);
  });
}

// ── pure helpers (ported from session/sessionFs/fsSearch) ──────────────

function compileGrepPattern(req: FsGrepRequest): RegExp {
  const flags = req.case_sensitive ? 'g' : 'gi';
  const body = req.regex ? req.pattern : escapeRegExp(req.pattern);
  return new RegExp(body, flags);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function stripTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}

interface RgPathField {
  text?: string;
  bytes?: string;
}
interface RgLinesField {
  text?: string;
  bytes?: string;
}
interface RgJsonRecord {
  type: 'begin' | 'end' | 'match' | 'context' | 'summary';
  data?: {
    path?: RgPathField;
    lines?: RgLinesField;
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

function rgPath(p: RgPathField | undefined): string | undefined {
  if (p === undefined) return undefined;
  let raw: string | undefined;
  if (typeof p.text === 'string') {
    raw = p.text;
  } else if (typeof p.bytes === 'string') {
    try {
      raw = Buffer.from(p.bytes, 'base64').toString('utf-8');
    } catch {
      return undefined;
    }
  }
  if (raw === undefined) return undefined;

  if (raw.startsWith('./')) return raw.slice(2);
  return raw;
}

function rgText(l: RgLinesField | undefined): string {
  if (l === undefined) return '';
  if (typeof l.text === 'string') return l.text;
  if (typeof l.bytes === 'string') {
    try {
      return Buffer.from(l.bytes, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return '';
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

  for (const p of Array.from(fileBuf.keys())) {
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
