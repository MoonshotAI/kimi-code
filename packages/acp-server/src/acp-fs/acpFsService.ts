import { dirname } from 'node:path';

import { RequestError } from '@agentclientprotocol/sdk';
import {
  HostFsError,
  isHostFsNotDirectory,
  isHostFsNotFound,
  OsFsErrors,
} from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import {
  classifyTextSample,
  HostFileSystem,
  type HostDirEntry,
  type HostFileHead,
  type HostFileStat,
  type HostWalkOptions,
  type HostWalkVisitor,
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

function isLocalNotFound(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if ((current as { code?: unknown }).code === 'ENOENT') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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
    try {
      await this.connection
        .get()
        .writeTextFile({ sessionId: this.ctx.sessionId, path, content: data });
    } catch (error) {
      const parent = dirname(path);
      const parentStat = await this.inner.stat(parent).catch((statError: unknown) => {
        throw isHostFsNotFound(statError) || isHostFsNotDirectory(statError) ? statError : error;
      });
      if (!parentStat.isDirectory) {
        throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_DIRECTORY, `write failed: parent is not a directory: ${parent}`, {
          details: { path: parent, op: 'write' },
          cause: error,
        });
      }
      throw error;
    }
  }

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

  readFileHead(path: string, maxBytes: number): Promise<HostFileHead> {
    return this.inner.readFileHead(path, maxBytes);
  }

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

  walk(path: string, options: HostWalkOptions, visit: HostWalkVisitor): Promise<{ readonly truncated: boolean }> {
    return this.inner.walk(path, options, visit);
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
