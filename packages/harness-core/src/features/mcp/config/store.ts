import { dirname } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

import { McpServerConfigSchema, type McpServerConfig } from '../core/config-schema';
import { McpManagementError } from '../errors';

export type GlobalMcpServerConfig = McpServerConfig & { readonly name: string };

interface McpConfigFile {
  readonly raw: Record<string, unknown>;
  readonly rawServers: Record<string, unknown>;
}

export class McpUserConfigStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly fs: OsFsPort,
  ) {}

  add(server: GlobalMcpServerConfig): Promise<void> {
    return this.mutate(async () => {
      const normalized = parseServerInput(server);
      const file = await this.read();
      if (Object.hasOwn(file.rawServers, normalized.name)) {
        throw new McpManagementError(
          'mcp.request_invalid',
          `MCP server "${normalized.name}" already exists`,
        );
      }
      await this.write(file, {
        ...file.rawServers,
        [normalized.name]: persistedEntry(normalized),
      });
    });
  }

  update(server: GlobalMcpServerConfig): Promise<void> {
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
    });
  }

  remove(name: string): Promise<void> {
    return this.mutate(async () => {
      const normalizedName = normalizeServerName(name);
      const file = await this.read();
      if (!Object.hasOwn(file.rawServers, normalizedName)) return;
      const nextServers = Object.fromEntries(
        Object.entries(file.rawServers).filter(([entryName]) => entryName !== normalizedName),
      );
      await this.write(file, nextServers);
    });
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail.then(
      () => undefined,
      () => undefined,
    );
    return tail;
  }

  private async read(): Promise<McpConfigFile> {
    let text: string;
    try {
      text = await this.fs.readText(this.path);
    } catch (error: unknown) {
      if (error instanceof HostFsError && error.code === 'os.fs.not_found') {
        return { raw: {}, rawServers: {} };
      }
      throw configError(`Failed to read ${this.path}: ${describeError(error)}`, error);
    }
    if (text.trim().length === 0) return { raw: {}, rawServers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
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
    for (const [name, value] of Object.entries(rawServers)) {
      parseServer(name, value);
    }
    return { raw: parsed, rawServers };
  }

  private async write(file: McpConfigFile, rawServers: Record<string, unknown>): Promise<void> {
    const text = `${JSON.stringify({ ...file.raw, mcpServers: rawServers }, null, 2)}\n`;
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${crypto.randomUUID()}.tmp`;
    await this.fs.writeText(tmp, text);
    await this.fs.rename(tmp, this.path);
  }
}

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
  throw new McpManagementError('mcp.request_invalid', 'MCP server name cannot be empty');
}

function serverNotFound(name: string): McpManagementError {
  return new McpManagementError('mcp.server_not_found', `MCP server "${name}" was not found`);
}

function configError(message: string, cause?: unknown): McpManagementError {
  return new McpManagementError('mcp.config_invalid', message, { cause });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
