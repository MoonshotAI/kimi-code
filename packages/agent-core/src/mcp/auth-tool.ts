/**
 * Synthetic `mcp__<server>__authenticate` tool.
 *
 * When a remote MCP server lands in the `needs-auth` state — i.e. its
 * initial connection failed with a 401 / `UnauthorizedError` and no static
 * bearer token is configured — the {@link ToolManager} swaps the real MCP
 * tool list for this single tool. Calling it:
 *
 *  1. Asks {@link McpOAuthService} to perform RFC 9728 / RFC 8414 / RFC 7591
 *     discovery and produce an authorization URL.
 *  2. Streams that URL back to the model via `onUpdate({kind:'status'})`
 *     and returns it in the tool output so the model can hand it to the
 *     human user.
 *  3. Blocks (up to {@link DEFAULT_AUTH_TIMEOUT_MS}) on the one-shot
 *     localhost callback listener owned by the OAuth service.
 *  4. Drives a manager-level `reconnect(name)` once tokens have been
 *     persisted, which flips the entry to `connected` and lets
 *     `ToolManager` swap the synthetic tool out for the real MCP tools.
 *
 * The blocking shape (option 1 in the plan) keeps the implementation
 * simple at the cost of holding one tool call open for the duration of
 * the human's browser flow. If the model ends up re-invoking the tool
 * mid-flow we just start a fresh flow; the new callback server supersedes
 * the old one.
 */

import { z } from 'zod';

import {
  type ExecutableTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
} from '../loop';
import { toInputJsonSchema } from '../tools/support/input-schema';
import {
  MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
  type McpOAuthAuthorizationUrlUpdateData,
} from '../rpc/events';
import { AlreadyAuthorizedError, type McpOAuthService } from './oauth';
import { qualifyMcpToolName } from './tool-naming';

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const AUTH_TOOL_TOOL_NAME = 'authenticate';

const DESCRIPTION_TEMPLATE = (serverName: string): string =>
  `Authenticate with MCP server "${serverName}" via OAuth.

This server requires an OAuth login that has not yet been completed. ` +
  `Calling this tool starts the authorization flow:

  1. The tool prints an authorization URL.
  2. **You must show that URL to the user verbatim** and ask them to open it
     in a browser, sign in, and approve the kimi-code client.
  3. The tool blocks (up to 15 minutes) until the browser redirects back to
     the local callback listener.
  4. On success, kimi-code reconnects the MCP server and the real tools
     replace this synthetic tool.

Take no arguments. Treat the URL as sensitive — do not modify it or strip
query parameters.`;

export interface CreateMcpAuthToolOptions {
  /** Friendly MCP server name as configured in `mcp.json`. */
  readonly serverName: string;
  /** Base URL of the MCP server (used for OAuth resource metadata discovery). */
  readonly serverUrl: string;
  /** OAuth orchestrator, typically `Session`-scoped. */
  readonly oauthService: McpOAuthService;
  /**
   * Triggers a manager-level reconnect once tokens land on disk. Implemented
   * by the {@link McpConnectionManager} and bound in the {@link ToolManager}
   * `needs-auth` branch.
   */
  readonly reconnect: (signal?: AbortSignal) => Promise<void>;
  /**
   * Overrides the per-call OAuth wait timeout. Tests set this to a small
   * number; production callers should accept the default.
   */
  readonly timeoutMs?: number;
}

export function createMcpAuthTool(options: CreateMcpAuthToolOptions): ExecutableTool {
  const { serverName, serverUrl, oauthService, reconnect, timeoutMs } = options;
  const name = qualifyMcpToolName(serverName, AUTH_TOOL_TOOL_NAME);
  const description = DESCRIPTION_TEMPLATE(serverName);
  // No arguments; an empty object schema keeps providers happy across SDKs.
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
    const customData: McpOAuthAuthorizationUrlUpdateData = {
      serverName,
      authorizationUrl: urlText,
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
      await flow.complete({ signal, timeoutMs: timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS });
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
