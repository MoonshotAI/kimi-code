import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import {
  log,
  type PromptPart,
  type ToolInputDisplay,
  type ToolResultEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { isHideOutputMarker } from './marker';

/**
 * Convert an array of ACP {@link ContentBlock}s into the SDK's
 * {@link PromptPart} array.
 *
 * Phase 9.1 lifts `image` blocks into `image_url` parts: per the ACP
 * schema (`ImageContent` at types.gen.d.ts:1905-1920) the `data` field
 * is a raw base64-encoded payload accompanied by a required `mimeType`,
 * so the data URL is constructed at the adapter boundary as
 * `data:<mimeType>;base64,<data>`. We treat `data` as opaque base64 —
 * if a caller pre-wraps it as a `data:` URL the prefix detection isn't
 * worth the complexity and that string lands inside another `data:`
 * envelope (documented limitation; ACP spec says base64, so callers
 * conforming to spec are unaffected).
 *
 * Phase 9.2 inlines `resource_link` and `resource` (EmbeddedResource)
 * blocks as XML-flavoured text the model can read directly:
 *   - `resource_link` → `<resource_link uri="..." name="..." />`
 *   - `resource` with TextResourceContents → `<resource uri="...">text</resource>`
 *   - `resource` with BlobResourceContents → dropped with a warn
 *     (per PLAN D3: "blob 忽略并 warn").
 * Attribute values are escaped via {@link escapeXmlAttr}.
 *
 * `audio` blocks remain dropped with a warn.
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

/**
 * Convert an SDK {@link ToolInputDisplay} block into an ACP
 * {@link ToolCallContent} entry, when (and only when) the block carries
 * structured before/after text suitable for a diff view or a Phase 13.2
 * plan-review markdown body.
 *
 * Mapped variants:
 *  - `kind: 'diff'` — always rendered (both `before` and `after` are
 *    required on the schema).
 *  - `kind: 'file_io'` with **both** `before` and `after` populated —
 *    matches the Edit tool's display payload; rendered as a diff too.
 *  - `kind: 'plan_review'` — rendered as a text block via
 *    {@link composePlanContent} so the ACP client surfaces the full plan
 *    markdown (and the optional `Plan saved to:` path prefix) at the top
 *    of the approval prompt. Empty plans defensively return `null` —
 *    the policy already guarantees non-empty, but the adapter must not
 *    trust that to avoid emitting a blank content entry.
 *
 * All other display kinds (command, search, url_fetch, agent_call,
 * skill_call, todo_list, …) return `null` and the caller drops them.
 * Phase 7 will add a `terminal` variant; Phase 9 may add image/resource.
 */
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
