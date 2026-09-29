import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core';

import { qualifyMcpToolName } from '#/features/mcp/core/tool-naming';
import { AlreadyAuthorizedError, type McpOAuthService } from '#/features/mcp/oauth/service';

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

const AUTH_TOOL_NAME = 'authenticate';

const DESCRIPTION_TEMPLATE = (serverName: string): string =>
  `Authenticate with MCP server "${serverName}" via OAuth.

This server requires an OAuth login that has not yet been completed. ` +
  `Calling this tool starts the authorization flow:

  1. The tool prints an authorization URL.
  2. **You must show that URL to the user verbatim** and ask them to open it
     in a browser, sign in, and approve the client.
  3. The tool blocks (up to 15 minutes) until the browser redirects back to
     the local callback listener.
  4. On success, the client reconnects the MCP server and the real tools
     replace this synthetic tool.

Take no arguments. Treat the URL as sensitive — do not modify it or strip
query parameters.`;

export interface CreateMcpAuthToolOptions {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly oauthService: McpOAuthService;
  readonly reconnect: (signal?: AbortSignal) => Promise<void>;
  readonly onAuthorizationUrl: (authorizationUrl: string, expiresAt: number) => void;
  readonly deferred?: boolean;
}

export function createMcpAuthTool(options: CreateMcpAuthToolOptions): ToolDefinition {
  const { serverName, serverUrl, oauthService, reconnect, onAuthorizationUrl } = options;
  const name = qualifyMcpToolName(serverName, AUTH_TOOL_NAME);
  return {
    name,
    description: DESCRIPTION_TEMPLATE(serverName),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    deferred: options.deferred === true ? true : undefined,
    execute: async ({ signal, onUpdate }): Promise<ToolResult> => {
      signal.throwIfAborted();

      onUpdate?.({ key: 'status', text: `Discovering OAuth metadata for ${serverName}…` });

      let flow: Awaited<ReturnType<McpOAuthService['beginAuthorization']>>;
      try {
        flow = await oauthService.beginAuthorization(serverName, serverUrl);
      } catch (error) {
        if (error instanceof AlreadyAuthorizedError) {
          onUpdate?.({ key: 'status', text: `Already authorized; reconnecting ${serverName}…` });
          try {
            await reconnect(signal);
          } catch (reconnectError) {
            return errorResult(serverName, reconnectError);
          }
          return textResult(
            `MCP server "${serverName}" already had valid OAuth credentials. ` +
              `Reconnected; real tools are available now.`,
          );
        }
        return errorResult(serverName, error);
      }

      const urlText = flow.authorizationUrl.toString();
      const waitTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS;
      onAuthorizationUrl(urlText, Date.now() + waitTimeoutMs);
      onUpdate?.({
        key: 'status',
        text:
          `Open this URL in your browser to authorize "${serverName}":\n` +
          `\n${urlText}\n\n` +
          `Waiting for the OAuth callback (timeout 15 min). ` +
          `If you cancel, call this tool again to restart the flow.`,
      });

      try {
        await flow.complete({ signal, timeoutMs: waitTimeoutMs });
      } catch (error) {
        return errorResult(serverName, error, urlText);
      }

      onUpdate?.({ key: 'status', text: `Authorized — reconnecting ${serverName}…` });
      try {
        await reconnect(signal);
      } catch (error) {
        return errorResult(serverName, error);
      }

      return textResult(
        `MCP server "${serverName}" authenticated successfully. ` +
          `The real MCP tools have replaced this synthetic authenticate tool.`,
      );
    },
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(
  serverName: string,
  error: unknown,
  authorizationUrl?: string,
): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const suffix =
    authorizationUrl !== undefined
      ? `\n\nAuthorization URL (still valid if the listener has not timed out): ${authorizationUrl}`
      : '';
  return {
    ...textResult(
      `OAuth flow for MCP server "${serverName}" did not complete: ${message}${suffix}`,
    ),
    isError: true,
  };
}
