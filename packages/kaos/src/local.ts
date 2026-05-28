import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import { detectEnvironmentFromNode, type Environment } from './environment';
import { KaosFileExistsError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

const isWindows: boolean = process.platform === 'win32';

/**
 * Build the `(dev, ino)` cycle-detection key used by `_globWalk`'s
 * visited set. Returns `null` when `ino` is 0, which Node returns on
 * filesystems that don't carry inodes (Windows FAT/exFAT, some SMB/NFS
 * mounts). A null key signals "no reliable identity for this dir" so
 * the caller skips visited tracking for that descent — cycle safety
 * is weakened on those filesystems, but normal walking works instead
 * of every directory colliding on the shared key `"<dev>:0"`.
 */
function cycleKey(s: { dev: number; ino: number }): string | null {
  if (s.ino === 0) return null;
  return `${String(s.dev)}:${String(s.ino)}`;
}

class LocalProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Process must be created with stdin/stdout/stderr pipes.');
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = new BufferedReadable(child.stderr);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    // Reject if the process never actually started (spawn failed).
    // pid <= 0 indicates ChildProcess.pid was undefined, which happens
    // when spawn() fails to find/execute the command. Calling
    // process.kill(-1, ...) on POSIX would signal the entire process
    // group, potentially killing unrelated processes.
    if (this.pid <= 0) {
      return Promise.resolve();
    }

    // On Windows, `ChildProcess.kill()` only signals the shell parent, leaving
    // grandchildren alive. Use `taskkill /T` so the caller's graceful and force
    // kill phases apply to the whole process tree.
    if (isWindows) {
      const useForce = signal === 'SIGKILL';
      const taskkillArgs = useForce
        ? ['/T', '/F', '/PID', String(this.pid)]
        : ['/T', '/PID', String(this.pid)];
      return new Promise<void>((resolve) => {
        const killer = spawn('taskkill', taskkillArgs, {
          stdio: 'ignore',
          windowsHide: true,
        });
        const done = (): void => {
          resolve();
        };
        killer.once('error', done);
        killer.once('close', done);
      });
    }

    // On POSIX, `detached:true` makes the child a process-group leader
    // (pgid === pid). A plain `ChildProcess.kill()` still only signals the
    // direct child, so a shell like `bash -c 'sleep 100 & sleep 100'` leaves
    // grandchildren orphaned. `process.kill(-pid, signal)` signals the group
    // (negative pid = process-group id under POSIX kill(2)).
    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // ESRCH = group already gone (child exited + reaped between
      // `wait()` racing spawn + this call). Treat as successful kill.
      if (err.code === 'ESRCH') return Promise.resolve();
      // EPERM is typically a misconfiguration (e.g. non-detached
      // spawn earlier in the file); fall back to direct `.kill()` so
      // we at least signal the direct child instead of throwing.
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
          /* best effort */
        }
        return Promise.resolve();
      }
      throw error;
    }
    return Promise.resolve();
  }
}

/**
 * A KAOS implementation that directly interacts with the local filesystem.
 *
 * Note: LocalKaos maintains its own per-instance working directory (`_cwd`)
 * rather than mutating `process.cwd()`. This lets multiple LocalKaos instances
 * coexist with independent cwds (e.g. when switching contexts via
 * `runWithKaos`) without cross-polluting each other's relative-path resolution.
 */
export class LocalKaos implements Kaos {
  readonly name: string = 'local';
  readonly osEnv: Environment;
  private _cwd: string;

  private constructor(osEnv: Environment, cwd?: string) {
    // After construction we never touch `process.cwd()` / `process.chdir()`
    // — all path resolution goes through `this._cwd`. The default seeds
    // from `process.cwd()` but callers can pin to anything via `withCwd`
    // (or supplying `cwd` directly).
    this._cwd = normalize(cwd ?? process.cwd());
    this.osEnv = osEnv;
  }

  /**
   * Construct a fresh `LocalKaos` after probing the host environment.
   *
   * Each call returns a new instance with its own `_cwd`; concurrent
   * callers can therefore operate on independent working directories
   * without polluting one another.
   */
  static async create(): Promise<LocalKaos> {
    const osEnv = await detectEnvironmentFromNode();
    return new LocalKaos(osEnv);
  }

  withCwd(cwd: string): LocalKaos {
    return new LocalKaos(this.osEnv, cwd);
  }

  private _resolvePath(path: string): string {
    if (isAbsolute(path)) return normalize(path);
    return join(this._cwd, path);
  }

  pathClass(): 'posix' | 'win32' {
    return isWindows ? 'win32' : 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return normalize(homedir());
  }

  getcwd(): string {
    return this._cwd;
  }

  /**
   * Change the working directory of this LocalKaos instance.
   *
   * Unlike Python's `os.chdir`, this is instance-scoped and never touches
   * `process.cwd()`. Child processes spawned via {@link exec} inherit this
   * instance's `_cwd`; concurrent LocalKaos instances each carry their own
   * independent cwd. If you need Python-compatible process-global cwd,
   * call `process.chdir(x)` directly.
   */
  async chdir(path: string): Promise<void> {
    const resolved = this._resolvePath(path);
    const s = await stat(resolved);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this._cwd = resolved;
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    const s = followSymlinks ? await stat(resolved) : await lstat(resolved);
    return {
      stMode: s.mode,
      stIno: s.ino,
      stDev: s.dev,
      stNlink: s.nlink,
      stUid: s.uid,
      stGid: s.gid,
      stSize: s.size,
      stAtime: s.atimeMs / 1000,
      stMtime: s.mtimeMs / 1000,
      stCtime: isWindows ? s.birthtimeMs / 1000 : s.ctimeMs / 1000,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await readdir(resolved);
    for (const entry of entries) {
      // Use join so root paths like "/" or "C:\\" don't produce "//entry"
      // or "C:\\\\entry" — join normalizes trailing separators correctly.
      yield join(resolved, entry);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    const patternParts = pattern.split('/');
    // Seed `visited` with basePath's own inode so that a symlink inside
    // basePath that points back at basePath is caught on its first
    // encounter (not on the second level — the "+1 depth" off-by-one
    // that would otherwise leak if the caller globs directly from the
    // loop root). `stat` failure here is tolerated: `_globWalk` will
    // hit the same error via readdir and return empty.
    const initVisited = new Set<string>();
    try {
      const rootStat = await stat(resolved);
      const rootKey = cycleKey(rootStat);
      if (rootKey !== null) initVisited.add(rootKey);
    } catch {
      // base does not exist / not accessible — walker handles via its own catch
    }
    yield* this._globWalk(resolved, patternParts, caseSensitive, initVisited);
  }

  // `visited` holds the `(stDev, stIno)` keys of directories on the
  // current descent path. Before recursing into a subdirectory, we
  // check its key against `visited`; if present we skip it (cycle
  // detected) and otherwise recurse with a fresh Set containing the
  // additional key. The per-recurse copy gives the check path-local
  // semantics: two legitimate symlinks to the same target in separate
  // branches both traverse, which is more permissive than Python stdlib
  // while still cycle-safe.
  // Same-directory self-recursion (e.g. `**` matching zero dirs with
  // pattern tail) passes `visited` unchanged — no descent, no cycle
  // risk.
  //
  // Windows note: Node's `fs.Stats.ino` returns `0` on filesystems
  // that don't support inodes (FAT/exFAT, some SMB/NFS mounts). If we
  // keyed on `ino=0`, every directory on such a drive would share the
  // key `"<dev>:0"` and the first would "visit" all others. The
  // module-level `cycleKey` helper returns `null` in that case, which
  // causes the call sites to skip visited tracking for that descent
  // — cycle safety is lost on those filesystems, but normal walking
  // works.
  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
    visited: Set<string>,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) {
      return;
    }

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      // `**` matches zero or more directory components.
      //
      // There are exactly two cases to handle:
      //   (a) `**` matches zero directories → continue at basePath with the
      //       remaining pattern parts (or yield basePath itself when `**`
      //       is the final segment).
      //   (b) `**` matches one or more directories → recurse into each
      //       subdirectory, keeping `**` (i.e. the full patternParts) at
      //       the front. The "zero directories" case is then re-evaluated
      //       at the subdirectory level by that recursive call.
      //
      // We must NOT additionally recurse with `remainingParts` on
      // subdirectories — that would double-count every match at depth ≥ 1
      // because case (a) inside the child recursion already yields those
      // results.
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive, visited);
      } else {
        // Pattern ends with `**`: yield basePath itself (zero-dir match).
        yield basePath;
      }

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        // Use join to avoid "//entry" when basePath is a filesystem root.
        const fullPath = join(basePath, entry);
        let entryStat;
        try {
          entryStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = cycleKey(entryStat);
          if (key !== null && visited.has(key)) continue;
          yield* this._globWalk(
            fullPath,
            patternParts,
            caseSensitive,
            key !== null ? new Set([...visited, key]) : visited,
          );
        } else if (remainingParts.length === 0) {
          // Pattern ends with `**`: non-directory entries match too
          // (since `**` matches "anything").
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!regex.test(entry)) {
          continue;
        }

        // Use join to avoid "//entry" when basePath is a filesystem root.
        const fullPath = join(basePath, entry);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else {
          let entryStat;
          try {
            entryStat = await stat(fullPath);
          } catch {
            continue;
          }
          if (entryStat.isDirectory()) {
            const key = cycleKey(entryStat);
            if (key !== null && visited.has(key)) continue;
            yield* this._globWalk(
              fullPath,
              remainingParts,
              caseSensitive,
              key !== null ? new Set([...visited, key]) : visited,
            );
          }
        }
      }
    }
  }

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const resolved = this._resolvePath(path);
    if (n === undefined) {
      return Buffer.from(await readFile(resolved));
    }
    const fh = await open(resolved, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await readFile(resolved);
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const buf = await readFile(resolved);
    const content = decodeTextWithErrors(buf, encoding, errors);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (i < lines.length - 1) {
        yield line + '\n';
      } else if (line !== '') {
        yield line;
      }
    }
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    const resolved = this._resolvePath(path);
    await writeFile(resolved, data);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const mode = options?.mode ?? 'w';
    if (mode === 'a') {
      await appendFile(resolved, data, encoding);
    } else {
      await writeFile(resolved, data, encoding);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;

    if (parents) {
      // `fs.mkdir(..., { recursive: true })` silently succeeds when the
      // target already exists — it does NOT raise EEXIST. To honor the
      // `existOk: false` semantics, we must probe for existence ourselves
      // before delegating to the recursive mkdir.
      if (!existOk) {
        try {
          const s = await stat(resolved);
          if (s.isDirectory()) {
            throw new KaosFileExistsError(`${resolved} already exists`);
          }
          // Path exists but is not a directory — let `mkdir` surface the
          // appropriate error (EEXIST/ENOTDIR) below.
        } catch (error: unknown) {
          if (error instanceof KaosFileExistsError) throw error;
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') throw error;
          // ENOENT: target doesn't exist yet — proceed to mkdir.
        }
      }
      await mkdir(resolved, { recursive: true });
      return;
    }

    // Non-recursive: fs.mkdir naturally throws EEXIST on collision.
    try {
      await mkdir(resolved);
    } catch (error: unknown) {
      if (
        existOk &&
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        // `existOk` only applies when the conflicting path is itself a
        // directory. If a regular file (or other non-directory) already
        // occupies the path, silently returning would be a lie — the
        // requested directory still does not exist. Surface the conflict
        // explicitly so callers cannot mistake "file collision" for
        // "directory already present".
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          throw new KaosFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      throw error;
    }
  }

  async exec(...args: string[]): Promise<KaosProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error('LocalKaos.exec(): at least one argument (the command to run) is required.');
    }
    const restArgs = args.slice(1);
    const child = spawn(command, restArgs, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX `detached:true` makes the child a process-group leader so
      // `LocalProcess.kill()` can signal the entire tree. No-op on Windows
      // (`taskkill /T` handles the tree there). We do not call `child.unref()`
      // because the parent still waits on the child's exit through `wait()`.
      detached: !isWindows,
    });
    await waitForSpawn(child);
    return new LocalProcess(child);
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'LocalKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);
    const child = spawn(command, restArgs, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      env,
    });
    await waitForSpawn(child);
    return new LocalProcess(child);
  }
}

// Wait for a freshly spawned ChildProcess to either emit 'spawn' (success) or
// 'error' (ENOENT / EACCES / etc.). Until this resolves, callers should not
// assume the child is running — they may otherwise write to the stdin of a
// process that never existed.
function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
