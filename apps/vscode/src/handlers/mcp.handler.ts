import * as vscode from "vscode";
import type { McpServerConfig as SdkMcpServerConfig, McpTestResult } from "@moonshot-ai/kimi-code-sdk";

import { Events, Methods } from "../../shared/bridge";
import {
  MCP_SECRET_MASK,
  type MCPServerConfig,
  type MCPTestResult,
  type UpdateMCPServerRequest,
} from "../../shared/legacy-sdk";
import type { Handler } from "./types";

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
    return toWebviewServers(await ctx.harness.listMcpServers());
  },

  [Methods.AddMCPServer]: async (params: MCPServerConfig, ctx): Promise<MCPServerConfig[]> => {
    const server = restoreMaskedSecrets(undefined, params);
    const servers = toWebviewServers(await ctx.harness.addMcpServer(toSdkServer(server)));
    ctx.broadcast(Events.MCPServersChanged, servers);
    return servers;
  },

  [Methods.UpdateMCPServer]: async (
    params: UpdateMCPServerRequest | MCPServerConfig,
    ctx,
  ): Promise<MCPServerConfig[]> => {
    const request = normalizeUpdateRequest(params);
    const current = (await ctx.harness.listMcpServers()).find(
      (server) => server.name === request.originalName,
    );
    const edited = restoreMaskedSecrets(current, request.server);
    const next = mergeEditableServer(current, edited, request.replaceEditableFields);
    const servers = toWebviewServers(
      await updateOrRenameServer(ctx.harness, request.originalName, current, next),
    );
    ctx.broadcast(Events.MCPServersChanged, servers);
    return servers;
  },

  [Methods.RemoveMCPServer]: async ({ name }: NameParams, ctx): Promise<MCPServerConfig[]> => {
    const servers = toWebviewServers(await ctx.harness.removeMcpServer(name));
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
          await ctx.harness.authenticateMcpServer(name, {
            onAuthorizationUrl: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
          });
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
          await ctx.harness.resetMcpServerAuth(name);
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
    const result = toWebviewTestResult(await ctx.harness.testMcpServer(name, {
      cwd: ctx.workDir ?? undefined,
    }));
    if (!result.success) {
      ctx.logError(`MCP server test failed for "${name}"`, new Error(result.output));
    }
    return result;
  },
};

function toWebviewServers(servers: readonly SdkMcpServerConfig[]): MCPServerConfig[] {
  return servers
    .filter((server) => server.transport === "stdio" || server.transport === "http")
    .map((server) => {
      if (server.transport === "stdio") {
        return { ...server, env: maskSecretValues(server.env) } as MCPServerConfig;
      }
      return { ...server, headers: maskSecretValues(server.headers) } as MCPServerConfig;
    });
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
  current: SdkMcpServerConfig | undefined,
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

function toSdkServer(server: MCPServerConfig): SdkMcpServerConfig {
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
  current: SdkMcpServerConfig | undefined,
  edited: MCPServerConfig,
  replaceEditableFields: boolean,
): SdkMcpServerConfig {
  const next = toSdkServer(edited);
  if (current === undefined || current.transport !== next.transport) return next;
  if (!replaceEditableFields) {
    return mergeReleasedFormUpdate(current, next);
  }
  return { ...current, ...next } as SdkMcpServerConfig;
}

function mergeReleasedFormUpdate(
  current: SdkMcpServerConfig,
  next: SdkMcpServerConfig,
): SdkMcpServerConfig {
  const defined = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  );
  return { ...current, ...defined } as SdkMcpServerConfig;
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
  harness: Pick<
    Parameters<Handler>[1]["harness"],
    "addMcpServer" | "updateMcpServer" | "removeMcpServer"
  >,
  originalName: string,
  current: SdkMcpServerConfig | undefined,
  next: SdkMcpServerConfig,
): Promise<readonly SdkMcpServerConfig[]> {
  if (next.name === originalName) {
    return harness.updateMcpServer(next);
  }
  if (current === undefined) {
    throw new Error(`MCP server "${originalName}" was not found`);
  }

  await harness.addMcpServer(next);
  try {
    return await harness.removeMcpServer(originalName);
  } catch (error) {
    await harness.removeMcpServer(next.name).catch(() => undefined);
    throw error;
  }
}

function toWebviewTestResult(result: McpTestResult): MCPTestResult {
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
