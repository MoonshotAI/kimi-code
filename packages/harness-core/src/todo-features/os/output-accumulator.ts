export const DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000;

export const DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS = 10_000_000;

export class ToolOutputAccumulator {
  private readonly buffer: string[] = [];
  private retainedChars = 0;
  private totalCharsValue = 0;

  get nChars(): number {
    return this.retainedChars;
  }

  get totalChars(): number {
    return this.totalCharsValue;
  }

  write(text: string): void {
    this.totalCharsValue += text.length;
    if (this.retainedChars >= DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS) return;
    const remainingRetention = DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS - this.retainedChars;
    const kept = text.length <= remainingRetention ? text : text.slice(0, remainingRetention);
    this.buffer.push(kept);
    this.retainedChars += kept.length;
  }

  snapshot(): string {
    return this.buffer.join('');
  }

  ok(message = ''): string {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    const output = this.buffer.join('');
    return output.length === 0 ? finalMessage : output;
  }

  error(message: string): string {
    const output = this.buffer.join('');
    if (message.length === 0) return output;
    if (output.length === 0) return message;
    return output.endsWith('\n') ? `${output}${message}` : `${output}\n${message}`;
  }
}
