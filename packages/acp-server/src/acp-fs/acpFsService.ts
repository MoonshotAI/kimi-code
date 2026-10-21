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

  private readonly inner = new HostFileSystem();

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAcpConnection private readonly connection: IAcpConnection,
  ) {}

  async readText(path: string, options?: ReadTextOptions): Promise<string> {
    if (!this.connection.fsReadTextFile) {
      return this.inner.readText(path, options);
    }
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
