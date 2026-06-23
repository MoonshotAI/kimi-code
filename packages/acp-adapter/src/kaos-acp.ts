/**
 * `AcpKaos` — a {@link Kaos} that bridges file reads/writes through the
 * ACP client (e.g. Zed's unsaved-buffer view of the workspace) and
 * delegates every other operation to an `inner` {@link Kaos} (typically
 * a {@link LocalKaos}).
 *
 * Why a separate class instead of an `if (acpAvailable) { ... }` branch
 * inside `LocalKaos`? Because the SDK and the tooling code talk to a
 * single {@link Kaos} reference, and dependency-inverting the FS bridge
 * is the cheapest way to keep capability gating *out* of every tool.
 * When the client doesn't advertise `fs.read_text_file` / `write_text_file`
 * we simply never wrap — tools observe a plain `LocalKaos` and Phase 6
 * is invisible to them.
 *
 * Construction is cheap (no I/O, no probes); one per {@link AcpSession}
 * is the intended unit, but reusing across prompts is also fine.
 */

import { Buffer } from 'node:buffer';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import {
  KaosError,
  type Environment,
  type Kaos,
  type KaosProcess,
  type StatResult,
} from '@moonshot-ai/kaos';

/**
 * `Kaos` that routes `read*` / `write*` through the ACP reverse-RPC
 * channel and delegates everything else to `inner`.
 *
 * Path semantics: the ACP spec requires absolute paths for
 * `fs/readTextFile` and `fs/writeTextFile`. This class does NOT resolve
 * relative paths — callers are expected to feed already-absolute paths
 * (mirrors `LocalKaos._resolvePath`'s public surface). If you need
 * cwd-relative resolution, route through `inner.normpath` first or use
 * `withCwd()` to bind a base.
 */
export class AcpKaos implements Kaos {
  constructor(
    private readonly conn: AgentSideConnection,
    private readonly sessionId: string,
    private readonly inner: Kaos,
  ) {}

  // ── identity ────────────────────────────────────────────────────────

  /** Distinguishable name so logs / `name` checks can disambiguate. */
  get name(): string {
    return `acp(${this.inner.name})`;
  }

  get osEnv(): Environment {
    return this.inner.osEnv;
  }

  // ── path operations: delegate to inner ─────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return this.inner.pathClass();
  }

  normpath(path: string): string {
    return this.inner.normpath(path);
  }

  gethome(): string {
    return this.inner.gethome();
  }

  getcwd(): string {
    return this.inner.getcwd();
  }

  chdir(path: string): Promise<void> {
    return this.inner.chdir(path);
  }

  /**
   * Return a fresh `AcpKaos` wrapping the inner Kaos's cwd-derived
   * instance — so a `chdir` followed by `readText('relative.ts')`
   * continues to hit the ACP bridge rather than silently dropping back
   * to local filesystem reads.
   */
  withCwd(cwd: string): Kaos {
    return new AcpKaos(this.conn, this.sessionId, this.inner.withCwd(cwd));
  }

  withEnv(env: Record<string, string>): Kaos {
    return new AcpKaos(this.conn, this.sessionId, this.inner.withEnv(env));
  }

  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    return this.inner.stat(path, options);
  }

  iterdir(path: string): AsyncGenerator<string> {
    return this.inner.iterdir(path);
  }

  glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    return this.inner.glob(path, pattern, options);
  }

  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    return this.inner.mkdir(path, options);
  }

  // ── reads: route through ACP `fs/readTextFile` ─────────────────────

  /**
   * Read the file via ACP. Decoding parameters (`encoding`, `errors`)
   * are accepted for interface compatibility but ignored — the ACP
   * `fs/readTextFile` response is already a decoded string, so we have
   * no bytes to re-decode. Tools that need byte-exact decoding control
   * should be routed through a non-ACP Kaos.
   */
  async readText(
    path: string,
    _options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const rpcPath = this.toClientPath(path);
    try {
      const resp = await this.conn.readTextFile({ sessionId: this.sessionId, path: rpcPath });
      return resp.content;
    } catch (err) {
      throw wrapKaosError(`acp: readTextFile failed for ${rpcPath}`, err);
    }
  }

  /**
   * Binary reads bypass the ACP text RPC by design: `fs/readTextFile`
   * returns a decoded string and would corrupt or reject non-UTF-8
   * payloads (images, video, archives — anything `ReadMediaFile` may
   * touch). The ACP bridge only owns the *text* surface; raw bytes
   * stay on the local filesystem via `inner`.
   */
  readBytes(path: string, n?: number): Promise<Buffer> {
    return this.inner.readBytes(path, n);
  }

  /**
   * Return a small UTF-8 header derived from the same ACP text source as
   * `readText` / `readLines`, used only by text-read callers for sniffing.
   * Keep `readBytes` local so binary callers such as ReadMediaFile stay safe.
   *
   * Bounded to the first line via ACP `line` / `limit` so a sniff never
   * transfers the whole file: `detectFileType` only needs the leading magic
   * bytes (≤16) plus a NUL scan, both of which line 1 covers, and line 1 is
   * the smallest unit `fs/readTextFile` can return. A non-compliant client
   * that ignores `limit` is still capped to line 1 by `readLineRange`.
   */
  async readTextPreview(path: string, n: number): Promise<Buffer> {
    const first = await this.readLineRange(path, { startLine: 1, maxLines: 1 }).next();
    const text = first.value ?? '';
    return Buffer.from(text.slice(0, n), 'utf8');
  }

  /**
   * Yield lines from the file, each terminated by its `\n` (the final
   * line has no terminator if the file did not end with `\n`). Matches
   * {@link LocalKaos.readLines} so tools that depend on line terminators
   * (e.g. {@link ReadTool}, which renders CRLF endings) behave identically
   * whether the underlying Kaos is local or ACP-bridged.
   */
  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    yield* splitLinesKeepTerminator(text);
  }

  /**
   * Yield a line range from the file via ACP's native `line` / `limit`
   * parameters on `fs/readTextFile`, so a compliant client can return
   * only the requested window instead of the whole file. `startLine` is
   * 1-based (ACP convention).
   *
   * `encoding` / `errors` are accepted for interface compatibility but
   * ignored — the ACP response is already a decoded string. If the
   * client does not honor `line` / `limit` and returns more than
   * `maxLines` lines, the output is truncated to `maxLines` defensively
   * so a non-compliant client cannot turn a range read into a full-file
   * read.
   */
  async *readLineRange(
    path: string,
    options: { startLine: number; maxLines: number; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const rpcPath = this.toClientPath(path);
    let text: string;
    try {
      const resp = await this.conn.readTextFile({
        sessionId: this.sessionId,
        path: rpcPath,
        line: options.startLine,
        limit: options.maxLines,
      });
      text = resp.content;
    } catch (error) {
      throw wrapKaosError(`acp: readTextFile failed for ${rpcPath}`, error);
    }
    yield* splitLinesKeepTerminator(text, options.maxLines);
  }

  // ── writes: route through ACP `fs/writeTextFile` ───────────────────

  /**
   * Write text via ACP. `encoding` is ignored — ACP wire format is
   * always UTF-8 string content. `mode: 'a'` (append) emulates with a
   * read-then-write fallback: ACP has no native append, and the
   * intended audience (unsaved-buffer scratchpads) rarely needs it.
   * If the prior read fails because the file does not exist, the write
   * proceeds as if the existing content were empty — matching Python
   * `open('a')` which creates new files. Any other read failure
   * (permission, transport, internal) propagates so we never silently
   * destroy existing content.
   *
   * Returns `data.length` (chars) to match {@link LocalKaos.writeText}'s
   * contract.
   */
  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    if (options?.mode === 'a') {
      let existing = '';
      try {
        existing = await this.readText(path);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        existing = '';
      }
      await this.acpWrite(path, existing + data);
      return data.length;
    }
    await this.acpWrite(path, data);
    return data.length;
  }

  /**
   * Write raw bytes via ACP by interpreting them as UTF-8. Non-UTF-8
   * payloads will be lossy; the intended use case is text writes
   * (Read/Write/Edit tools), not binary streaming.
   */
  async writeBytes(path: string, data: Buffer): Promise<number> {
    await this.acpWrite(path, data.toString('utf8'));
    return data.byteLength;
  }

  private async acpWrite(path: string, content: string): Promise<void> {
    const rpcPath = this.toClientPath(path);
    try {
      await this.conn.writeTextFile({ sessionId: this.sessionId, path: rpcPath, content });
    } catch (err) {
      throw wrapKaosError(`acp: writeTextFile failed for ${rpcPath}`, err);
    }
  }

  private toClientPath(path: string): string {
    if (this.inner.pathClass() !== 'win32') return path;
    return path.replaceAll('/', '\\');
  }

  // ── process execution: delegate to inner ───────────────────────────

  exec(...args: string[]): Promise<KaosProcess> {
    return this.inner.exec(...args);
  }

  execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    return this.inner.execWithEnv(args, env);
  }
}

/**
 * Split a decoded string into lines, each terminated by its `\n` (the
 * final line has no terminator if the string did not end with `\n`).
 * When `maxLines` is given, stop after yielding that many lines — a
 * defensive cap for ACP clients that ignore the `limit` parameter.
 */
function* splitLinesKeepTerminator(text: string, maxLines?: number): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  let yielded = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x0a /* \n */) continue;
    yield text.slice(start, i + 1);
    yielded += 1;
    if (maxLines !== undefined && yielded >= maxLines) return;
    start = i + 1;
  }
  if (start < text.length && (maxLines === undefined || yielded < maxLines)) {
    yield text.slice(start);
  }
}

/**
 * Build a `KaosError` wrapping a raw RPC failure. We can't use the
 * `Error(message, { cause })` overload here because {@link KaosError}'s
 * constructor only accepts `(message: string)` (see
 * `packages/kaos/src/errors.ts`). Instead we synthesize the message
 * with the original error's `.message` appended and assign `.cause`
 * post-construction so structured-clone consumers (logs, debuggers)
 * can still walk the chain.
 */
function wrapKaosError(prefix: string, cause: unknown): KaosError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const err = new KaosError(`${prefix}: ${causeMessage}`);
  // Mutating `cause` after construction is the cheapest way to preserve
  // it without touching the kaos package (denylist forbids edits there).
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

/**
 * Return true iff `err` is a structured "file does not exist" failure on
 * the read side of an ACP append-mode write. We only trust the ACP SDK's
 * `RequestError.resourceNotFound` code (`-32002`), optionally wrapped in a
 * `KaosError` by `readText` above. Message substring matching is intentionally
 * avoided: wrapper messages include the path, so a path or non-ENOENT failure
 * mentioning "not found" could otherwise be misclassified and cause append
 * mode to overwrite existing content.
 */
function isNotFoundError(err: unknown): boolean {
  const visited = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !visited.has(cur)) {
    visited.add(cur);
    if (cur instanceof RequestError && cur.code === -32002) return true;
    if (cur instanceof Error) {
      cur = (cur as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}
