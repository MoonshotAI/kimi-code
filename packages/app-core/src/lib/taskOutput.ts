export const TASK_OUTPUT_STREAM_MAX_CHARS = 256 * 1024;

export interface TaskOutputBuffer {
  readonly text: string;
  readonly endOffset: number;
}

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function applyTaskOutputChunk(
  buffer: TaskOutputBuffer | undefined,
  offset: number,
  text: string,
): TaskOutputBuffer {
  const endOffset = offset + utf8ByteLength(text);
  const merged = buffer !== undefined && buffer.endOffset === offset ? buffer.text + text : text;
  return { text: trimTaskOutput(merged), endOffset };
}

function trimTaskOutput(text: string): string {
  if (text.length <= TASK_OUTPUT_STREAM_MAX_CHARS) return text;
  const cut = text.length - TASK_OUTPUT_STREAM_MAX_CHARS;
  const lineStart = text.indexOf('\n', cut);
  if (lineStart !== -1) return text.slice(lineStart + 1);
  return text.slice(isLowSurrogate(text.charCodeAt(cut)) ? cut + 1 : cut);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
