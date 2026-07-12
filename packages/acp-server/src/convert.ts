import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import { type ContentPart } from '@moonshot-ai/agent-core-v2';
import type { ToolInputDisplay, ToolResultEvent } from '@moonshot-ai/protocol';

import { log } from './log';
import { isHideOutputMarker } from './marker';

/**
 * Convert an array of ACP {@link ContentBlock}s into agent-core-v2
 * {@link ContentPart}s suitable for a user `ContextMessage`'s `content`.
 *
 * Image blocks are passed through as `image_url` data URLs (input-stage
 * compression is a later phase). Audio and blob embedded resources are dropped
 * with a warning (ACP `promptCapabilities` currently advertise audio as
 * unsupported).
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
function composePlanContent(block: Extract<ToolInputDisplay, { kind: 'plan_review' }>): string | null {
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
    text = typeof out === 'object' && out !== null ? '[object]' : String(out);
  }
  if (!text) return [];
  return [{ type: 'content', content: { type: 'text', text } }];
}
