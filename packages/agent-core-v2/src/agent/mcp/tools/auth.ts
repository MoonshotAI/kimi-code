import { z } from 'zod';

import {
  type ExecutableTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { AlreadyAuthorizedError, type McpOAuthService } from '#/mcpCore/oauth/service';
import { qualifyMcpToolName } from '#/mcpCore/tool-naming';

export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = 'mcp.oauth.authorization_url';

export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
  readonly expiresAt?: number;
}

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

const AUTH_TOOL_TOOL_NAME = 'authenticate';

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
  readonly timeoutMs?: number;
}

export function createMcpAuthTool(options: CreateMcpAuthToolOptions): ExecutableTool {
  const { serverName, serverUrl, oauthService, reconnect, timeoutMs } = options;
  const name = qualifyMcpToolName(serverName, AUTH_TOOL_TOOL_NAME);
  const description = DESCRIPTION_TEMPLATE(serverName);
  const parameters = toInputJsonSchema(z.object({}));
  const execute = async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
    const { signal, onUpdate } = ctx;
    signal.throwIfAborted();

    onUpdate?.({ kind: 'status', text: `Discovering OAuth metadata for ${serverName}…` });

    let flow: Awaited<ReturnType<McpOAuthService['beginAuthorization']>>;
    try {
      flow = await oauthService.beginAuthorization(serverName, serverUrl);
    } catch (error) {
      if (error instanceof AlreadyAuthorizedError) {
        onUpdate?.({ kind: 'status', text: `Already authorized; reconnecting ${serverName}…` });
        try {
          await reconnect(signal);
        } catch (reconnectError) {
          return errorResult(serverName, reconnectError);
        }
        return {
          output:
            `MCP server "${serverName}" already had valid OAuth credentials. ` +
            `Reconnected; real tools are available now.`,
        };
      }
      return errorResult(serverName, error);
    }

    const urlText = flow.authorizationUrl.toString();
    const waitTimeoutMs = timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    const customData: McpOAuthAuthorizationUrlUpdateData = {
      serverName,
      authorizationUrl: urlText,
      expiresAt: Date.now() + waitTimeoutMs,
    };
    onUpdate?.({
      kind: 'custom',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
      customData,
    });
    onUpdate?.({
      kind: 'status',
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

    onUpdate?.({ kind: 'status', text: `Authorized — reconnecting ${serverName}…` });
    try {
      await reconnect(signal);
    } catch (error) {
      return errorResult(serverName, error);
    }

    return {
      output:
        `MCP server "${serverName}" authenticated successfully. ` +
        `The real MCP tools have replaced this synthetic authenticate tool.`,
    };
  };

  return {
    name,
    description,
    parameters,
    resolveExecution: () => {
      return {
        description: `Authenticating ${serverName}`,
        approvalRule: name,
        execute,
      };
    },
  };
}

function errorResult(
  serverName: string,
  error: unknown,
  authorizationUrl?: string,
): ExecutableToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const suffix =
    authorizationUrl !== undefined
      ? `\n\nAuthorization URL (still valid if the listener has not timed out): ${authorizationUrl}`
      : '';
  return {
    isError: true,
    output: `OAuth flow for MCP server "${serverName}" did not complete: ${message}${suffix}`,
  };
}
