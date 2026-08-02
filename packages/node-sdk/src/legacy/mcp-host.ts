/**
 * Host-side MCP test + OAuth facade — local port of the retired
 * `agent-core` testGlobalMcpServer / beginGlobalMcpServerAuth / reset
 * surface. The engine owns the session-scoped MCP runtime; standalone server
 * checks and user-global OAuth flows run on the host against mcp.json.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ErrorCodes, KimiError } from './errors';
import type { GlobalMcpServerConfig } from './global-mcp-config';
import type { McpRemoteServerConfig } from './config-schema';
import type { BeginGlobalMcpServerAuthResult, GlobalMcpServerTestResult } from './wire-types';

// ── Standalone server check ──────────────────────────────────────────────

/** Connect a user-global server once and report its discovered tools.
 *  Only stdio is supported by the host-side probe; remote transports report a
 *  failure (the engine's session runtime connects those). */
export async function testGlobalMcpServerHost(
  server: GlobalMcpServerConfig,
): Promise<GlobalMcpServerTestResult> {
  if (server.transport !== 'stdio') {
    return {
      success: false,
      output: `MCP server "${server.name}" uses "${server.transport}" transport; only stdio is supported for host-side testing`,
    };
  }
  // Pre-flight the executable: a missing absolute/relative path spawns and
  // immediately closes (SDK reports "Connection closed"), which hides the
  // ENOENT the host probe should surface.
  if (server.command.includes('/') || server.command.includes('\\')) {
    if (!existsSync(server.command)) {
      return {
        success: false,
        output: `spawn ${server.command} ENOENT`,
      };
    }
  }
  const transport = new StdioClientTransport({
    command: server.command,
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.env !== undefined ? { env: server.env } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'kimi-code-sdk', version: '0.0.0-test' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    const lines = [
      `Connected to MCP server "${server.name}".`,
      `Available tools: ${tools.length}`,
      ...tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
    ];
    return { success: true, output: lines.join('\n') };
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Server config validation (mirrors agent-core core-impl helpers) ─────

function requireRemoteMcpServer(server: GlobalMcpServerConfig): McpRemoteServerConfig {
  if (server.transport === 'http' || server.transport === 'sse') return server;
  throw new KimiError(
    ErrorCodes.REQUEST_INVALID,
    `MCP server "${server.name}" does not use a remote transport`,
  );
}

function requireOAuthMcpServer(server: GlobalMcpServerConfig): McpRemoteServerConfig {
  const config = requireRemoteMcpServer(server);
  if (config.bearerTokenEnvVar !== undefined) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${server.name}" uses a static bearer token`,
    );
  }
  if (config.headers !== undefined && config.auth !== 'oauth') {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `MCP server "${server.name}" uses static headers and is not marked for OAuth`,
    );
  }
  return config;
}

// ── OAuth flow facade ────────────────────────────────────────────────────

/** Minimal host OAuth flow registry. Full RFC 9728 discovery/flow is a
 *  follow-up; the facade keeps the harness API contract (begin → URL →
 *  complete/cancel) intact so hosts can integrate their own browser flow. */
const activeFlows = new Map<string, { name: string; url: string }>();

export function beginGlobalMcpServerAuthHost(
  server: GlobalMcpServerConfig,
): BeginGlobalMcpServerAuthResult {
  const config = requireOAuthMcpServer(server);
  if (config.url === undefined || config.url.length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, `MCP server "${server.name}" has no URL`);
  }
  const flowId = randomUUID();
  const authorizationUrl = new URL(config.url);
  authorizationUrl.searchParams.set('oauth', 'begin');
  activeFlows.set(flowId, { name: server.name, url: authorizationUrl.toString() });
  return {
    status: 'authorization-required',
    flowId,
    authorizationUrl: authorizationUrl.toString(),
  };
}

export function completeGlobalMcpServerAuthHost(flowId: string): void {
  if (!activeFlows.delete(flowId)) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, `Unknown MCP OAuth flow: ${flowId}`);
  }
}

export function cancelGlobalMcpServerAuthHost(flowId: string): void {
  activeFlows.delete(flowId);
}

export function resetGlobalMcpServerAuthHost(server: GlobalMcpServerConfig): void {
  // Validate the server is remote; clearing stored credentials is a follow-up
  // (the host owns its OAuth token store).
  requireRemoteMcpServer(server);
}
