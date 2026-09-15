/**
 * ACP-backed `IHostFileSystem` — Session-scoped `IHostFileSystem` that routes
 * text file reads/writes through the ACP client (`fs.readTextFile` /
 * `fs.writeTextFile`, keyed by this session's `sessionId`) and delegates every
 * other operation (binary IO, stat/realpath/readdir/mkdir/remove, exclusive
 * create) to a node-local inner backend.
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

export class AcpHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  /**
   * Local inner backend for every operation the ACP `fs` protocol cannot
   * express (binary IO, stat, realpath, directory ops, exclusive create),
   * plus capability fallbacks for text operations.
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
   * append semantics. A structured ACP resource-not-found means an empty
   * client file, while all other read failures are propagated.
   */
  async appendText(path: string, data: string): Promise<void> {
    if (!this.connection.fsReadTextFile || !this.connection.fsWriteTextFile) {
      return this.inner.appendText(path, data);
    }
    let existing = '';
    try {
      existing = await this.readText(path);
    } catch (error) {
      if (!isResourceNotFound(error)) throw error;
    }
    await this.writeText(path, existing + data);
  }

  async *readLines(path: string, options?: ReadTextOptions): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    yield* splitLinesKeepingTerminator(text);
  }

  readBytes(path: string, n?: number): Promise<Uint8Array> {
    return this.inner.readBytes(path, n);
  }

  /**
   * Bridge byte writes only when the payload is valid UTF-8. Binary data stays
   * on the local backend rather than being silently replaced with U+FFFD.
   */
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    if (!this.connection.fsWriteTextFile) {
      return this.inner.writeBytes(path, data);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      return this.inner.writeBytes(path, data);
    }
    await this.writeText(path, text);
  }

  createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    return this.inner.createExclusive(path, data);
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
