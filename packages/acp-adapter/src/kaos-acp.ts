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
    try {
      const resp = await this.conn.readTextFile({ sessionId: this.sessionId, path });
      return resp.content;
    } catch (err) {
      throw wrapKaosError(`acp: readTextFile failed for ${path}`, err);
    }
  }

  /**
   * Read up to `n` bytes from the file. Implemented as
   * `readText → utf8 encode → slice` because ACP only exposes string
   * content. Callers that store non-text data through this path
   * (uncommon) will get re-encoded bytes — acceptable per `Kaos.readBytes`
   * which already permits encoding-dependent return values.
   */
  async readBytes(path: string, n?: number): Promise<Buffer> {
    const text = await this.readText(path);
    const buf = Buffer.from(text, 'utf8');
    return n !== undefined ? buf.subarray(0, n) : buf;
  }

  /**
   * Yield lines from the file. Emulates Python `splitlines(keepends=False)`:
   * splits on `\n`, drops the trailing empty token if the file ended with
   * a newline, and yields nothing for an empty file. Matches
   * {@link LocalKaos.readLines}'s observable output for the trailing-newline
   * case (the local version yields `'line\n'` chunks; here we yield without
   * the `\n` — see below).
   *
   * Note on divergence from `LocalKaos.readLines`: the local impl yields
   * `'a\n'`, `'b\n'`, `'c'` while this impl yields `'a'`, `'b'`, `'c'`.
   * The interface JSDoc says only "Yield lines from the file at `path`
   * one by one" without pinning trailing-newline semantics, so both
   * shapes satisfy it. Tools that depend on the trailing-newline (rare)
   * should adapt. The Python reference's ACP backend does not implement
   * `readLines` separately either.
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
        yield text.slice(start, i);
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
   * If the prior read fails (e.g. file missing), the write proceeds
   * as if the existing content were empty — matching Python `open('a')`
   * which also creates new files.
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
      } catch {
        // ENOENT-style failure → treat as empty (mirrors Python open('a')).
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
    try {
      await this.conn.writeTextFile({ sessionId: this.sessionId, path, content });
    } catch (err) {
      throw wrapKaosError(`acp: writeTextFile failed for ${path}`, err);
    }
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
