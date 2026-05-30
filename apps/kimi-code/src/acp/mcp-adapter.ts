import { RequestError, type HttpHeader, type McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '@moonshot-ai/kimi-code-sdk';

export function acpMcpServersToKimiConfig(
  servers: readonly McpServer[],
): Record<string, McpServerConfig> | undefined {
  if (servers.length === 0) return undefined;

  const result: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if (Object.hasOwn(result, server.name)) {
      throw RequestError.invalidParams(
        { serverName: server.name },
        'duplicate MCP server name',
      );
    }
    result[server.name] = acpMcpServerToKimiConfig(server);
  }
  return result;
}

function acpMcpServerToKimiConfig(server: McpServer): McpServerConfig {
  if ('command' in server) {
    const env = envVariablesToRecord(server.env);
    return {
      transport: 'stdio',
      command: server.command,
      args: server.args.length > 0 ? server.args : undefined,
      env,
    };
  }

  switch (server.type) {
    case 'http': {
      const headers = headersToRecord(server.headers);
      return {
        transport: 'http',
        url: server.url,
        headers,
      };
    }
    case 'sse':
      throw RequestError.invalidParams(
        { serverName: server.name, transport: 'sse' },
        'SSE MCP servers are not supported',
      );
    case 'acp':
      throw RequestError.invalidParams(
        { serverName: server.name, transport: 'acp' },
        'ACP-transport MCP servers are not supported',
      );
    default: {
      const exhaustive: never = server;
      void exhaustive;
      throw RequestError.invalidParams(undefined, 'unsupported MCP server transport');
    }
  }
}

function headersToRecord(headers: readonly HttpHeader[]): Record<string, string> | undefined {
  if (headers.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const header of headers) {
    result[header.name] = header.value;
  }
  return result;
}

function envVariablesToRecord(
  env: readonly { readonly name: string; readonly value: string }[],
): Record<string, string> | undefined {
  if (env.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const item of env) {
    result[item.name] = item.value;
  }
  return result;
}
