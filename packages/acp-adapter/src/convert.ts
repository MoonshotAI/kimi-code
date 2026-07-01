import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import {
  log,
  compressBase64ForModel,
  type PromptPart,
  type ToolInputDisplay,
  type ToolResultEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { isHideOutputMarker } from './marker';

/**
 * Convert an array of ACP {@link ContentBlock}s into the SDK's
 * {@link PromptPart} array.
 *
 */
export function acpBlocksToPromptParts(
  blocks: readonly ContentBlock[],
): readonly PromptPart[] {
  const out: PromptPart[] = [];
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
      const text = `<resource_link uri="${escapeXmlAttr(
        block.uri,
      )}" name="${escapeXmlAttr(block.name)}" />`;
      out.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource) {
        // TextResourceContents — wrap as a `<resource>` element so the
        // model sees the uri provenance alongside the text body.
        const text = `<resource uri="${escapeXmlAttr(resource.uri)}">${
          resource.text
        }</resource>`;
        out.push({ type: 'text', text });
        continue;
      }
      // BlobResourceContents — D3 mandates drop+warn.
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
 * point's input-stage compression, mirroring the CLI's paste-time and the
 * server's upload-time step. Best effort: a part that cannot be compressed is
 * passed through unchanged.
 */
export async function compressPromptImageParts(
  parts: readonly PromptPart[],
): Promise<PromptPart[]> {
  const out: PromptPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed !== null) {
        const result = await compressBase64ForModel(parsed.base64, parsed.mimeType);
        if (result.changed) {
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

function parseImageDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

/**
 * Minimum-viable XML-attribute escaping for prompt-embedded resource
 * wrappers. The output is consumed by an LLM, not parsed by a canonical
 * XML parser, so we only escape the five characters that would change
 * the apparent tag structure: `&`, `<`, `>`, `"`, `'`. `&` must run
 * first to avoid double-escaping the entities introduced by the others.
 */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

export function displayBlockToAcpContent(
  block: ToolInputDisplay,
): ToolCallContent | null {
  if (block.kind === 'diff') {
    return {
      type: 'diff',
      path: block.path,
      oldText: block.before,
      newText: block.after,
    };
  }
  if (
    block.kind === 'file_io' &&
    block.before !== undefined &&
    block.after !== undefined
  ) {
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
 * Render the text body of a `plan_review` display block:
 *  - When `block.plan` (after trimming) is empty, return `null` — the
 *    caller drops the content entry rather than surfacing a blank
 *    headline. The policy at
 *    `packages/agent-core/src/tools/builtin/planning/exit-plan-mode.ts:110`
 *    already guarantees a non-empty plan; this guard exists so the
 *    adapter does not depend on that invariant.
 *  - When `block.path` is set, prefix the plan with `Plan saved to:
 *    <path>` so the ACP client can show the on-disk location alongside
 *    the markdown body. Otherwise emit the plan markdown alone.
 *
 * The output is consumed by the ACP client as plain text inside a
 * `tool_call_update` content entry; no markdown-specific escaping is
 * needed (markdown is the content type, not a wire-format escape
 * concern).
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
 * Phase 4 keeps the mapping intentionally simple: a non-empty string is
 * passed through as a text block; objects/arrays are JSON-stringified
 * (best-effort — falls back to `String(value)` on circular structures).
 * Empty/undefined/null output yields an empty array — the caller still
 * emits a `tool_call_update` so the client sees the status transition
 * to completed/failed.
 *
 * Diff content does NOT come from this function: `ToolResultEvent` has
 * no `display` field; diffs attach to `ToolCallStartedEvent.display`
 * and are emitted by `toolCallStartToSessionUpdate`.
 */
export function toolResultToAcpContent(event: ToolResultEvent): ToolCallContent[] {
  const out = event.output;
  // Mechanism A — array output containing the HideOutputMarker tells
  // the adapter to suppress this tool's textual content entirely
  // (e.g. AcpTerminalTool emits via terminal/* reverse-RPC, so
  // routing the bytes through tool_call_update would double-render
  // in the client UI). Detected before any other processing so
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
    // eslint-disable-next-line no-base-to-string
    text = typeof out === 'object' && out !== null ? '[object]' : String(out);
  }
  if (!text) return [];
  return [{ type: 'content', content: { type: 'text', text } }];
}
