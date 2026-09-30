import { isDeepStrictEqual } from 'node:util';

import {
  isMediaPart,
  mediaKindOfPart,
  type ContentPart,
  type ToolResult,
} from '@moonshot-ai/agent-core';

import {
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isModelAcceptedImageMime,
  resolveEffectiveImageMime,
} from '#/features/media/inspect/format-policy';
import type { MediaStore } from '#/features/media/store';
import { compressImageForModel } from '#/features/media/transform/compress';

import type { MCPContentBlock, MCPToolResult } from './client-shared';

export interface McpOutputOptions {
  readonly signal?: AbortSignal;
  readonly mediaStore?: MediaStore;
  readonly providerType?: string;
}

export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

function droppedBlockNotice(reason: string): ContentPart {
  return { type: 'text', text: `[MCP content dropped: ${reason}]` };
}

export function convertMCPContentBlock(block: MCPContentBlock, providerType?: string): ContentPart {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      source: { kind: 'inline', mimeType, data: block.data },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      source: { kind: 'inline', mimeType, data: block.data },
    };
  }

  if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null) {
    const res = block.resource;
    if (typeof res.text === 'string') {
      return { type: 'text', text: res.text };
    }
    if (typeof res.blob === 'string') {
      const mimeType = res.mimeType ?? 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        return {
          type: 'image_url',
          source: { kind: 'inline', mimeType, data: res.blob },
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          type: 'audio_url',
          source: { kind: 'inline', mimeType, data: res.blob },
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          type: 'video_url',
          source: { kind: 'inline', mimeType, data: res.blob },
        };
      }
      const approxMb = ((res.blob.length * 3) / 4 / (1024 * 1024)).toFixed(1);
      return droppedBlockNotice(
        `resource blob with unsupported mimeType "${mimeType}" (~${approxMb} MB, uri: ${res.uri}) was not delivered.`,
      );
    }
    return droppedBlockNotice(`resource (uri: ${res.uri}) carried no text or blob payload.`);
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      if (!isModelAcceptedImageMime(mimeType, providerType)) {
        return {
          type: 'text',
          text: buildUnsupportedImageNotice(mimeType, block.uri, providerType),
        };
      }
      return { type: 'image_url', source: { kind: 'url', url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', source: { kind: 'url', url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', source: { kind: 'url', url: block.uri } };
    }
    return droppedBlockNotice(
      `resource_link with unsupported mimeType "${mimeType}" was not delivered. Fetch it directly if needed: ${block.uri}`,
    );
  }

  return droppedBlockNotice(`content block of unsupported type "${block.type}" was not delivered.`);
}

export async function mcpResultToToolResult(
  result: MCPToolResult,
  qualifiedToolName: string,
  options: McpOutputOptions = {},
): Promise<ToolResult> {
  options.signal?.throwIfAborted();
  const converted: ContentPart[] = [];
  for (const block of result.content) {
    options.signal?.throwIfAborted();
    const part = convertMCPContentBlock(block, options.providerType);
    converted.push(await offloadInlineImage(part, options));
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const hasStructuredCopy = result.structuredContent !== undefined && converted.some((part) => {
    if (part.type !== 'text') return false;
    try {
      return isDeepStrictEqual(parseComparableJson(part.text), result.structuredContent);
    } catch {
      return false;
    }
  });
  const structuredExtras: Record<string, unknown> = {};
  if (result.structuredContent !== undefined && !hasStructuredCopy) {
    structuredExtras['structuredContent'] = result.structuredContent;
  }
  if (result._meta !== undefined) {
    const meta = stripReservedMetaKeys(result._meta);
    if (meta !== undefined) {
      structuredExtras['_meta'] = meta;
    }
  }
  if (Object.keys(structuredExtras).length > 0) {
    const serialized = serializeStructuredExtras(structuredExtras);
    if (serialized !== undefined) {
      wrapped.push({
        type: 'text',
        text: `\n<mcp-result-extras>\n${serialized}\n</mcp-result-extras>`,
      });
    }
  }

  const capped = applyBinaryPartCap(wrapped);
  return { content: capped, isError: result.isError === true ? true : undefined };
}

async function offloadInlineImage(part: ContentPart, options: McpOutputOptions): Promise<ContentPart> {
  const store = options.mediaStore;
  if (part.type !== 'image_url' || part.source.kind !== 'inline' || store === undefined) return part;
  const source = part.source;
  try {
    const mime = source.mimeType.startsWith('image/')
      ? resolveEffectiveImageMime(source.mimeType, decodeBase64Prefix(source.data))
      : source.mimeType;
    const bytes = Buffer.from(source.data.replaceAll(/\s/g, ''), 'base64');
    const compressed = await compressImageForModel(new Uint8Array(bytes), mime);
    const ref = await store.put({
      bytes: compressed.data,
      mimeType: compressed.mimeType,
      filename: `mcp-image.${compressed.mimeType.split('/')[1] ?? 'bin'}`,
    });
    options.signal?.throwIfAborted();
    return { ...part, source: { kind: 'store', ref } };
  } catch (error) {
    options.signal?.throwIfAborted();
    return part;
  }
}

function parseComparableJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && context?.source !== JSON.stringify(value)) {
      throw new Error('JSON number cannot be compared without normalization');
    }
    return value;
  });
}

function serializeStructuredExtras(extras: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(extras).replaceAll('<', '\\u003c');
  } catch {
    return undefined;
  }
}

function stripReservedMetaKeys(
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!isReservedMetaKey(key)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isReservedMetaKey(key: string): boolean {
  const slash = key.indexOf('/');
  if (slash <= 0) return false;
  const labels = key.slice(0, slash).split('.');
  return labels.some(
    (label, i) =>
      (label === 'modelcontextprotocol' || label === 'mcp') && i < labels.length - 1,
  );
}

function wrapMediaOnly(parts: readonly ContentPart[], qualifiedToolName: string): ContentPart[] {
  const hasMedia = parts.some(
    (p) => p.type === 'image_url' || p.type === 'audio_url' || p.type === 'video_url',
  );
  const hasNonEmptyText = parts.some((p) => p.type === 'text' && p.text.length > 0);
  if (!hasMedia || hasNonEmptyText) return [...parts];
  return [
    { type: 'text', text: `<mcp_tool_result name="${qualifiedToolName}">` },
    ...parts,
    { type: 'text', text: '</mcp_tool_result>' },
  ];
}

function applyBinaryPartCap(parts: readonly ContentPart[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (!isMediaPart(part)) {
      out.push(part);
      continue;
    }
    const source = part.source;
    const payloadLength =
      source.kind === 'inline'
        ? source.data.length
        : source.kind === 'url'
          ? source.url.length
          : source.kind === 'store'
            ? source.ref.length
            : source.id.length;
    if (payloadLength > MCP_MAX_BINARY_PART_CHARS) {
      out.push({
        type: 'text',
        text: binaryPartTooLargeNotice(mediaKindOfPart(part), payloadLength),
      });
      continue;
    }
    out.push(part);
  }
  return out;
}
