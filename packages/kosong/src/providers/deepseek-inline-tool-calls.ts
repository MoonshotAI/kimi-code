import type { ToolCall } from '#/message';

/**
 * Defensive fallback for DeepSeek-V3 style **inline** tool calls.
 *
 * DeepSeek-architecture models (deepseek-v3/r1 and derivatives such as
 * cogito-2.1) emit tool calls in a special-token format rather than as OpenAI
 * `tool_calls`. The official DeepSeek API parses this server-side and returns
 * structured `tool_calls`, but many OpenAI-compatible deployments — self-hosted
 * vLLM / SGLang / llama.cpp, ollama, and some proxies — do NOT, and instead leak
 * the raw tokens into the assistant `content`:
 *
 *   <|tool▁calls▁begin|>
 *     <|tool▁call▁begin|>function<|tool▁sep|>NAME
 *     ```json
 *     { ...arguments... }
 *     ```<|tool▁call▁end|>      (repeated for parallel calls)
 *   <|tool▁calls▁end|>
 *
 * The bar is either ASCII `|` (U+007C, as ollama-cloud emits) or the tokenizer's
 * full-width `｜` (U+FF5C, as raw vLLM/SGLang/llama.cpp leaks); separators are
 * `▁` (U+2581). The outer `…calls▁begin…` wrapper is sometimes omitted and the
 * block starts straight at a per-call `…call▁begin…` (see vllm-project/vllm#21727),
 * so detection anchors on either boundary.
 *
 * When this happens the agent sees no tool call and the turn dead-ends. This
 * module parses those tokens client-side so the call can still be dispatched. It
 * is applied ONLY when the provider returned no structured tool call AND a block
 * boundary is present, so it is a no-op for every well-behaved provider/model.
 */

const SEP = '▁'; // U+2581
const BAR = '[|｜]'; // ASCII U+007C or full-width U+FF5C

/** First block boundary: a calls-begin OR a call-begin token, either bar. */
const BLOCK_START = new RegExp(`<${BAR}tool${SEP}calls?${SEP}begin${BAR}>`);

// One call: <…call▁begin…>[function]<…sep…>NAME ```[json] {ARGS} ```
const CALL_RE = new RegExp(
  `<${BAR}tool${SEP}call${SEP}begin${BAR}>\\s*(?:function)?\\s*<${BAR}tool${SEP}sep${BAR}>\\s*([A-Za-z0-9_.-]+)\\s*` +
    '```(?:json)?\\s*([\\s\\S]*?)```',
  'g',
);

/** Canonical ASCII calls-begin sentinel (documentation / convenience). */
export const DEEPSEEK_TOOL_CALLS_BEGIN = `<|tool${SEP}calls${SEP}begin|>`;

// Longest sentinel we might hold back while detecting a marker split across deltas.
const MAX_MARKER_LEN = DEEPSEEK_TOOL_CALLS_BEGIN.length;

/** Index of the first DeepSeek tool-call block boundary in `content`, or -1. */
export function firstBlockStart(content: string): number {
  const match = BLOCK_START.exec(content);
  return match ? match.index : -1;
}

/**
 * Parse DeepSeek inline tool-call tokens from assistant content into structured
 * {@link ToolCall}s. Calls whose argument block is not valid JSON are skipped,
 * so a partially corrupted emission yields the calls it can rather than throwing.
 */
export function parseDeepSeekInlineToolCalls(content: string): ToolCall[] {
  if (typeof content !== 'string' || firstBlockStart(content) < 0) {
    return [];
  }
  const calls: ToolCall[] = [];
  CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_RE.exec(content)) !== null) {
    const name = (match[1] ?? '').trim();
    const args = (match[2] ?? '').trim();
    if (name.length === 0) continue;
    try {
      JSON.parse(args);
    } catch {
      continue;
    }
    calls.push({ type: 'function', id: crypto.randomUUID(), name, arguments: args });
  }
  return calls;
}

/**
 * Streaming-safe filter that lets text deltas through live until a DeepSeek
 * tool-call block begins, then suppresses the raw tokens (so they never reach the
 * UI) while accumulating the full content for {@link parseDeepSeekInlineToolCalls}.
 *
 * A small trailing holdback covers a block-start marker that straddles two deltas.
 * Once the provider emits a structured tool call ({@link releaseHoldback}) no
 * inline leak is possible, so the filter releases any held text and passes the
 * rest through verbatim — preserving ordering for well-behaved providers.
 */
export class DeepSeekInlineToolCallFilter {
  private buffer = '';
  private full = '';
  private suppressing = false;
  private passthrough = false;

  /** Feed a content delta; returns the text safe to yield now (possibly empty). */
  push(delta: string): string {
    this.full += delta;
    if (this.passthrough) return delta;
    if (this.suppressing) return '';
    this.buffer += delta;
    const idx = firstBlockStart(this.buffer);
    if (idx >= 0) {
      const out = this.buffer.slice(0, idx);
      this.suppressing = true;
      this.buffer = '';
      return out;
    }
    const holdback = MAX_MARKER_LEN - 1;
    if (this.buffer.length > holdback) {
      const out = this.buffer.slice(0, this.buffer.length - holdback);
      this.buffer = this.buffer.slice(this.buffer.length - holdback);
      return out;
    }
    return '';
  }

  /**
   * The provider emitted a structured tool call, so no inline leak is possible.
   * Release any held-back text (in order) and stop buffering subsequent deltas —
   * this keeps a short preamble from being reordered after the tool-call parts.
   *
   * No-op once suppression has begun: if an inline block was already detected we
   * must keep stripping it rather than flip to passthrough (which would leak the
   * remainder of the block as visible text).
   */
  releaseHoldback(): string {
    if (this.suppressing) return '';
    this.passthrough = true;
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /**
   * Remaining buffered text once the stream ends (empty if a block was
   * suppressed). Idempotent: the buffer is cleared, so a second call returns ''.
   */
  flush(): string {
    if (this.suppressing) return '';
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** Whether a block-start marker was seen (and the rest of content suppressed). */
  get sawToolBlock(): boolean {
    return this.suppressing;
  }

  /** Full accumulated content (for parsing). */
  get content(): string {
    return this.full;
  }
}
