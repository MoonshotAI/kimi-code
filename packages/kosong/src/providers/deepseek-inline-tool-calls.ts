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
 * (the bars are ASCII U+007C, the separators are U+2581). When that happens the
 * agent sees no tool call and the turn dead-ends. This module parses those tokens
 * client-side so the call can still be dispatched. It is applied ONLY when the
 * provider returned no structured tool call AND the begin token is present, so it
 * is a no-op for every well-behaved provider/model.
 */

const SEP = '▁'; // ▁
export const DEEPSEEK_TOOL_CALLS_BEGIN = `<|tool${SEP}calls${SEP}begin|>`;

// <|tool▁call▁begin|>[function]<|tool▁sep|>NAME ```[json] {ARGS} ```
const CALL_RE = new RegExp(
  `<\\|tool${SEP}call${SEP}begin\\|>\\s*(?:function)?\\s*<\\|tool${SEP}sep\\|>\\s*([A-Za-z0-9_.-]+)\\s*` +
    '```(?:json)?\\s*([\\s\\S]*?)```',
  'g',
);

/**
 * Parse DeepSeek inline tool-call tokens from assistant content into structured
 * {@link ToolCall}s. Calls whose argument block is not valid JSON are skipped,
 * so a partially corrupted emission yields the calls it can rather than throwing.
 */
export function parseDeepSeekInlineToolCalls(content: string): ToolCall[] {
  if (typeof content !== 'string' || !content.includes(DEEPSEEK_TOOL_CALLS_BEGIN)) {
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
 * Streaming-safe filter that lets text deltas through live until the DeepSeek
 * tool-call block begins, then suppresses the raw tokens (so they never reach the
 * UI) while still accumulating the full content for {@link parseDeepSeekInlineToolCalls}.
 *
 * A small trailing holdback covers a begin-marker that straddles two deltas.
 */
export class DeepSeekInlineToolCallFilter {
  private readonly marker = DEEPSEEK_TOOL_CALLS_BEGIN;
  private buffer = '';
  private full = '';
  private suppressing = false;

  /** Feed a content delta; returns the text safe to yield now (possibly empty). */
  push(delta: string): string {
    this.full += delta;
    if (this.suppressing) return '';
    this.buffer += delta;
    const idx = this.buffer.indexOf(this.marker);
    if (idx >= 0) {
      const out = this.buffer.slice(0, idx);
      this.suppressing = true;
      this.buffer = '';
      return out;
    }
    const holdback = this.marker.length - 1;
    if (this.buffer.length > holdback) {
      const out = this.buffer.slice(0, this.buffer.length - holdback);
      this.buffer = this.buffer.slice(this.buffer.length - holdback);
      return out;
    }
    return '';
  }

  /** Remaining buffered text once the stream ends (empty if a block was suppressed). */
  flush(): string {
    return this.suppressing ? '' : this.buffer;
  }

  /** Whether the begin marker was seen. */
  get sawToolBlock(): boolean {
    return this.suppressing;
  }

  /** Full accumulated content (for parsing). */
  get content(): string {
    return this.full;
  }
}
