/**
 * ACP-backed `IHostFileSystem` — Session-scoped `IHostFileSystem` that routes
 * text file reads/writes through the ACP client (`fs.readTextFile` /
 * `fs.writeTextFile`, keyed by this session's `sessionId`) and delegates every
 * other operation (binary IO, stat/readdir/mkdir/remove, exclusive create) to a
 * node-local inner backend.
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

import {
  HostFileSystem,
  type HostDirEntry,
  type HostFileStat,
  IHostFileSystem,
  InstantiationType,
  ISessionContext,
  LifecycleScope,
  registerScopedService,
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

export class AcpHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  /**
   * Local inner backend for every operation ACP `fs` does not model (binary IO,
   * directory ops, stat, exclusive create). `HostFileSystem` is stateless (no
   * DI dependencies), so constructing it directly is safe.
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

  appendText(path: string, data: string): Promise<void> {
    return this.inner.appendText(path, data);
  }

  async *readLines(path: string, options?: ReadTextOptions): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    yield* splitLinesKeepingTerminator(text);
  }

  readBytes(path: string, n?: number): Promise<Uint8Array> {
    return this.inner.readBytes(path, n);
  }

  writeBytes(path: string, data: Uint8Array): Promise<void> {
    return this.inner.writeBytes(path, data);
  }

  createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    return this.inner.createExclusive(path, data);
  }

  stat(path: string): Promise<HostFileStat> {
    return this.inner.stat(path);
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
  InstantiationType.Delayed,
  'acp',
);
