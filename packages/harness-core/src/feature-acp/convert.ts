import { isAbsolute, resolve } from 'node:path';

import type { ContentBlock, McpServer, ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk';
import type { ContentPart } from '@moonshot-ai/agent-core/llm/message';
import type { ToolCallOutcome } from '@moonshot-ai/agent-core/loop/index';

import type { McpServerConfig } from '#/features/mcp/index';

import type { AcpToolKind } from './types';

export function acpBlocksToContentParts(blocks: readonly ContentBlock[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      out.push({
        type: 'image_url',
        source: { kind: 'inline', mimeType: block.mimeType, data: block.data },
      });
      continue;
    }
    if (block.type === 'audio') continue;
    if (block.type === 'resource_link') {
      const fileRef = fileLinkToTextRef(block.uri);
      out.push({
        type: 'text',
        text:
          fileRef ??
          `<resource_link uri="${escapeXmlAttr(block.uri)}" name="${escapeXmlAttr(block.name)}" />`,
      });
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource) {
        out.push({
          type: 'text',
          text: `<resource uri="${escapeXmlAttr(resource.uri)}">${resource.text}</resource>`,
        });
      }
      continue;
    }
  }
  return out;
}

function escapeXmlAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fileLinkToTextRef(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isUncHost = host !== '' && host !== 'localhost';
  if (!isUncHost && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  if (isUncHost) {
    path = `//${host}${path.startsWith('/') ? path : `/${path}`}`;
  }
  const range = parseLineRange(url.hash) ?? parseLineRange(url.search);
  return range !== null ? `${path}:${range}` : path;
}

function parseLineRange(suffix: string): string | null {
  if (!suffix) return null;
  const body = suffix.replace(/^[#?]/, '');
  const match = /^(?:lines?=|L)(\d+)(?:[-:]L?(\d+))?/i.exec(body);
  if (!match) return null;
  return match[2] !== undefined ? `${match[1]}-${match[2]}` : match[1]!;
}

export function acpToolCallId(turnId: number, toolCallId: string): string {
  return `${turnId}:${toolCallId}`;
}

export interface DeriveToolDiffDeps {
  readonly readFile?: (path: string) => Promise<string | undefined>;
  readonly cwd?: () => string | undefined;
}

export async function deriveToolDiffContent(
  toolName: string,
  args: Record<string, unknown>,
  deps: DeriveToolDiffDeps,
): Promise<ToolCallContent | null> {
  if (toolName === 'Edit') return deriveEditDiffContent(args);
  if (toolName === 'Write') return deriveWriteDiffContent(args, deps);
  return null;
}

export function deriveEditDiffContent(args: Record<string, unknown>): ToolCallContent | null {
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const oldText = typeof args['old_string'] === 'string' ? args['old_string'] : undefined;
  const newText = typeof args['new_string'] === 'string' ? args['new_string'] : undefined;
  if (path === undefined || oldText === undefined || newText === undefined) return null;
  return { type: 'diff', path, oldText, newText };
}

async function deriveWriteDiffContent(
  args: Record<string, unknown>,
  deps: DeriveToolDiffDeps,
): Promise<ToolCallContent | null> {
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const content = typeof args['content'] === 'string' ? args['content'] : undefined;
  if (path === undefined || content === undefined) return null;
  let oldText: string | null = null;
  if (deps.readFile !== undefined) {
    const cwd = deps.cwd?.();
    const resolved = isAbsolute(path) ? path : cwd === undefined ? undefined : resolve(cwd, path);
    if (resolved !== undefined) {
      oldText = (await deps.readFile(resolved)) ?? null;
    }
  }
  return { type: 'diff', path, oldText, newText: content };
}

export function inferToolKind(name: string): AcpToolKind {
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';
    case 'Write':
    case 'Edit':
      return 'edit';
    case 'Bash':
    case 'Terminal':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'Think':
      return 'think';
    default:
      return 'other';
  }
}

export function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

function argsPath(name: string, args: unknown): string | undefined {
  if (!FILE_TOOL_NAMES.has(name) || typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'path']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function toolCallLocations(name: string, args: unknown): ToolCallLocation[] | undefined {
  const path = argsPath(name, args);
  if (path === undefined || !isAbsolute(path)) return undefined;
  return [{ path }];
}

export function parseToolCallArguments(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments === '') return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

export function contentPartsToAcpToolCallContent(
  parts: readonly ContentPart[],
): ToolCallContent[] {
  const out: ToolCallContent[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.length > 0) {
        out.push({ type: 'content', content: { type: 'text', text: part.text } });
      }
      continue;
    }
    out.push({ type: 'content', content: { type: 'text', text: `[${part.type}]` } });
  }
  return out;
}

export function toolOutcomeToAcpContent(outcome: ToolCallOutcome): ToolCallContent[] {
  if (outcome.type === 'succeeded') {
    return contentPartsToAcpToolCallContent(outcome.entry.message.content);
  }
  if (outcome.type === 'failed') {
    const text = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return text.length > 0 ? [{ type: 'content', content: { type: 'text', text } }] : [];
  }
  return [];
}

export function toolOutcomeRawOutput(outcome: ToolCallOutcome): unknown {
  if (outcome.type === 'succeeded') return outcome.entry.message.content;
  if (outcome.type === 'failed') {
    return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  }
  return undefined;
}

export function acpMcpServersToConfigRecord(
  servers: readonly McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (servers === undefined || servers.length === 0) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if (!('type' in server)) {
      out[server.name] = {
        transport: 'stdio',
        command: server.command,
        args: server.args,
        env: namedPairsToRecord(server.env),
        runtime_id: 'local',
      };
      continue;
    }
    if (server.type === 'http' || server.type === 'sse') {
      out[server.name] = {
        transport: server.type,
        url: server.url,
        headers: namedPairsToRecord(server.headers),
      };
      continue;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function namedPairsToRecord(
  pairs: readonly { readonly name: string; readonly value: string }[],
): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  return Object.fromEntries(pairs.map((p) => [p.name, p.value]));
}
