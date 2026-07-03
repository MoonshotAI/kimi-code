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

import { assertPathInRoots } from './path-boundary';

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
    /**
     * Canonical (realpath-resolved) workspace roots this AcpKaos
     * treats as authoritative: `[cwd, ...additionalDirectories]`.
     * Set at construction time so the per-call hot path only
     * resolves the target, not the roots. Must be the output of
     * {@link resolveCanonicalRoots} — caller is responsible for
     * realpath'ing the supplied cwd + additionalDirectories up front
     * (see `maybeBuildAcpKaos` in `server.ts`).
     *
     * Carried unchanged through {@link withCwd} / {@link withEnv} —
     * the effective root set is session-scoped, not cwd-scoped.
     */
    private readonly effectiveRoots: readonly string[],
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
   *
   * The effective root set (this adapter's `additionalDirectories`
   * boundary) is **session-scoped**, not cwd-scoped, so it carries
   * forward unchanged — changing `inner.withCwd()` does not retune
   * which paths are allowed.
   */
  withCwd(cwd: string): Kaos {
    return new AcpKaos(this.conn, this.sessionId, this.inner.withCwd(cwd), this.effectiveRoots);
  }

  withEnv(env: Record<string, string>): Kaos {
    return new AcpKaos(this.conn, this.sessionId, this.inner.withEnv(env), this.effectiveRoots);
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    await assertPathInRoots(path, this.effectiveRoots, 'stat');
    return this.inner.stat(path, options);
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    // Anchor the check before yielding so callers that never consume
    // the iterator still see the boundary violation.
    await assertPathInRoots(path, this.effectiveRoots, 'iterdir');
    yield* this.inner.iterdir(path);
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    await assertPathInRoots(path, this.effectiveRoots, 'glob');
    yield* this.inner.glob(path, pattern, options);
  }

  async mkdir(
    path: string,
    options?: { parents?: boolean; existOk?: boolean },
  ): Promise<void> {
    await assertPathInRoots(path, this.effectiveRoots, 'mkdir');
    await this.inner.mkdir(path, options);
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
    await assertPathInRoots(path, this.effectiveRoots, 'readText');
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
   *
   * Even though the bytes go to `inner`, the path is still subject
   * to the effective-root check — without that, a model could read
   * `/etc/passwd` bytes by routing through the binary surface. The
   * `additionalDirectories` boundary is about scope, not surface.
   */
  async readBytes(path: string, n?: number): Promise<Buffer> {
    await assertPathInRoots(path, this.effectiveRoots, 'readBytes');
    return this.inner.readBytes(path, n);
  }

  /**
   * Return a small UTF-8 header derived from the same ACP text source as
   * `readText` / `readLines`, used only by text-read callers for sniffing.
   * Keep `readBytes` local so binary callers such as ReadMediaFile stay safe.
   */
  async readTextPreview(path: string, n: number): Promise<Buffer> {
    const text = await this.readText(path);
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
    if (text.length === 0) return;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x0a /* \n */) {
        yield text.slice(start, i + 1);
        start = i + 1;
      }
    }
    if (start < text.length) yield text.slice(start);
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
    // Single boundary check for the outer path, regardless of mode.
    // The append-mode's read-then-write fallback re-checks the same
    // target via readText, which would otherwise double-resolve and
    // race the same canonical path twice. The outer check is what
    // gates the write; the inner read is a fallback for "file does
    // not exist yet", not a separate authorization surface.
    await assertPathInRoots(path, this.effectiveRoots, 'writeText');
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
    await assertPathInRoots(path, this.effectiveRoots, 'writeBytes');
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
