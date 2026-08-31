import type { ContentPart } from '#/kosong/contract/message';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { compressImageContentParts } from '#/agent/media/image-compress';
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { persistOriginalImage } from '#/agent/media/image-originals';
import type { MCPContentBlock, MCPToolResult } from '#/mcpCore/types';

export interface McpOutputOptions {
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
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

export function convertMCPContentBlock(block: MCPContentBlock): ContentPart {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      audioUrl: { url: `data:${mimeType};base64,${block.data}` },
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
          imageUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          type: 'audio_url',
          audioUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          type: 'video_url',
          videoUrl: { url: `data:${mimeType};base64,${res.blob}` },
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
      if (!isModelAcceptedImageMime(mimeType)) {
        return { type: 'text', text: buildUnsupportedImageNotice(mimeType, block.uri) };
      }
      return { type: 'image_url', imageUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', audioUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', videoUrl: { url: block.uri } };
    }
    return droppedBlockNotice(
      `resource_link with unsupported mimeType "${mimeType}" was not delivered. Fetch it directly if needed: ${block.uri}`,
    );
  }

  return droppedBlockNotice(`content block of unsupported type "${block.type}" was not delivered.`);
}

export async function mcpResultToExecutableOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
  options: McpOutputOptions = {},
): Promise<ExecutableToolResult> {
  const converted: ContentPart[] = [];
  for (const block of result.content) {
    converted.push(convertMCPContentBlock(block));
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const hasUsableContent = converted.some((part) =>
    part.type === 'text' ? part.text.trim().length > 0 : true,
  );
  const structuredExtras: Record<string, unknown> = {};
  if (result.structuredContent !== undefined && !hasUsableContent) {
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

  const compressed = await compressImageContentParts(wrapped, {
    telemetry:
      options.telemetry === undefined
        ? undefined
        : { client: options.telemetry, source: 'mcp_tool_result' },
    annotate: {
      persistOriginal: (bytes, mimeType) =>
        persistOriginalImage(
          bytes,
          mimeType,
          options.originalsDir === undefined ? {} : { dir: options.originalsDir },
        ),
    },
  });
  const capped = applyBinaryPartCap(compressed.parts);
  const output = collapseSingleText(capped.parts);
  const note = compressed.captions.length > 0 ? compressed.captions.join('\n') : undefined;
  const base = {
    output,
    note,
    truncated: capped.truncated ? true : undefined,
    spill: capped.notices.length > 0 ? { suffix: capped.notices.join('\n') } : undefined,
  };
  return result.isError ? { ...base, isError: true } : base;
}

function serializeStructuredExtras(extras: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(extras).replaceAll('</mcp-result-extras>', '');
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

function applyBinaryPartCap(parts: readonly ContentPart[]): {
  readonly parts: ContentPart[];
  readonly truncated: boolean;
  readonly notices: string[];
} {
  let truncated = false;
  const out: ContentPart[] = [];
  const notices: string[] = [];

  for (const part of parts) {
    if (part.type === 'text' || part.type === 'think') {
      out.push(part);
      continue;
    }

    const url =
      part.type === 'image_url'
        ? part.imageUrl.url
        : part.type === 'audio_url'
          ? part.audioUrl.url
          : part.videoUrl.url;
    if (url.length > MCP_MAX_BINARY_PART_CHARS) {
      const kind =
        part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'video';
      const notice = binaryPartTooLargeNotice(kind, url.length);
      out.push({ type: 'text', text: notice });
      notices.push(notice);
      truncated = true;
      continue;
    }
    out.push(part);
  }

  return { parts: out, truncated, notices };
}

function collapseSingleText(parts: readonly ContentPart[]): string | ContentPart[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
