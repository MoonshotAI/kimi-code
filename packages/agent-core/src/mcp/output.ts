/**
 * MCP tool-call result → ExecutableTool output pipeline.
 *
 * Owns the full path from "MCP protocol content blocks" to "what the agent
 * loop feeds back to the model":
 *  1. Convert each {@link MCPContentBlock} to a kosong `ContentPart`
 *     (dropping unsupported shapes).
 *  2. Wrap media-only outputs in `<mcp_tool_result name="…">` tags so the
 *     model can attribute binary output when several tools return media.
 *     Mirrors the in-tree `ReadMediaFile` convention.
 *  3. Apply size limits: text/think share a 100K character budget; binary
 *     parts (image/audio/video URLs) each carry an independent 10 MB cap and
 *     collapse to a notice when oversize, so a single screenshot cannot
 *     evict every text part.
 *  4. Collapse a single-text-part result to a plain string output; otherwise
 *     emit the `ContentPart[]` as-is.
 *
 * `mcpResultToExecutableOutput` is the single entry point; the per-step
 * helpers stay private so callers cannot bypass the limits.
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import { compressImageContentParts } from '../tools/support/image-compress';
import type { MCPContentBlock, MCPToolResult } from './types';

// MCP servers can produce arbitrarily large outputs; cap what we feed back to
// the model so a single chatty server does not blow up the context window. The
// notice text is fed to the model verbatim so it can react (e.g. paginate),
// which is why the limits live in the agent layer rather than in kosong.
export const MCP_MAX_OUTPUT_CHARS = 100_000;
const MCP_OUTPUT_TRUNCATED_TEXT = `\n\n[Output truncated: exceeded ${String(
  MCP_MAX_OUTPUT_CHARS,
)} character limit. Use pagination or more specific queries to get remaining content.]`;

// Binary parts (image_url / audio_url / video_url) have an independent per-part
// byte cap and do NOT share the text character budget. base64 length is not a
// useful proxy for multimodal model cost, and a single screenshot is enough to
// evict every text part if both compete for the same 100k budget.
export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

/**
 * Convert a single MCP content block into a kosong {@link ContentPart}.
 *
 * Returns `null` for block types that cannot be represented (e.g. unknown
 * resource shapes) so the caller can drop them.
 */
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

  // EmbeddedResource: payload is nested under `resource`, as
  // TextResourceContents (`text`) or BlobResourceContents (`blob`).
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

  // ResourceLink: URL reference, not an inline blob.
  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
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

/**
 * Convert an `MCPToolResult` into the success-shape `ExecutableToolResult`
 * output the agent loop expects.
 *
 * `qualifiedToolName` is the agent-side qualified name (e.g.
 * `mcp__github__create_pr`) — embedded into the `<mcp_tool_result name="…">`
 * wrap when the result is media-only, so the model can attribute binary parts.
 */
export async function mcpResultToExecutableOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
): Promise<{ output: string | ContentPart[]; isError: boolean; truncated?: true }> {
  const converted: ContentPart[] = [];
  for (const block of result.content) {
    const part = convertMCPContentBlock(block);
    if (part !== null) {
      converted.push(part);
    }
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  // Shrink oversized images BEFORE the per-part byte cap, so a large but
  // compressible screenshot is downsampled and kept rather than dropped to a
  // text notice. Best effort: parts that cannot be compressed pass through.
  const compressed = await compressImageContentParts(wrapped);
  const limited = applyOutputLimits(compressed);
  const output = collapseSingleText(limited.parts);
  return limited.truncated
    ? { output, isError: result.isError, truncated: true }
    : { output, isError: result.isError };
}

/**
 * If `parts` contains media but no non-empty text, surround it with
 * `<mcp_tool_result name="…">` text tags so the model can attribute the
 * binary content. Returns the input untouched otherwise.
 */
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

/**
 * Apply the 100K text/think budget and the per-part 10 MB binary cap.
 *
 * When text/think parts get truncated, the truncation notice is appended to
 * the last surviving text part — this keeps the single-text-part collapse
 * working when the entire (oversized) input is a single text block.
 */
function applyOutputLimits(parts: readonly ContentPart[]): {
  readonly parts: ContentPart[];
  readonly truncated: boolean;
} {
  let remaining = MCP_MAX_OUTPUT_CHARS;
  let truncated = false;
  let textTruncated = false;
  const out: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (remaining <= 0) {
        truncated = true;
        textTruncated = true;
        continue;
      }
      if (part.text.length > remaining) {
        out.push({ type: 'text', text: part.text.slice(0, remaining) });
        remaining = 0;
        truncated = true;
        textTruncated = true;
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
        textTruncated = true;
        continue;
      }
      if (size > remaining) {
        out.push({ type: 'think', think: part.think.slice(0, remaining) });
        remaining = 0;
        truncated = true;
        textTruncated = true;
      } else {
        out.push(part);
        remaining -= size;
      }
      continue;
    }

    // image_url / audio_url / video_url: per-part byte cap, independent of the
    // text character budget. Oversized parts collapse into a per-part notice so
    // the model can pick a smaller resource instead of silently losing the blob.
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

  if (textTruncated) {
    appendTruncationNotice(out);
  }
  return { parts: out, truncated };
}

function appendTruncationNotice(out: ContentPart[]): void {
  // Merge the notice into the last text part so the very common
  // "single oversized text" case still collapses to a plain string. Falls
  // back to a standalone notice part if there is no text part to merge with.
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
