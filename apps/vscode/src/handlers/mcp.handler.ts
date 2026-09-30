import * as vscode from "vscode";
import type {
  GlobalMcpServerConfig,
  McpFacade,
  McpManagedServer,
  McpServerConfig as EngineMcpServerConfig,
  McpServerConfigView,
} from "@moonshot-ai/harness-core";

import { Events, Methods } from "../../shared/bridge";
import {
  MCP_SECRET_MASK,
  type MCPServerConfig,
  type MCPTestResult,
  type UpdateMCPServerRequest,
} from "../../shared/legacy-sdk";
import type { Handler, HandlerContext } from "./types";

const SENSITIVE_MCP_KEY_WORDS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "token",
]);

interface NameParams { name: string }

export const mcpHandlers: Record<string, Handler<any, any>> = {
  [Methods.GetMCPServers]: async (_, ctx): Promise<MCPServerConfig[]> => {
    return listWorkspaceServers(ctx);
  },

  [Methods.AddMCPServer]: async (params: MCPServerConfig, ctx): Promise<MCPServerConfig[]> => {
    const server = restoreMaskedSecrets(undefined, params);
    const mcp = await ctx.runtime.mcp(ctx.workDir);
    await mcp.addServer(toEngineServer(server), { cwd: ctx.workDir ?? undefined });
    const servers = await listWorkspaceServers(ctx);
    ctx.broadcast(Events.MCPServersChanged, servers);
    return servers;
  },

  [Methods.UpdateMCPServer]: async (
    params: UpdateMCPServerRequest | MCPServerConfig,
    ctx,
  ): Promise<MCPServerConfig[]> => {
    const request = normalizeUpdateRequest(params);
    const mcp = await ctx.runtime.mcp(ctx.workDir);
    const current = (
      await mcp.listServers({ cwd: ctx.workDir ?? undefined })
    ).find((server) => server.name === request.originalName);
    const currentConfig = current !== undefined && current.mutable && isFullConfig(current.config)
      ? current.config
      : undefined;
    const edited = restoreMaskedSecrets(currentConfig, request.server);
    const next = mergeEditableServer(currentConfig, edited, request.replaceEditableFields);
    await updateOrRenameServer(mcp, request.originalName, currentConfig, next, ctx);
    const servers = await listWorkspaceServers(ctx);
    ctx.broadcast(Events.MCPServersChanged, servers);
    return servers;
  },

  [Methods.RemoveMCPServer]: async ({ name }: NameParams, ctx): Promise<MCPServerConfig[]> => {
    const mcp = await ctx.runtime.mcp(ctx.workDir);
    await mcp.removeServer(name, { cwd: ctx.workDir ?? undefined });
    const servers = await listWorkspaceServers(ctx);
    ctx.broadcast(Events.MCPServersChanged, servers);
    return servers;
  },

  [Methods.AuthMCP]: async ({ name }: NameParams, ctx) => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Kimi: Authenticating "${name}"...`,
        cancellable: false,
      },
      async () => {
        try {
          const mcp = await ctx.runtime.mcp(ctx.workDir);
          const begun = await mcp.beginServerAuth(
            { source: "global", name },
            { cwd: ctx.workDir ?? undefined },
          );
          if (begun.status === "already-authorized") {
            await vscode.window.showInformationMessage(`Kimi: "${name}" is already authorized.`);
            return;
          }
          await vscode.env.openExternal(vscode.Uri.parse(begun.authorizationUrl));
          await mcp.completeServerAuth({ flowId: begun.flowId });
          await vscode.window.showInformationMessage(`Kimi: OAuth completed for "${name}"`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await vscode.window.showErrorMessage(`Kimi: OAuth failed for "${name}": ${message}`);
          throw error;
        }
      },
    );
    return { ok: true };
  },

  [Methods.ResetAuthMCP]: async ({ name }: NameParams, ctx) => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Kimi: Resetting auth for "${name}"...`,
        cancellable: false,
      },
      async () => {
        try {
          const mcp = await ctx.runtime.mcp(ctx.workDir);
          await mcp.resetServerAuth({ source: "global", name }, { cwd: ctx.workDir ?? undefined });
          await vscode.window.showInformationMessage(`Kimi: Auth reset for "${name}"`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await vscode.window.showErrorMessage(`Kimi: Reset auth failed for "${name}": ${message}`);
          throw error;
        }
      },
    );
    return { ok: true };
  },

  [Methods.TestMCP]: async ({ name }: NameParams, ctx): Promise<MCPTestResult> => {
    void vscode.window.showInformationMessage(`Kimi: Testing MCP server "${name}"...`);
    const mcp = await ctx.runtime.mcp(ctx.workDir);
    const result = toWebviewTestResult(
      await mcp.testServer({ name, cwd: ctx.workDir ?? undefined }),
    );
    if (!result.success) {
      ctx.logError(`MCP server test failed for "${name}"`, new Error(result.output));
    }
    return result;
  },
};

async function listWorkspaceServers(ctx: HandlerContext): Promise<MCPServerConfig[]> {
  const mcp = await ctx.runtime.mcp(ctx.workDir);
  return toWebviewServers(await mcp.listServers({ cwd: ctx.workDir ?? undefined }));
}

function toWebviewServers(servers: readonly McpManagedServer[]): MCPServerConfig[] {
  return servers
    .filter((server) => server.config.transport === "stdio" || server.config.transport === "http")
    .map((server) => {
      const flat: Record<string, unknown> = {
        name: server.name,
        source: server.source,
        origin: server.origin,
        mutable: server.mutable,
      };
      const config = server.config;
      for (const [key, value] of Object.entries(config)) {
        if (key === "envKeys" || key === "headerKeys") continue;
        flat[key] = value;
      }
      if (config.transport === "stdio") {
        flat["env"] = isFullConfig(config)
          ? maskSecretValues(config.env)
          : maskedKeys("envKeys" in config ? config.envKeys : undefined);
      } else {
        flat["headers"] = isFullConfig(config)
          ? maskSecretValues(config.headers)
          : maskedKeys("headerKeys" in config ? config.headerKeys : undefined);
      }
      return flat as unknown as MCPServerConfig;
    });
}

function isFullConfig(
  config: EngineMcpServerConfig | McpServerConfigView,
): config is EngineMcpServerConfig {
  return !("envKeys" in config) && !("headerKeys" in config);
}

function maskedKeys(keys: readonly string[] | undefined): Record<string, string> | undefined {
  if (keys === undefined) return undefined;
  return Object.fromEntries(keys.map((key) => [key, MCP_SECRET_MASK]));
}

function maskSecretValues(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    isSensitiveMcpKey(key) ? MCP_SECRET_MASK : value,
  ]));
}

function isSensitiveMcpKey(key: string): boolean {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join("");
  return words.some((word) => SENSITIVE_MCP_KEY_WORDS.has(word))
    || words.includes("key")
    || compact === "proxyauthorization"
    || compact === "setcookie"
    || compact.endsWith("apikey")
    || compact.endsWith("accesskey")
    || compact.endsWith("privatekey");
}

function restoreMaskedSecrets(
  current: EngineMcpServerConfig | undefined,
  edited: MCPServerConfig,
): MCPServerConfig {
  if (edited.transport === "stdio") {
    const currentEnv = current?.transport === "stdio" ? current.env : undefined;
    return {
      ...edited,
      env: restoreMaskedRecord("environment variable", currentEnv, edited.env, false),
    };
  }
  const currentHeaders = current?.transport === "http" ? current.headers : undefined;
  return {
    ...edited,
    headers: restoreMaskedRecord("header", currentHeaders, edited.headers, true),
  };
}

function restoreMaskedRecord(
  label: string,
  current: Record<string, string> | undefined,
  edited: Record<string, string> | undefined,
  caseInsensitiveKeys: boolean,
): Record<string, string> | undefined {
  if (edited === undefined) return undefined;
  return Object.fromEntries(Object.entries(edited).map(([key, value]) => {
    if (value !== MCP_SECRET_MASK) return [key, value];
    const stored = findStoredSecret(current, key, caseInsensitiveKeys);
    if (stored === undefined) {
      throw new Error(`Cannot preserve masked MCP ${label} "${key}" because no stored value exists`);
    }
    return [key, stored];
  }));
}

function findStoredSecret(
  current: Record<string, string> | undefined,
  key: string,
  caseInsensitiveKeys: boolean,
): string | undefined {
  if (current === undefined) return undefined;
  if (Object.hasOwn(current, key)) return current[key];
  if (!caseInsensitiveKeys) return undefined;
  const normalized = key.toLowerCase();
  const match = Object.entries(current).find(([storedKey]) => storedKey.toLowerCase() === normalized);
  return match?.[1];
}

function toEngineServer(server: MCPServerConfig): GlobalMcpServerConfig {
  const name = server.name.trim();
  if (server.transport === "stdio") {
    return {
      name,
      transport: "stdio",
      command: server.command?.trim() ?? "",
      args: server.args,
      env: server.env,
    };
  }
  return {
    name,
    transport: "http",
    url: server.url?.trim() ?? "",
    headers: server.headers,
    auth: server.auth,
    bearerTokenEnvVar: server.bearerTokenEnvVar,
  };
}

function mergeEditableServer(
  current: EngineMcpServerConfig | undefined,
  edited: MCPServerConfig,
  replaceEditableFields: boolean,
): GlobalMcpServerConfig {
  const next = toEngineServer(edited);
  if (current === undefined || current.transport !== next.transport) return next;
  if (!replaceEditableFields) {
    return mergeReleasedFormUpdate(current, next);
  }
  return { ...current, ...next, name: next.name } as GlobalMcpServerConfig;
}

function mergeReleasedFormUpdate(
  current: EngineMcpServerConfig,
  next: GlobalMcpServerConfig,
): GlobalMcpServerConfig {
  const defined = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  );
  return { ...current, ...defined, name: next.name } as GlobalMcpServerConfig;
}

function normalizeUpdateRequest(
  params: UpdateMCPServerRequest | MCPServerConfig,
): {
  readonly originalName: string;
  readonly server: MCPServerConfig;
  readonly replaceEditableFields: boolean;
} {
  if ("server" in params) {
    return {
      originalName: params.originalName.trim(),
      server: params.server,
      replaceEditableFields: true,
    };
  }
  return {
    originalName: params.name.trim(),
    server: params,
    replaceEditableFields: false,
  };
}

async function updateOrRenameServer(
  mcp: McpFacade,
  originalName: string,
  current: EngineMcpServerConfig | undefined,
  next: GlobalMcpServerConfig,
  ctx: HandlerContext,
): Promise<void> {
  const query = { cwd: ctx.workDir ?? undefined };
  if (next.name === originalName) {
    await mcp.updateServer(next, query);
    return;
  }
  if (current === undefined) {
    throw new Error(`MCP server "${originalName}" was not found`);
  }

  await mcp.addServer(next, query);
  try {
    await mcp.removeServer(originalName, query);
  } catch (error) {
    await mcp.removeServer(next.name, query).catch(() => undefined);
    throw error;
  }
}

function toWebviewTestResult(result: { success: boolean; output: string }): MCPTestResult {
  return { success: result.success, output: sanitizeMcpDiagnostic(result.output) };
}

function sanitizeMcpDiagnostic(output: string): string {
  return output
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replaceAll(
      /(["']?(?:authorization|cookie|credentials?|password|passwd|secret|token|api[-_ ]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    );
}
