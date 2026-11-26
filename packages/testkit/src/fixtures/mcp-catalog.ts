import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type FakeMcpText =
  | string
  | { readonly argument: string }
  | { readonly envNamedBy: string }
  | { readonly cwd: true }
  | { readonly clientName: true };

export interface FakeMcpReply {
  readonly text?: FakeMcpText;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export interface FakeMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly reply?: string | FakeMcpReply;
  readonly delayMs?: number;
}

export interface FakeMcpCatalog<Tool extends FakeMcpTool = FakeMcpTool> {
  readonly tools: readonly Tool[];
  readonly callLog?: string;
  readonly hangListTools?: boolean;
}

export interface McpCall {
  readonly server: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ServedCatalog<Tool extends FakeMcpTool> {
  readonly name: string;
  readonly catalog: Omit<FakeMcpCatalog<Tool>, 'tools'>;
  tools(): readonly Tool[];
  afterReply?(tool: Tool): void;
}

export const FAKE_MCP_CAPABILITIES = { tools: { listChanged: true } } as const;

export function serveFakeMcpCatalog<Tool extends FakeMcpTool>(mcp: McpServer, served: ServedCatalog<Tool>): void {
  mcp.server.registerCapabilities(FAKE_MCP_CAPABILITIES);
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => {
    if (served.catalog.hangListTools === true) return new Promise<never>(() => {});
    return {
      tools: served.tools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object' as const, properties: {}, ...tool.inputSchema },
      })),
    };
  });
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (served.catalog.callLog !== undefined) {
      const call: McpCall = { server: served.name, tool: name, arguments: args };
      appendFileSync(served.catalog.callLog, `${JSON.stringify(call)}\n`);
    }
    const tool = served.tools().find((candidate) => candidate.name === name);
    if (tool === undefined) return { isError: true, content: [{ type: 'text' as const, text: `The fake MCP server ${served.name} has no tool ${name}` }] };
    if (tool.delayMs !== undefined) await sleep(tool.delayMs);
    const result = resultOf(tool, args, mcp);
    served.afterReply?.(tool);
    return result;
  });
}

function resultOf(tool: FakeMcpTool, args: Readonly<Record<string, unknown>>, mcp: McpServer): CallToolResult {
  const reply: FakeMcpReply = typeof tool.reply === 'object' ? tool.reply : { text: tool.reply ?? `${tool.name} done` };
  return {
    ...(reply.text === undefined ? {} : { content: [{ type: 'text', text: textOf(reply.text, args, mcp) }] }),
    ...(reply.structuredContent === undefined ? {} : { structuredContent: { ...reply.structuredContent } }),
    ...(reply.meta === undefined ? {} : { _meta: { ...reply.meta } }),
    ...(reply.isError === true ? { isError: true } : {}),
  } as CallToolResult;
}

function textOf(text: FakeMcpText, args: Readonly<Record<string, unknown>>, mcp: McpServer): string {
  if (typeof text === 'string') return text;
  if ('argument' in text) return stringArgument(args, text.argument);
  if ('envNamedBy' in text) return process.env[stringArgument(args, text.envNamedBy)] ?? '';
  if ('cwd' in text) return process.cwd();
  return mcp.server.getClientVersion()?.name ?? '';
}

function stringArgument(args: Readonly<Record<string, unknown>>, name: string): string {
  const value = args[name];
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
