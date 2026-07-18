/**
 * IPC wire framing — newline-delimited JSON over a `node:net` stream. The
 * frame shapes deliberately mirror the `/api/v2/ws` protocol
 * (`hello`/`call`/`listen`/`unlisten` ↔ `ready`/`result`/`error`/
 * `listen_result`/`event`) so the two socket transports stay interchangeable;
 * only the byte pipe differs.
 */

/** One NDJSON message. `type` discriminates; other fields depend on it. */
export interface IpcFrame {
  readonly type: string;
  readonly id?: string;
  readonly scope?: string;
  readonly service?: string;
  readonly method?: string;
  readonly arg?: unknown;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly event?: string;
  readonly token?: string;
  readonly code?: number;
  readonly msg?: string;
  readonly data?: unknown;
}

export function encodeFrame(frame: IpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Incremental NDJSON decoder; malformed lines are dropped, mirroring the WS side. */
export class NdjsonDecoder {
  private buffer = '';

  push(chunk: string): IpcFrame[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const frames: IpcFrame[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line) as IpcFrame);
      } catch {
        // drop malformed frames
      }
    }
    return frames;
  }
}
