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
 *  3. Apply the 100K text/think character budget to the tool's own text.
 *     This runs BEFORE captions exist, so a chatty tool (page text + a
 *     screenshot) can never evict or slice the compression caption — that
 *     would silently reintroduce the very degradation the caption reports.
 *  4. Compress oversized inline images, announcing each compression with a
 *     caption (original vs. sent size, readback path to the persisted
 *     original) so downsampling is never silent. The captions ride the
 *     result's `note` side channel — projected to the model at fold time, but
 *     kept out of `output` so UIs never render them.
 *  5. Apply the per-part 10 MB binary cap: oversized binary parts
 *     (image/audio/video URLs) collapse to a notice, so a single
 *     screenshot cannot evict every text part.
 *  6. Collapse a single-text-part result to a plain string output; otherwise
 *     emit the `ContentPart[]` as-is.
 *
 * `mcpResultToExecutableOutput` is the single entry point; the per-step
 * helpers stay private so callers cannot bypass the limits.
 */

import type { ContentPart } from '#/app/llmProtocol/message';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import { compressImageContentParts } from '#/agent/media/image-compress';
import {
  buildUnsupportedImageNotice,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { persistOriginalImage } from '#/agent/media/image-originals';
import type { MCPContentBlock, MCPToolResult } from './types';

export interface McpOutputOptions {
  /**
   * Session-owned directory for pre-compression originals (typically
   * `sessionMediaOriginalsDir(sessionDir)` threaded down from the agent).
   * Falls back to the shared temp-dir cache when absent.
   */
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
}

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
      // The declared MIME is the only format signal for a remote image: an
      // extensionless or signed URL gives the extension gate nothing to work
      // with, and the provider fetches it server-side. When the server
      // honestly declares a format providers reject (e.g. an image search
      // tool returning AVIF links), drop the image for a notice that keeps
      // the URL — the model can still fetch and convert it.
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
  // Text budget FIRST, on the tool's own text only: captions inserted by the
  // compression step below must never compete with a chatty tool's text for
  // the budget — an evicted or mid-string-sliced caption silently
  // reintroduces the downsampling this pipeline promises to announce.
  const budgeted = applyTextBudget(wrapped);
  // Shrink oversized images BEFORE the per-part byte cap, so a large but
  // compressible screenshot is downsampled and kept rather than dropped to a
  // text notice. Compression is never silent: each re-encoded image gains a
  // caption stating what the original was, and the original bytes are
  // persisted (best effort, into the session's media-originals dir when
  // known) so the model can read detail back via ReadMediaFile + region.
  // Parts that cannot be compressed pass through.
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
 * Apply the 100K text/think budget. Runs before image compression, so only
 * the tool's own text is charged — compression captions inserted afterwards
 * are exempt by construction. Binary parts pass through untouched (their
 * independent per-part cap is {@link applyBinaryPartCap}).
 *
 * When text/think parts get truncated, the truncation notice is appended to
 * the last surviving text part — this keeps the single-text-part collapse
 * working when the entire (oversized) input is a single text block.
 */
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

/**
 * Apply the per-part 10 MB binary cap, independent of the text character
 * budget. Oversized parts collapse into a per-part notice so the model can
 * pick a smaller resource instead of silently losing the blob. Runs after
 * image compression, so a large but compressible image has already been
 * shrunk under the cap.
 */
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
