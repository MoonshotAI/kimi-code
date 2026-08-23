import type { ContentBlock, McpServer, ToolCallContent } from '@agentclientprotocol/sdk';
import {
  buildImageCompressionCaption,
  compressBase64ForModel,
  type ContentPart,
  gateImageFormatParts,
  type McpServerConfig,
  parseImageDataUrl,
  persistOriginalImage,
} from '@moonshot-ai/agent-core-v2';
import type { ToolInputDisplay, ToolResultEvent } from '@moonshot-ai/protocol';

import { log } from './log';
import { isHideOutputMarker } from './marker';

/**
 * Convert an array of ACP {@link ContentBlock}s into agent-core-v2
 * {@link ContentPart}s suitable for a user `ContextMessage`'s `content`.
 *
 * Image parts are built from the client-declared MIME verbatim; run the
 * result through {@link compressPromptImageParts} before submitting so
 * unsupported formats are dropped and MIME aliases canonicalized. Audio and
 * blob embedded resources are dropped with a warning (ACP
 * `promptCapabilities` currently advertise audio as unsupported).
 */
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
        // TextResourceContents — wrap as a `<resource>` element so the
        // model sees the uri provenance alongside the text body.
        const text = `<resource uri="${escapeXmlAttr(resource.uri)}">${resource.text}</resource>`;
        out.push({ type: 'text', text });
        continue;
      }
      // BlobResourceContents — drop+warn.
      log.warn('acp: dropping blob embedded resource', {
        uri: resource.uri,
        mimeType: resource.mimeType,
      });
      continue;
    }
    // Future-proof: anything else (new ACP block kinds) → warn and drop.
    log.warn('acp: dropping unsupported prompt content block', {
      type: (block as { type: string }).type,
    });
  }
  return out;
}

/**
 * Shrink oversized inline images in a prompt-part list — the ACP ingestion
 * point's input-stage compression, mirroring kap-server's upload-time step
 * (`resolvePromptMediaFiles`). Best effort: a part that cannot be compressed
 * is passed through unchanged.
 *
 * This is NOT duplicated by the engine: agent-core-v2's prompt pipeline
 * (`agent/prompt/promptService.ts`) only *extracts* pre-existing compression
 * captions from user text (rerouting them to system reminders) — it never
 * gates or compresses images at the prompt entry, so the edge ingestion point
 * owns the step.
 *
 * The format gate (`gateImageFormatParts`) runs first: parts whose MIME is
 * outside the provider-accepted set are never forwarded — the part is
 * dropped and a text notice stands in, so one unsupported image cannot
 * poison the session history; accepted MIME aliases (`image/jpg`,
 * case/whitespace variants) are rewritten to the canonical form strict
 * provider whitelists require.
 *
 * Compression is never silent: a re-encoded image gains a caption text part
 * immediately before it stating what the original was, and the original bytes
 * are persisted (into `originalsDir` — typically the session's
 * media-originals dir — or the shared temp-dir fallback) so the model can
 * read fine detail back via ReadMediaFile + region.
 */
export async function compressPromptImageParts(
  parts: readonly ContentPart[],
  options: {
    readonly originalsDir?: string | undefined;
    /**
     * Longest-edge ceiling (px) override. The ACP server runs the engine
     * in-process, so the Agent-scope `ImageConfigBridge` has already pushed
     * the env-resolved `[image]` config section into the compression module's
     * global seam — leave this `undefined` (the default) and the configured /
     * built-in cap applies. The override exists for tests.
     */
    readonly maxImageEdgePx?: number | undefined;
  } = {},
): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const part of gateImageFormatParts(parts)) {
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

/**
 * Convert ACP `session/new` / `session/load` `mcpServers` — a named array
 * discriminated by `type` (absent = stdio) — into the engine's name-keyed
 * {@link McpServerConfig} record. Returns `undefined` for an absent/empty
 * list (or when every entry was dropped) so the engine builds no session
 * overlay. The unstable `type: 'acp'` transport is unsupported and dropped
 * with a warning.
 */
export function acpMcpServersToConfigRecord(
  servers: readonly McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (servers === undefined || servers.length === 0) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if (!('type' in server)) {
      throw new Error(`ACP stdio MCP server ${server.name} does not declare a runtime identity`);
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

/** ACP env/header lists are `{name, value}` arrays; the engine wants a record. */
function namedPairsToRecord(
  pairs: readonly { readonly name: string; readonly value: string }[],
): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  return Object.fromEntries(pairs.map((p) => [p.name, p.value]));
}

/**
 * Minimum-viable XML-attribute escaping for prompt-embedded resource
 * wrappers. The output is consumed by an LLM, not parsed by a canonical
 * XML parser, so we only escape the five characters that would change the
 * apparent tag structure: `&`, `<`, `>`, `"`, `'`. `&` must run
 * first to avoid double-escaping the entities introduced by the others.
 */
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

  // `file://server/share/a.ts` is the URI form of a Windows UNC path
  // (`\\server\share\a.ts`). `URL.pathname` only carries `/share/a.ts`; the
  // host is part of the file location, so keep it in the projected text ref.
  // `file://localhost/...` is still treated as local. Host is lower-cased so
  // `file://Server/...` and `file://server/...` collapse to one ref.
  const host = url.hostname.toLowerCase();
  const isUncHost = host !== '' && host !== 'localhost';

  // Drive-letter normalization is local-only: a UNC URI never legitimately
  // carries `/C:/...` in its path, so we leave such inputs untouched rather
  // than stripping a leading slash that would alter the UNC payload.
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

/**
 * Project a {@link ToolInputDisplay} block into an ACP {@link ToolCallContent}
 * entry for the tool-call card. Diff/file_io blocks become inline diffs;
 * plan_review becomes a text content entry; everything else yields `null`
 * (the caller drops it).
 */
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

/**
 * Render the text body of a `plan_review` display block. Empty plan → `null`
 * (caller drops the entry). When `block.path` is set, prefix with the on-disk
 * location so the client can show it alongside the markdown body.
 */
function composePlanContent(
  block: Extract<ToolInputDisplay, { kind: 'plan_review' }>,
): string | null {
  if (block.plan.trim().length === 0) return null;
  if (block.path !== undefined) {
    return `Plan saved to: ${block.path}\n\n${block.plan}`;
  }
  return block.plan;
}

/**
 * Convert a {@link ToolResultEvent}'s `output` into ACP
 * {@link ToolCallContent} entries.
 *
 * A non-empty string is passed through as a text block; objects/arrays are
 * JSON-stringified (best-effort — falls back to a placeholder on circular
 * structures). Empty/undefined/null output yields an empty array — the caller
 * still emits a `tool_call_update` so the client sees the status transition
 * to completed/failed.
 *
 * Diff content does NOT come from this function: `ToolResultEvent` has no
 * `display` field; diffs attach to `ToolCallStartedEvent.display` and are
 * emitted by `toolCallStartToSessionUpdate`.
 */
export function toolResultToAcpContent(event: ToolResultEvent): ToolCallContent[] {
  const out = event.output;
  // Array output containing the HideOutputMarker tells the adapter to suppress
  // this tool's textual content entirely (e.g. terminal output routed through
  // its own reverse-RPC channel). Detected before any other processing so
  // mark-bearing outputs never leak even a stringified preview.
  if (Array.isArray(out) && out.some(isHideOutputMarker)) {
    return [];
  }
  if (out === undefined || out === null) return [];
  if (typeof out === 'string') {
    if (out.length === 0) return [];
    return [{ type: 'content', content: { type: 'text', text: out } }];
  }
  // Best-effort stringify for object/array outputs.
  let text: string;
  try {
    text = JSON.stringify(out);
  } catch {
    text = '[object]';
  }
  if (!text) return [];
  return [{ type: 'content', content: { type: 'text', text } }];
}
