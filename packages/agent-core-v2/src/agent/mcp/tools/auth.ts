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
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { AlreadyAuthorizedError, type McpOAuthService } from '#/agent/mcp/oauth/service';
import { qualifyMcpToolName } from '#/agent/mcp/tool-naming';
import { t } from '@moonshot-ai/kimi-i18n';

/**
 * `ToolUpdate.customKind` emitted by the MCP auth tool when the OAuth
 * authorization URL is ready; clients render it as an actionable login link.
 */
export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = 'mcp.oauth.authorization_url';

export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
}

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

const AUTH_TOOL_TOOL_NAME = 'authenticate';

const DESCRIPTION_TEMPLATE = (serverName: string): string =>
  t('v2Mcp.authToolDescription', { serverName }) +
  '\n\n' +
  t('v2Mcp.authToolDescriptionBlock', { timeoutMinutes: String(DEFAULT_AUTH_TIMEOUT_MS / 60_000) });

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

    onUpdate?.({ kind: 'status', text: t('v2Mcp.discoveringOAuth', { serverName }) });

    let flow: Awaited<ReturnType<McpOAuthService['beginAuthorization']>>;
    try {
      flow = await oauthService.beginAuthorization(serverName, serverUrl);
    } catch (error) {
      if (error instanceof AlreadyAuthorizedError) {
        onUpdate?.({ kind: 'status', text: t('v2Mcp.alreadyAuthorized', { serverName }) });
        try {
          await reconnect(signal);
        } catch (reconnectError) {
          return errorResult(serverName, reconnectError);
        }
        return {
          output: t('v2Mcp.authorizedReconnected', { serverName }),
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
        t('v2Mcp.openUrl', { serverName }) +
        `\n\n${urlText}\n\n` +
        t('v2Mcp.waitingForCallback') +
        t('v2Mcp.authTimeoutSuffix', { timeoutMinutes: '15' }),
    });

    try {
      await flow.complete({ signal, timeoutMs: timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS });
    } catch (error) {
      return errorResult(serverName, error, urlText);
    }

    onUpdate?.({ kind: 'status', text: t('v2Mcp.authorizedReconnecting', { serverName }) });
    try {
      await reconnect(signal);
    } catch (error) {
      return errorResult(serverName, error);
    }

    return {
      output: t('v2Mcp.authenticated', { serverName }),
    };
  };

  return {
    name,
    description,
    parameters,
    resolveExecution: () => {
      return {
        description: t('v2Mcp.authToolDescription', { serverName }),
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
      ? t('v2Mcp.authErrorUrlSuffix', { authorizationUrl })
      : '';
  return {
    isError: true,
    output: t('v2Mcp.oauthFailed', { serverName, message }) + suffix,
  };
}
