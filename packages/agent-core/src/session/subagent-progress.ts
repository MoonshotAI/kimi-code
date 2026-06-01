/**
 * Live progress feed for a background subagent task. Buffers formatted event
 * text emitted between `spawn()` and the manager's `subscribe()`, replaying it
 * on subscription so no early output is lost. Single-consumer (the manager).
 */

import type { AgentEvent } from '../rpc';

export class SubagentProgress {
  private buffer: string[] = [];
  private live: ((chunk: string) => void) | undefined;

  push(chunk: string): void {
    if (chunk.length === 0) return;
    if (this.live !== undefined) {
      this.live(chunk);
    } else {
      this.buffer.push(chunk);
    }
  }

  subscribe(onChunk: (chunk: string) => void): () => void {
    // Replay the backlog as one chunk — each delivery is a separate output.log
    // append downstream, so joining keeps it as coarse as live coalescing.
    if (this.buffer.length > 0) onChunk(this.buffer.join(''));
    this.buffer = [];
    this.live = onChunk;
    return () => {
      if (this.live === onChunk) this.live = undefined;
    };
  }
}

/**
 * Format a child-agent event into log text, or `undefined` to skip it. Compact
 * by design: tool results become a one-line status (a Read can be megabytes),
 * prose comes from `assistant.delta`, thinking deltas are dropped as noise.
 */
export function formatSubagentEvent(event: AgentEvent): string | undefined {
  if (event.type === 'assistant.delta') return event.delta;
  if (event.type === 'tool.call.started') {
    const suffix = event.description !== undefined ? ` — ${event.description}` : '';
    return `\n\n$ ${event.name}${suffix}\n`;
  }
  if (event.type === 'tool.result') {
    return event.isError === true ? '  ✗ tool error\n' : '  ✓ done\n';
  }
  if (event.type === 'turn.ended') {
    return event.reason === 'completed' ? undefined : `\n[turn ${event.reason}]\n`;
  }
  return undefined;
}
