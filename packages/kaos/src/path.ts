import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { getCurrentKaos } from './current';
import { KaosValueError } from './errors';
import type { Kaos } from './kaos';
import type { StatResult } from './types';

type PathClass = 'posix' | 'win32';
type PathModule = typeof posixPath;

// S_IFMT mask and S_IFDIR/S_IFREG constants for mode checking
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/**
 * Return the path module matching the current Kaos path class.
 */
function getPathMod(pathClass: PathClass = getCurrentKaos().pathClass()): PathModule {
  return pathClass === 'win32' ? win32Path : posixPath;
}

function splitPathLexically(pathMod: PathModule, path: string): { root: string; parts: string[] } {
  const root = pathMod.parse(path).root;
  const tail = root.length > 0 ? path.slice(root.length) : path;
  return {
    root,
    parts: tail.split('/').filter((part) => part.length > 0),
  };
}

function splitPosixPart(path: string): { root: string; parts: string[] } {
  const normalized = path.replaceAll('\\', '/');
  const root =
    normalized.startsWith('//') && !normalized.startsWith('///') ? '//' : normalized.startsWith('/') ? '/' : '';
  const tail = root.length > 0 ? normalized.slice(root.length) : normalized;
  return {
    root,
    parts: tail.split('/').filter((part) => part.length > 0 && part !== '.'),
  };
}

function joinPosixPure(parts: string[]): string {
  let root = '';
  let pathParts: string[] = [];

  for (const part of parts) {
    if (part === '') continue;
    const parsed = splitPosixPart(part);
    if (parsed.root !== '') {
      root = parsed.root;
      pathParts = parsed.parts;
    } else {
      pathParts.push(...parsed.parts);
    }
  }

  if (root !== '') {
    return pathParts.length === 0 ? root : root + pathParts.join('/');
  }
  return pathParts.length === 0 ? '.' : pathParts.join('/');
}

interface Win32Part {
  drive: string;
  root: '' | '\\';
  parts: string[];
}

function splitWin32Part(path: string): Win32Part {
  const normalized = path.replaceAll('/', '\\');
  const parsed = win32Path.parse(normalized);
  let drive = '';
  let root: '' | '\\' = '';

  if (/^[A-Za-z]:/.test(parsed.root)) {
    drive = parsed.root.slice(0, 2);
    root = parsed.root.length > 2 ? '\\' : '';
  } else if (parsed.root.startsWith('\\\\')) {
    // UNC roots are already complete anchors, e.g. "\\server\\share\\".
    drive = parsed.root.endsWith('\\') ? parsed.root.slice(0, -1) : parsed.root;
    root = '\\';
  } else if (parsed.root === '\\' || parsed.root === '/') {
    root = '\\';
  }

  const tail = normalized.slice(parsed.root.length);
  return {
    drive,
    root,
    parts: tail.split('\\').filter((part) => part.length > 0 && part !== '.'),
  };
}

function formatWin32Pure(drive: string, root: '' | '\\', parts: string[]): string {
  const anchor = drive + root;
  if (anchor !== '') {
    return parts.length === 0 ? anchor : anchor + parts.join('\\');
  }
  return parts.length === 0 ? '.' : parts.join('\\');
}

function joinWin32Pure(parts: string[]): string {
  let drive = '';
  let root: '' | '\\' = '';
  let pathParts: string[] = [];

  for (const part of parts) {
    if (part === '') continue;
    const parsed = splitWin32Part(part);

    if (parsed.root !== '') {
      drive = parsed.drive !== '' ? parsed.drive : drive;
      root = parsed.root;
      pathParts = parsed.parts;
      continue;
    }

    if (parsed.drive !== '') {
      if (drive.toLowerCase() !== parsed.drive.toLowerCase()) {
        drive = parsed.drive;
        root = '';
        pathParts = parsed.parts;
      } else {
        pathParts.push(...parsed.parts);
      }
      continue;
    }

    pathParts.push(...parsed.parts);
  }

  return formatWin32Pure(drive, root, pathParts);
}

function joinPure(pathClass: PathClass, parts: string[]): string {
  return pathClass === 'win32' ? joinWin32Pure(parts) : joinPosixPure(parts);
}

function isWin32DriveRelative(path: string): boolean {
  return /^[A-Za-z]:(?:$|[^\\/])/.test(path);
}

/**
 * A path wrapper class that delegates all I/O operations to the current Kaos instance.
 * The path string is interpreted with the path class active at construction time.
 */
export class KaosPath {
  private _path: string;
  private _pathClass: PathClass;

  constructor(...args: string[]) {
    this._pathClass = getCurrentKaos().pathClass();
    if (args.length === 0) {
      this._path = '.';
    } else {
      const raw = joinPure(this._pathClass, args);
      this._path = this._pathClass === 'win32' ? raw.replaceAll('\\', '/') : raw;
    }
  }

  private static _from(path: string, pathClass: PathClass): KaosPath {
    const ret = new KaosPath();
    ret._path = path.replaceAll('\\', '/');
    ret._pathClass = pathClass;
    return ret;
  }

  private _currentKaos(operation: string): Kaos {
    const kaos = getCurrentKaos();
    const currentPathClass = kaos.pathClass();
    if (currentPathClass !== this._pathClass) {
      throw new KaosValueError(
        `Cannot ${operation} ${this._pathClass} path ${this._path} with ${currentPathClass} kaos`,
      );
    }
    if (this._pathClass === 'win32' && isWin32DriveRelative(this._path)) {
      throw new KaosValueError(
        `Cannot ${operation} drive-relative win32 path ${this._path}; use an absolute path like C:\\\\path or a path relative to cwd`,
      );
    }
    return kaos;
  }

  // --- Properties ---

  /** The final component of this path (like Python's Path.name). */
  get name(): string {
    return getPathMod(this._pathClass).basename(this._path);
  }

  /** The logical parent of this path (like Python's Path.parent). */
  get parent(): KaosPath {
    const dir = getPathMod(this._pathClass).dirname(this._path);
    return KaosPath._from(dir, this._pathClass);
  }

  // --- Path operations (sync, no I/O) ---

  isAbsolute(): boolean {
    return getPathMod(this._pathClass).isAbsolute(this._path);
  }

  joinpath(...other: string[]): KaosPath {
    return KaosPath._from(joinPure(this._pathClass, [this._path, ...other]), this._pathClass);
  }

  /** Division operator equivalent: join with another path segment. */
  div(other: string | KaosPath): KaosPath {
    if (other instanceof KaosPath && other._pathClass !== this._pathClass) {
      throw new KaosValueError(`Cannot join ${other._pathClass} path to ${this._pathClass} path`);
    }
    const otherStr = other instanceof KaosPath ? other.toString() : other;
    return this.joinpath(otherStr);
  }

  /**
   * Canonicalize the path without touching the filesystem.
   * Makes the path absolute (relative to cwd) and resolves '..' segments.
   */
  canonical(): KaosPath {
    const kaos = this._currentKaos('canonicalize');
    const pathMod = getPathMod(this._pathClass);

    if (pathMod.isAbsolute(this._path)) {
      return KaosPath._from(pathMod.normalize(this._path), this._pathClass);
    }
    const cwd = kaos.getcwd();
    if (!pathMod.isAbsolute(cwd)) {
      throw new KaosValueError(`Cannot canonicalize ${this._path} against non-absolute cwd ${cwd}`);
    }
    const abs = pathMod.resolve(cwd, this._path);
    return KaosPath._from(pathMod.normalize(abs), this._pathClass);
  }

  /** Compute a relative path from `other` to this path. */
  relativeTo(other: KaosPath): KaosPath {
    if (other._pathClass !== this._pathClass) {
      throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
    }
    const pathMod = getPathMod(this._pathClass);
    const target = splitPathLexically(pathMod, this._path);
    const base = splitPathLexically(pathMod, other.toString());

    const sameRoot =
      this._pathClass === 'win32'
        ? target.root.toLowerCase() === base.root.toLowerCase()
        : target.root === base.root;

    if (!sameRoot) {
      throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
    }
    if (base.parts.length > target.parts.length) {
      throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
    }
    for (let i = 0; i < base.parts.length; i++) {
      const targetPart = target.parts[i];
      const basePart = base.parts[i];
      const samePart =
        this._pathClass === 'win32'
          ? targetPart?.toLowerCase() === basePart?.toLowerCase()
          : targetPart === basePart;
      if (!samePart) {
        throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
      }
    }

    const relParts = target.parts.slice(base.parts.length);
    return KaosPath._from(
      relParts.length === 0 ? '.' : relParts.join('/'),
      this._pathClass,
    );
  }

  /** Expand leading ~ to the home directory. */
  expanduser(): KaosPath {
    if (this._path === '~' || this._path.startsWith('~/') || this._path.startsWith('~\\')) {
      const kaos = this._currentKaos('expand');
      const home = kaos.gethome();
      if (this._path === '~') {
        return KaosPath._from(home, this._pathClass);
      }
      const rest = this._path.slice(2); // strip "~/" or "~\"
      return KaosPath._from(joinPure(this._pathClass, [home, rest]), this._pathClass);
    }
    return KaosPath._from(this._path, this._pathClass);
  }

  // --- Static methods ---

  static home(): KaosPath {
    const kaos = getCurrentKaos();
    return new KaosPath(kaos.gethome());
  }

  static cwd(): KaosPath {
    const kaos = getCurrentKaos();
    return new KaosPath(kaos.getcwd());
  }

  // --- Conversion ---

  /** Create a KaosPath from a local filesystem path string. */
  static fromLocalPath(localPath: string): KaosPath {
    return new KaosPath(localPath);
  }

  /** Return the underlying path string for local filesystem use. */
  toLocalPath(): string {
    if (this._pathClass === 'win32') {
      return this._path.replaceAll('/', '\\');
    }
    return this._path;
  }

  toString(): string {
    return this._path;
  }

  equals(other: KaosPath): boolean {
    return this._pathClass === other._pathClass && this._path === other.toString();
  }

  // --- File operations (async, delegate to getCurrentKaos) ---

  /** Get stat information for this path. */
  async stat(options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const kaos = this._currentKaos('stat');
    return kaos.stat(this._path, options);
  }

  /** Check if this path exists on the filesystem. */
  async exists(options?: { followSymlinks?: boolean }): Promise<boolean> {
    const kaos = this._currentKaos('check');
    try {
      await kaos.stat(this._path, options);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if this path points to a regular file. */
  async isFile(options?: { followSymlinks?: boolean }): Promise<boolean> {
    const kaos = this._currentKaos('check');
    try {
      const s = await kaos.stat(this._path, options);
      return (s.stMode & S_IFMT) === S_IFREG;
    } catch {
      return false;
    }
  }

  /** Check if this path points to a directory. */
  async isDir(options?: { followSymlinks?: boolean }): Promise<boolean> {
    const kaos = this._currentKaos('check');
    try {
      const s = await kaos.stat(this._path, options);
      return (s.stMode & S_IFMT) === S_IFDIR;
    } catch {
      return false;
    }
  }

  /** Iterate over entries in this directory. */
  async *iterdir(): AsyncGenerator<KaosPath> {
    const kaos = this._currentKaos('iterate');
    for await (const entry of kaos.iterdir(this._path)) {
      yield KaosPath._from(entry, this._pathClass);
    }
  }

  /** Glob for entries matching a pattern under this path. */
  async *glob(pattern: string, options?: { caseSensitive?: boolean }): AsyncGenerator<KaosPath> {
    const kaos = this._currentKaos('glob');
    for await (const match of kaos.glob(this._path, pattern, options)) {
      yield KaosPath._from(match, this._pathClass);
    }
  }

  /** Read the file content as a Buffer. */
  async readBytes(n?: number): Promise<Buffer> {
    const kaos = this._currentKaos('read');
    return kaos.readBytes(this._path, n);
  }

  /** Read the file content as a string. */
  async readText(options?: {
    encoding?: BufferEncoding;
    errors?: 'strict' | 'replace' | 'ignore';
  }): Promise<string> {
    const kaos = this._currentKaos('read');
    return kaos.readText(this._path, options);
  }

  /** Yield lines from the file one by one. */
  async *readLines(options?: {
    encoding?: BufferEncoding;
    errors?: 'strict' | 'replace' | 'ignore';
  }): AsyncGenerator<string> {
    const kaos = this._currentKaos('read');
    for await (const line of kaos.readLines(this._path, options)) {
      yield line;
    }
  }

  /** Write binary data to this path, return the number of bytes written. */
  async writeBytes(data: Buffer): Promise<number> {
    const kaos = this._currentKaos('write');
    return kaos.writeBytes(this._path, data);
  }

  /** Write text to this path, return the number of characters written. */
  async writeText(
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const kaos = this._currentKaos('write');
    return kaos.writeText(this._path, data, options);
  }

  /** Append text to this path, return the number of characters written. */
  async appendText(data: string, options?: { encoding?: BufferEncoding }): Promise<number> {
    const kaos = this._currentKaos('append');
    const writeOpts: { mode: 'a'; encoding?: BufferEncoding } = { mode: 'a' };
    if (options?.encoding !== undefined) {
      writeOpts.encoding = options.encoding;
    }
    return kaos.writeText(this._path, data, writeOpts);
  }

  /** Create this path as a directory. */
  async mkdir(options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const kaos = this._currentKaos('mkdir');
    await kaos.mkdir(this._path, options);
  }
}
