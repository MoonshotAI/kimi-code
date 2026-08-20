/**
 * The v1 user-global MCP surface (`<KIMI_CODE_HOME>/mcp.json` CRUD plus the
 * standalone connection probe), rebuilt for the v2 client.
 *
 * Why a replica exists: agent-core-v2 only READS the user-global file (its
 * session config loader merges it with the project files); nothing in the
 * engine writes it, there is no app-scope MCP config service, and the v2
 * OAuth orchestrator / connection manager live behind the session scope — so
 * the store, the `require*` guards, and the probe result shaping are ported
 * here byte-for-byte from v1 (`agent-core/src/mcp/global-config.ts` and the
 * helpers at the bottom of `agent-core/src/rpc/core-impl.ts`). Validation
 * keeps using v1's own `McpServerConfigSchema` (the v2 schema dropped the
 * `auth: 'oauth'` marker field and would strip it on write). The moving
 * parts that DO have v2 counterparts — the OAuth service and the connection
 * manager — are the v2 engine's own classes, instantiated by the caller
 * (`sdk-rpc-client-v2.ts`); the v2 credential store persists to the same
 * on-disk layout as v1 (`<home>/credentials/mcp/<key>-*.json`).
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ErrorCodes,
  KimiError,
  McpServerConfigSchema,
  type GlobalMcpServerConfig,
  type McpRemoteServerConfig,
  type McpServerConfig,
} from '@moonshot-ai/agent-core';
import type { McpConnectionManager } from '@moonshot-ai/agent-core-v2/mcpCore/connection-manager';
import { atomicWrite } from '@moonshot-ai/agent-core-v2/_base/utils/fs';

import type {
  AppMcpServerConfig,
  AppMcpServerDescriptor,
  AppMcpServerInspection,
  GlobalMcpServerAuthState,
  McpServerLocator,
  McpTestResult,
} from '#/types';

interface GlobalMcpConfigFile {
  readonly raw: Record<string, unknown>;
  readonly rawServers: Record<string, unknown>;
  readonly servers: readonly GlobalMcpServerConfig[];
}

/** Byte-identical port of v1's `GlobalMcpConfigStore`. */
export class GlobalMcpConfigStore {
  readonly path: string;

  constructor(homeDir: string) {
    this.path = join(homeDir, 'mcp.json');
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

  async add(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]> {
    const normalized = parseServerInput(server);
    const file = await this.read();
    if (Object.hasOwn(file.rawServers, normalized.name)) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP server "${normalized.name}" already exists`,
      );
    }
    await this.write(file, {
      ...file.rawServers,
      [normalized.name]: persistedEntry(normalized),
    });
    return this.list();
  }

  async update(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]> {
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
  }

  async remove(name: string): Promise<readonly GlobalMcpServerConfig[]> {
    const normalizedName = normalizeServerName(name);
    const file = await this.read();
    if (!Object.hasOwn(file.rawServers, normalizedName)) return file.servers;
    const nextServers = Object.fromEntries(
      Object.entries(file.rawServers).filter(([entryName]) => entryName !== normalizedName),
    );
    await this.write(file, nextServers);
    return this.list();
  }

  private async read(): Promise<GlobalMcpConfigFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf-8');
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        return { raw: {}, rawServers: {}, servers: [] };
      }
      throw configError(`Failed to read ${this.path}: ${describeError(error)}`, error);
    }

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

  private async write(
    file: GlobalMcpConfigFile,
    rawServers: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicWrite(
      this.path,
      `${JSON.stringify({ ...file.raw, mcpServers: rawServers }, null, 2)}\n`,
    );
  }
}

/** Byte-identical port of v1's `requireRemoteMcpConfig` guard. */
export function requireRemoteMcpConfig(
  name: string,
  config: McpServerConfig,
): McpRemoteServerConfig {
  if (config.transport !== 'stdio') return config;
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${name}" does not use a remote transport`,
  );
}

/** Byte-identical port of v1's `requireOAuthMcpConfig` guard. */
export function requireOAuthMcpConfig(
  name: string,
  input: McpServerConfig,
): McpRemoteServerConfig {
  const config = requireRemoteMcpConfig(name, input);
  if (config.bearerTokenEnvVar !== undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${name}" uses a static bearer token`,
    );
  }
  if (config.headers !== undefined && config.auth !== 'oauth') {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${name}" uses static headers and is not marked for OAuth`,
    );
  }
  return config;
}

/** Byte-identical port of v1's `mcpServerId`. */
export function mcpServerId(locator: McpServerLocator): string {
  if (locator.source === 'global') return `global:${encodeURIComponent(locator.name)}`;
  return `plugin:${encodeURIComponent(locator.pluginId)}:${encodeURIComponent(locator.serverName)}`;
}

/** Byte-identical port of v1's `describeMcpServerLocator`. */
export function describeMcpServerLocator(locator: McpServerLocator): string {
  if (locator.source === 'global') return locator.name;
  return `${locator.pluginId}/${locator.serverName}`;
}

/** Inspection-time descriptor: the wire shape but with the full config. */
export type AppMcpServerRuntimeDescriptor = Omit<AppMcpServerDescriptor, 'config'> & {
  readonly config: McpServerConfig;
};

export type AppMcpServerRuntimeInspection = AppMcpServerRuntimeDescriptor &
  Pick<AppMcpServerInspection, 'authStatus' | 'checkedAt' | 'error'>;

/** Byte-identical port of v1's `sanitizeAppMcpServerInspection`. */
export function sanitizeAppMcpServerInspection(
  server: AppMcpServerRuntimeInspection,
): AppMcpServerInspection {
  return { ...server, config: sanitizeAppMcpServerConfig(server.config) };
}

/** Byte-identical port of v1's `sanitizeAppMcpServerConfig`. */
export function sanitizeAppMcpServerConfig(config: McpServerConfig): AppMcpServerConfig {
  if (config.transport === 'stdio') {
    const { env, ...safe } = config;
    return env === undefined ? safe : { ...safe, envKeys: Object.keys(env).toSorted() };
  }
  const { headers, ...safe } = config;
  return headers === undefined ? safe : { ...safe, headerKeys: Object.keys(headers).toSorted() };
}

/** Byte-identical port of v1's `selectAppMcpServerDescriptors`. */
export function selectAppMcpServerDescriptors(
  catalog: readonly AppMcpServerRuntimeDescriptor[],
  targets?: readonly McpServerLocator[],
): readonly AppMcpServerRuntimeDescriptor[] {
  if (targets === undefined) return catalog;
  const byId = new Map(catalog.map((server) => [server.serverId, server]));
  return targets.map((target) => {
    const server = byId.get(mcpServerId(target));
    if (server !== undefined) return server;
    throw new KimiError(
      ErrorCodes.MCP_SERVER_NOT_FOUND,
      `MCP server "${describeMcpServerLocator(target)}" was not found`,
    );
  });
}

/**
 * Byte-identical port of v1's `configuredMcpAuthState`: states decidable
 * without connecting — anything pinned (stdio, bearer token, static
 * non-OAuth headers) or disabled never enters the OAuth probe.
 */
export function configuredMcpAuthState(
  server: AppMcpServerRuntimeDescriptor,
): GlobalMcpServerAuthState | undefined {
  if (!server.enabled || server.config.enabled === false) return 'not-applicable';
  if (server.config.transport === 'stdio') return 'not-applicable';
  if (server.config.bearerTokenEnvVar !== undefined) return 'bearer-token';
  if (server.config.headers !== undefined && server.config.auth !== 'oauth') {
    return 'not-applicable';
  }
  return undefined;
}

/** Byte-identical port of v1's `isOAuthProbeCandidate`. */
export function isOAuthProbeCandidate(server: AppMcpServerRuntimeDescriptor): boolean {
  return configuredMcpAuthState(server) === undefined;
}

/** Byte-identical port of v1's `mcpConfigWithoutName`. */
export function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
}

/**
 * Byte-identical port of v1's inline-server validation (the `server` branch
 * of `resolveMcpTestTarget`, shared with `addSessionMcpServer`): the schema
 * strips unknown keys such as a stray `name`, so the name is re-attached.
 */
export function parseInlineMcpServer(server: GlobalMcpServerConfig): GlobalMcpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(server);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server "${server.name}": ${parsed.error.message}`,
    );
  }
  return { name: server.name, ...parsed.data };
}

/**
 * Byte-identical port of v1's reconnect-config validation
 * (`SessionAPIImpl.reconnectMcpServer`): same schema strip, nameless result.
 */
export function parseReconnectMcpServerConfig(
  name: string,
  config: GlobalMcpServerConfig,
): McpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server config for "${name}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Byte-identical port of v1's `standaloneMcpTestResult`, typed against the
 * v2 engine's connection manager (the probe's `get` / `resolved` reads are
 * the same on both ports of the manager).
 */
export function standaloneMcpTestResult(
  name: string,
  manager: McpConnectionManager,
): McpTestResult {
  const entry = manager.get(name);
  if (entry?.status !== 'connected') {
    return {
      success: false,
      output:
        entry?.error ?? `MCP server "${name}" finished with status ${entry?.status ?? 'unknown'}`,
    };
  }
  const tools = manager.resolved(name)?.rawTools ?? [];
  const lines = [
    `Connected to MCP server "${name}".`,
    `Available tools: ${tools.length}`,
    ...tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
  ];
  return { success: true, output: lines.join('\n') };
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
  throw new KimiError(ErrorCodes.REQUEST_INVALID, 'MCP server name cannot be empty');
}

function serverNotFound(name: string): KimiError {
  return new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
}

function configError(message: string, cause?: unknown): KimiError {
  return new KimiError(ErrorCodes.CONFIG_INVALID, message, { cause });
}

function errorCode(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  return error['code'];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
