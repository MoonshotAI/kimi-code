export const LIVE_OUTPUT_MAX_CHARS = 50_000;
export const LIVE_OUTPUT_INTERVAL_MS = 250;
const TRUNCATED_MARKER = '[…truncated]\n';

interface CallOutput {
  text: string;
  truncated: boolean;
  nextOffset: number;
  unsent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class LiveToolOutput {
  private readonly calls = new Map<string, CallOutput>();

  constructor(private readonly show: (toolCallId: string, text: string) => void) {}

  append(toolCallId: string, offset: number, text: string): void {
    const call = this.calls.get(toolCallId) ?? { text: '', truncated: false, nextOffset: 0, unsent: false };
    if (offset !== call.nextOffset || text.length === 0) return;
    this.calls.set(toolCallId, call);
    call.nextOffset += Buffer.byteLength(text);
    const combined = call.text + text;
    call.truncated ||= combined.length > LIVE_OUTPUT_MAX_CHARS;
    call.text = combined.length > LIVE_OUTPUT_MAX_CHARS ? combined.slice(-LIVE_OUTPUT_MAX_CHARS) : combined;
    call.unsent = true;
    if (call.timer === undefined) this.send(toolCallId, call);
  }

  end(toolCallId: string): void {
    clearTimeout(this.calls.get(toolCallId)?.timer);
    this.calls.delete(toolCallId);
  }

  dispose(): void {
    for (const call of this.calls.values()) clearTimeout(call.timer);
    this.calls.clear();
  }

  private send(toolCallId: string, call: CallOutput): void {
    call.unsent = false;
    this.show(toolCallId, call.truncated ? `${TRUNCATED_MARKER}${call.text}` : call.text);
    call.timer = setTimeout(() => {
      call.timer = undefined;
      if (call.unsent) this.send(toolCallId, call);
    }, LIVE_OUTPUT_INTERVAL_MS);
    call.timer.unref?.();
  }
}
