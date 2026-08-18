import type { ContentPart } from '#/kosong/contract/message';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

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

export const MCP_MAX_OUTPUT_CHARS = 100_000;
const MCP_OUTPUT_TRUNCATED_TEXT = `\n\n[Output truncated: exceeded ${String(
  MCP_MAX_OUTPUT_CHARS,
)} character limit. Use pagination or more specific queries to get remaining content.]`;

export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

export function convertMCPContentBlock(block: MCPContentBlock): ContentPart | null {
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
      return null;
    }
    return null;
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
    return null;
  }

  return null;
}

export async function mcpResultToExecutableOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
  options: McpOutputOptions = {},
): Promise<{
  output: string | ContentPart[];
  isError: boolean;
  note?: string;
  truncated?: true;
}> {
  const converted: ContentPart[] = [];
  for (const block of result.content) {
    const part = convertMCPContentBlock(block);
    if (part !== null) {
      converted.push(part);
    }
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const structuredExtras: Record<string, unknown> = {};
  if (result.structuredContent !== undefined) {
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
        text: `\n<mcp-structured-result>\n${serialized}\n</mcp-structured-result>`,
      });
    }
  }

  const budgeted = applyTextBudget(wrapped);
  const compressed = await compressImageContentParts(budgeted.parts, {
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
  const truncated = budgeted.truncated || capped.truncated;
  const output = collapseSingleText(capped.parts);
  const note = compressed.captions.length > 0 ? compressed.captions.join('\n') : undefined;
  return {
    output,
    isError: result.isError,
    note,
    truncated: truncated ? true : undefined,
  };
}

function serializeStructuredExtras(extras: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(extras).replaceAll('</mcp-structured-result>', '');
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

function applyTextBudget(parts: readonly ContentPart[]): {
  readonly parts: ContentPart[];
  readonly truncated: boolean;
} {
  let remaining = MCP_MAX_OUTPUT_CHARS;
  let truncated = false;
  const out: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      if (part.text.length > remaining) {
        out.push({ type: 'text', text: part.text.slice(0, remaining) });
        remaining = 0;
        truncated = true;
      } else {
        out.push(part);
        remaining -= part.text.length;
      }
      continue;
    }

    if (part.type === 'think') {
      const size = part.think.length + (part.encrypted?.length ?? 0);
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      if (size > remaining) {
        out.push({ type: 'think', think: part.think.slice(0, remaining) });
        remaining = 0;
        truncated = true;
      } else {
        out.push(part);
        remaining -= size;
      }
      continue;
    }

    out.push(part);
  }

  if (truncated) {
    appendTruncationNotice(out);
  }
  return { parts: out, truncated };
}

function applyBinaryPartCap(parts: readonly ContentPart[]): {
  readonly parts: ContentPart[];
  readonly truncated: boolean;
} {
  let truncated = false;
  const out: ContentPart[] = [];

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
      out.push({ type: 'text', text: binaryPartTooLargeNotice(kind, url.length) });
      truncated = true;
      continue;
    }
    out.push(part);
  }

  return { parts: out, truncated };
}

function appendTruncationNotice(out: ContentPart[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i];
    if (candidate?.type === 'text') {
      out[i] = { type: 'text', text: candidate.text + MCP_OUTPUT_TRUNCATED_TEXT };
      return;
    }
  }
  out.push({ type: 'text', text: MCP_OUTPUT_TRUNCATED_TEXT });
}

function collapseSingleText(parts: readonly ContentPart[]): string | ContentPart[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
