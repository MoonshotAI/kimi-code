import type { McpRemoteServerConfig, McpServerConfig } from './config-schema';
import { ErrorCodes, Error2 } from '#/errors';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  classifyMcpDiscoveryError,
  McpClassifiedStartupError,
  type McpFailureKind,
} from './client-shared';

export function buildMcpRemoteHeaders(
  config: McpRemoteServerConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...config.headers };
  if (config.bearerTokenEnvVar !== undefined) {
    const token = envLookup(config.bearerTokenEnvVar);
    if (token === undefined || token.length === 0) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `MCP ${config.transport.toUpperCase()} bearer token env var "${config.bearerTokenEnvVar}" is not set or is empty`,
      );
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') {
        delete headers[key];
      }
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function isRemoteMcpConfig(config: McpServerConfig): config is McpRemoteServerConfig {
  return config.transport === 'http' || config.transport === 'sse';
}

export function classifyRemoteStartupError(config: McpRemoteServerConfig, error: unknown): unknown {
  if (!isAuthRejectionStatus(error)) return error;
  const kind: McpFailureKind = hasStaticMcpCredentials(config) ? 'auth-static' : 'auth-oauth';
  return new McpClassifiedStartupError(kind, errorMessage(error), { cause: error });
}

export function classifyRemoteDiscoveryError(config: McpRemoteServerConfig, error: unknown): unknown {
  const classified = classifyRemoteStartupError(config, error);
  return classified === error ? classifyMcpDiscoveryError(error) : classified;
}

function hasStaticMcpCredentials(config: McpRemoteServerConfig): boolean {
  if (config.bearerTokenEnvVar !== undefined) return true;
  return config.headers !== undefined && config.auth !== 'oauth';
}

function isAuthRejectionStatus(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof StreamableHTTPError) return error.code === 401 || error.code === 403;
  if (error instanceof SseError) return error.code === 401 || error.code === 403;
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
