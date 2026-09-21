/**
 * ACP-backed `IHostFileSystem` — Session-scoped `IHostFileSystem` that routes
 * text file reads/writes through the ACP client (`fs.readTextFile` /
 * `fs.writeTextFile`, keyed by this session's `sessionId`) and delegates the
 * remaining operations (binary reads, stat/realpath/readdir/mkdir/remove) to
 * a node-local inner backend. Byte writes are bridged through the client when
 * the payload decodes as UTF-8 or BOM'd UTF-16 text; an exclusive create is
 * emulated against the client buffer for text payloads when both text
 * capabilities exist, and binary payloads check the client for existence
 * before falling back to the atomic local create.
 *
 * Registered at Session scope so it shadows the App-scope node-local
 * `IHostFileSystem` for Session- and Agent-scope consumers (the os file tools),
 * while App-scope consumers (persistence, skill loading, workspace registry)
 * keep using the real local disk.
 *
 * Lives in `acp-server` (not `agent-core-v2`) because it is ACP-specific: the
 * engine stays agnostic of the ACP client, and only this host binds the client
 * connection.
 */

import { RequestError } from '@agentclientprotocol/sdk';
import {
  classifyTextSample,
  HostFileSystem,
  type HostDirEntry,
  type HostFileStat,
  IHostFileSystem,
  ISessionContext,
  LifecycleScope,
  registerScopedService,
  ScopeActivation,
} from '@moonshot-ai/agent-core-v2';

import { IAcpConnection } from './acpConnection';

/** Options type lifted from `IHostFileSystem.readText` / `readLines`. */
type ReadTextOptions = NonNullable<Parameters<IHostFileSystem['readText']>[1]>;

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.codePointAt(i) === 0x0a) {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) {
    yield text.slice(start);
  }
}

function isResourceNotFound(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32002;
}

function isLocalNotFound(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if ((current as { code?: unknown }).code === 'ENOENT') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Decode a byte payload into text the ACP client can carry: UTF-8 directly,
 * BOM'd UTF-16 after decoding. A leading BOM is kept as U+FEFF in the
 * forwarded text so the client writes it back out. The classifier sees the
 * complete payload, so a NUL or a control-byte majority anywhere — not only
 * in a leading sample — marks the payload binary. The classifier's encoding
 * verdict is honored: UTF-8 decoding is only attempted for UTF-8 payloads,
 * and UTF-16 is only bridged when a BOM marks the byte order. Binary,
 * BOM-less UTF-16 (its NUL pattern would otherwise decode as a NUL-filled
 * UTF-8 string), and anything not cleanly decodable return undefined so the
 * caller keeps the payload on the local binary backend.
 */
function decodeBridgeableText(data: Uint8Array): string | undefined {
  const classification = classifyTextSample(data);
  if (classification.isBinary) {
    return undefined;
  }
  if (classification.encoding === 'utf-8') {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      return undefined;
    }
  }
  const encoding =
    data[0] === 0xff && data[1] === 0xfe && !(data[2] === 0x00 && data[3] === 0x00)
      ? ('utf-16le' as const)
      : data[0] === 0xfe && data[1] === 0xff
        ? ('utf-16be' as const)
        : undefined;
  if (encoding === undefined) {
    return undefined;
  }
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return undefined;
  }
}

export class AcpHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  /**
   * Local inner backend for every operation the ACP `fs` protocol cannot
   * express (binary IO, stat, realpath, directory ops), plus capability
   * fallbacks for text operations.
   */
  private readonly inner = new HostFileSystem();

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAcpConnection private readonly connection: IAcpConnection,
  ) {}

  async readText(path: string, options?: ReadTextOptions): Promise<string> {
    if (!this.connection.fsReadTextFile) {
      return this.inner.readText(path, options);
    }
    // ACP `fs.readTextFile` returns already-decoded UTF-8 text, so the
    // `encoding`/`errors` decode options are a no-op here.
    const { content } = await this.connection
      .get()
      .readTextFile({ sessionId: this.ctx.sessionId, path });
    return content;
  }

  async writeText(path: string, data: string): Promise<void> {
    if (!this.connection.fsWriteTextFile) {
      return this.inner.writeText(path, data);
    }
    await this.connection
      .get()
      .writeTextFile({ sessionId: this.ctx.sessionId, path, content: data });
  }

  /**
   * ACP has no append RPC. When both text capabilities are available, emulate
   * append against the client's current buffer; otherwise preserve local
   * append semantics. A structured ACP resource-not-found read means an empty
   * client file — unless the path exists on the local backend (a local-only
   * file whose bytes the client never saw), in which case the append falls
   * back to the local backend so the established backing store keeps the
   * bytes. All other read failures are propagated.
   */
  async appendText(path: string, data: string): Promise<void> {
    if (!this.connection.fsReadTextFile || !this.connection.fsWriteTextFile) {
      return this.inner.appendText(path, data);
    }
    let existing: string | undefined;
    try {
      existing = await this.readText(path);
    } catch (error) {
      if (!isResourceNotFound(error)) throw error;
      if (await this.localHasFile(path)) {
        return this.inner.appendText(path, data);
      }
    }
    await this.writeText(path, (existing ?? '') + data);
  }

  async *readLines(path: string, options?: ReadTextOptions): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    yield* splitLinesKeepingTerminator(text);
  }

  readBytes(path: string, n?: number): Promise<Uint8Array> {
    return this.inner.readBytes(path, n);
  }

  /**
   * Bridge text payloads through the client whenever they decode cleanly.
   * Binary data stays on the local backend rather than being silently
   * replaced with U+FFFD.
   */
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    if (!this.connection.fsWriteTextFile) {
      return this.inner.writeBytes(path, data);
    }
    const text = decodeBridgeableText(data);
    if (text === undefined) {
      return this.inner.writeBytes(path, data);
    }
    await this.writeText(path, text);
  }

  /**
   * ACP has no create-exclusive RPC. Text payloads emulate it against the
   * client buffer so the existence check and the write share one backing
   * source: an existing client file reports false, a resource-not-found read
   * means the create can proceed through the client — after a final local
   * lstat re-check (entry presence, so dangling symlinks count as existing;
   * only a genuine not-found counts as absent, other failures propagate), so
   * a path that exists on the server-local backend (or appears during the
   * append pre-check race) is reported taken instead of
   * being shadowed by a client-side create. Non-text payloads check the
   * client for the same reason and only fall back to the atomic local path
   * when both backends report the path missing.
   */
  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    if (!this.connection.fsReadTextFile || !this.connection.fsWriteTextFile) {
      return this.inner.createExclusive(path, data);
    }
    if (await this.clientHasFile(path)) {
      return false;
    }
    const text = decodeBridgeableText(data);
    if (text === undefined) {
      return this.inner.createExclusive(path, data);
    }
    if (await this.localHasFile(path)) {
      return false;
    }
    await this.writeText(path, text);
    return true;
  }

  private async clientHasFile(path: string): Promise<boolean> {
    try {
      await this.readText(path);
      return true;
    } catch (error) {
      if (!isResourceNotFound(error)) throw error;
      return false;
    }
  }

  private async localHasFile(path: string): Promise<boolean> {
    try {
      await this.inner.lstat(path);
      return true;
    } catch (error) {
      if (isLocalNotFound(error)) return false;
      throw error;
    }
  }

  stat(path: string): Promise<HostFileStat> {
    return this.inner.stat(path);
  }

  lstat(path: string): Promise<HostFileStat> {
    return this.inner.lstat(path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }

  readdir(path: string): Promise<readonly HostDirEntry[]> {
    return this.inner.readdir(path);
  }

  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    return this.inner.mkdir(path, options);
  }

  remove(path: string): Promise<void> {
    return this.inner.remove(path);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IHostFileSystem,
  AcpHostFileSystem,
  ScopeActivation.OnDemand,
  'acp',
);
