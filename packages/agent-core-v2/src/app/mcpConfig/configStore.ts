import { join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event, type IWaitUntil } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { ErrorCodes, Error2 } from '#/errors';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

export type GlobalMcpServerConfig = McpServerConfig & { readonly name: string };

export type McpConfigWriteEvent = IWaitUntil;

export interface IMcpConfigStore {
  readonly _serviceBrand: undefined;
  readonly path: string;
  readonly onDidWrite: Event<McpConfigWriteEvent>;
  list(): Promise<readonly GlobalMcpServerConfig[]>;
  get(name: string): Promise<GlobalMcpServerConfig>;
  add(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]>;
  update(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]>;
  remove(name: string): Promise<readonly GlobalMcpServerConfig[]>;
}

export const IMcpConfigStore: ServiceIdentifier<IMcpConfigStore> =
  createDecorator<IMcpConfigStore>('mcpConfigStore');

interface McpConfigFile {
  readonly raw: Record<string, unknown>;
  readonly rawServers: Record<string, unknown>;
  readonly servers: readonly GlobalMcpServerConfig[];
}

const CONFIG_SCOPE = '';
const MCP_CONFIG_KEY = 'mcp.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

export class McpConfigStore extends Disposable implements IMcpConfigStore {
  declare readonly _serviceBrand: undefined;

  readonly path: string;

  private readonly writeEmitter = this._register(new AsyncEmitter<McpConfigWriteEvent>());
  readonly onDidWrite: Event<McpConfigWriteEvent> = this.writeEmitter.event;
  private mutationTail: Promise<void> = Promise.resolve();
  private writePending = false;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    super();
    this.path = join(bootstrap.homeDir, MCP_CONFIG_KEY);
  }

  async list(): Promise<readonly GlobalMcpServerConfig[]> {
    return (await this.read()).servers;
  }

  async get(name: string): Promise<GlobalMcpServerConfig> {
    const normalizedName = normalizeServerName(name);
    const server = (await this.read()).servers.find((entry) => entry.name === normalizedName);
    if (server !== undefined) return server;
    throw serverNotFound(normalizedName);
  }

  add(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]> {
    return this.mutate(async () => {
      const normalized = parseServerInput(server);
      const file = await this.read();
      if (Object.hasOwn(file.rawServers, normalized.name)) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          `MCP server "${normalized.name}" already exists`,
        );
      }
      await this.write(file, {
        ...file.rawServers,
        [normalized.name]: persistedEntry(normalized),
      });
      return this.list();
    });
  }

  update(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]> {
    return this.mutate(async () => {
      const normalized = parseServerInput(server);
      const file = await this.read();
      if (!Object.hasOwn(file.rawServers, normalized.name)) {
        throw serverNotFound(normalized.name);
      }
      await this.write(file, {
        ...file.rawServers,
        [normalized.name]: persistedEntry(normalized),
      });
      return this.list();
    });
  }

  remove(name: string): Promise<readonly GlobalMcpServerConfig[]> {
    return this.mutate(async () => {
      const normalizedName = normalizeServerName(name);
      const file = await this.read();
      if (!Object.hasOwn(file.rawServers, normalizedName)) return file.servers;
      const nextServers = Object.fromEntries(
        Object.entries(file.rawServers).filter(([entryName]) => entryName !== normalizedName),
      );
      await this.write(file, nextServers);
      return this.list();
    });
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail.then(
      () => undefined,
      () => undefined,
    );
    return tail.then(async (result) => {
      if (!this.writePending) return result;
      this.writePending = false;
      await this.writeEmitter.fireAsyncConcurrent({}, NO_ABORT);
      return result;
    });
  }

  private async read(): Promise<McpConfigFile> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.storage.read(CONFIG_SCOPE, MCP_CONFIG_KEY);
    } catch (error: unknown) {
      throw configError(`Failed to read ${this.path}: ${describeError(error)}`, error);
    }
    if (bytes === undefined) {
      return { raw: {}, rawServers: {}, servers: [] };
    }

    const text = textDecoder.decode(bytes);
    if (text.trim().length === 0) {
      return { raw: {}, rawServers: {}, servers: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw configError(`Invalid JSON in ${this.path}: ${describeError(error)}`, error);
    }
    if (!isRecord(parsed)) {
      throw configError(`Invalid MCP config in ${this.path}: expected a JSON object`);
    }
    const rawServersValue = parsed['mcpServers'];
    if (rawServersValue !== undefined && !isRecord(rawServersValue)) {
      throw configError(`Invalid MCP config in ${this.path}: "mcpServers" must be an object`);
    }
    const rawServers = rawServersValue ?? {};
    const servers = Object.entries(rawServers).map(([name, value]) => parseServer(name, value));
    return { raw: parsed, rawServers, servers };
  }

  private async write(file: McpConfigFile, rawServers: Record<string, unknown>): Promise<void> {
    const text = `${JSON.stringify({ ...file.raw, mcpServers: rawServers }, null, 2)}\n`;
    await this.storage.write(CONFIG_SCOPE, MCP_CONFIG_KEY, textEncoder.encode(text), {
      atomic: true,
    });
    this.writePending = true;
  }
}

const NO_ABORT = new AbortController().signal;

function parseServerInput(server: GlobalMcpServerConfig): GlobalMcpServerConfig {
  return parseServer(normalizeServerName(server.name), server);
}

function parseServer(name: string, value: unknown): GlobalMcpServerConfig {
  const result = McpServerConfigSchema.safeParse(value);
  if (!result.success) {
    throw configError(
      `Invalid MCP server "${name}" in global config: ${result.error.message}`,
      result.error,
    );
  }
  return { name, ...result.data };
}

function persistedEntry(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...entry } = server;
  return entry;
}

export function normalizeServerName(name: string): string {
  const normalized = name.trim();
  if (normalized.length > 0) return normalized;
  throw new Error2(ErrorCodes.REQUEST_INVALID, 'MCP server name cannot be empty');
}

function serverNotFound(name: string): Error2 {
  return new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
}

function configError(message: string, cause?: unknown): Error2 {
  return new Error2(ErrorCodes.CONFIG_INVALID, message, { cause });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

registerScopedService(
  LifecycleScope.App,
  IMcpConfigStore,
  McpConfigStore,
  ScopeActivation.OnDemand,
  'mcpConfig',
);
