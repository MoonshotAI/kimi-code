import type { ContentBlock, McpServer, ToolCallContent } from '@agentclientprotocol/sdk';
import {
  buildImageCompressionCaption,
  compressBase64ForModel,
  type ContentPart,
  type McpServerConfig,
  parseImageDataUrl,
  persistOriginalImage,
} from '@moonshot-ai/agent-core-v2';
import type { ToolResultEvent } from '@moonshot-ai/agent-core-v2/events';
import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';

import { log } from './log';
import { isHideOutputMarker } from './marker';

export function acpBlocksToContentParts(blocks: readonly ContentBlock[]): readonly ContentPart[] {
  const out: ContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const url = `data:${block.mimeType};base64,${block.data}`;
      out.push({ type: 'image_url', imageUrl: { url } });
      continue;
    }
    if (block.type === 'audio') {
      log.warn('acp: dropping unsupported audio prompt block', {
        mimeType: block.mimeType,
      });
      continue;
    }
    if (block.type === 'resource_link') {
      const fileRef = fileLinkToTextRef(block.uri);
      if (fileRef !== null) {
        out.push({ type: 'text', text: fileRef });
        continue;
      }
      const text = `<resource_link uri="${escapeXmlAttr(block.uri)}" name="${escapeXmlAttr(
        block.name,
      )}" />`;
      out.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource) {
        const text = `<resource uri="${escapeXmlAttr(resource.uri)}">${resource.text}</resource>`;
        out.push({ type: 'text', text });
        continue;
      }
      log.warn('acp: dropping blob embedded resource', {
        uri: resource.uri,
        mimeType: resource.mimeType,
      });
      continue;
    }
    log.warn('acp: dropping unsupported prompt content block', {
      type: (block as { type: string }).type,
    });
  }
  return out;
}

export async function compressPromptImageParts(
  parts: readonly ContentPart[],
  options: {
    readonly originalsDir?: string | undefined;
    readonly maxImageEdgePx?: number | undefined;
  } = {},
): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed !== null) {
        const result = await compressBase64ForModel(parsed.base64, parsed.mimeType, {
          maxEdge: options.maxImageEdgePx,
        });
        if (result.changed) {
          const originalPath = await persistOriginalImage(
            Buffer.from(parsed.base64, 'base64'),
            parsed.mimeType,
            { dir: options.originalsDir },
          );
          out.push({
            type: 'text',
            text: buildImageCompressionCaption({
              original: {
                width: result.originalWidth,
                height: result.originalHeight,
                byteLength: result.originalByteLength,
                mimeType: parsed.mimeType,
              },
              final: {
                width: result.width,
                height: result.height,
                byteLength: result.finalByteLength,
                mimeType: result.mimeType,
              },
              originalPath,
            }),
          });
          out.push({
            type: 'image_url',
            imageUrl: { ...part.imageUrl, url: `data:${result.mimeType};base64,${result.base64}` },
          });
          continue;
        }
      }
    }
    out.push(part);
  }
  return out;
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
    log.warn('acp: dropping unsupported MCP server transport', {
      name: server.name,
      type: server.type,
    });
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function namedPairsToRecord(
  pairs: readonly { readonly name: string; readonly value: string }[],
): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  return Object.fromEntries(pairs.map((p) => [p.name, p.value]));
}

function escapeXmlAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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

export function displayBlockToAcpContent(block: ToolInputDisplay): ToolCallContent | null {
  if (block.kind === 'diff') {
    return {
      type: 'diff',
      path: block.path,
      oldText: block.before,
      newText: block.after,
    };
  }
  if (block.kind === 'file_io' && block.before !== undefined && block.after !== undefined) {
    return {
      type: 'diff',
      path: block.path,
      oldText: block.before,
      newText: block.after,
    };
  }
  if (block.kind === 'plan_review') {
    const text = composePlanContent(block);
    if (text === null) return null;
    return { type: 'content', content: { type: 'text', text } };
  }
  return null;
}

function composePlanContent(
  block: Extract<ToolInputDisplay, { kind: 'plan_review' }>,
): string | null {
  if (block.plan.trim().length === 0) return null;
  if (block.path !== undefined) {
    return `Plan saved to: ${block.path}\n\n${block.plan}`;
  }
  return block.plan;
}

export function toolResultToAcpContent(event: ToolResultEvent): ToolCallContent[] {
  const out = event.output;
  if (Array.isArray(out) && out.some(isHideOutputMarker)) {
    return [];
  }
  if (out === undefined || out === null) return [];
  if (typeof out === 'string') {
    if (out.length === 0) return [];
    return [{ type: 'content', content: { type: 'text', text: out } }];
  }
  let text: string;
  try {
    text = JSON.stringify(out);
  } catch {
    text = '[object]';
  }
  if (!text) return [];
  return [{ type: 'content', content: { type: 'text', text } }];
}
