import type {
  ExecutableToolErrorResult,
  ExecutableToolSuccessResult,
} from '../../loop/types';

// ── Native module loading (lazy, with TS fallback) ──────────────────────────

type NativeWriteChunkResult = {
  readonly output: string;
  readonly charsWritten: number;
  readonly newNchars: number;
  readonly truncated: boolean;
};

let nativeFn:
  | ((
      text: string,
      currentNchars: number,
      maxChars: number,
      maxLineLength: number | null,
      alreadyTruncated: boolean,
    ) => NativeWriteChunkResult)
  | null
  | undefined;

function getNative() {
  if (nativeFn === null) return undefined;
  if (nativeFn !== undefined) return nativeFn;
  try {
    const mod = require('@moonshot-ai/kimi-native-tools');
    nativeFn =
      typeof mod?.nativeWriteToolOutputChunk === 'function'
        ? mod.nativeWriteToolOutputChunk
        : null;
    return nativeFn ?? undefined;
  } catch {
    nativeFn = null;
    return undefined;
  }
}

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;
const TRUNCATION_MARKER = '[...truncated]';
const TRUNCATION_MESSAGE = 'Output is truncated to fit in the message.';

export interface ToolResultBuilderOptions {
  readonly maxChars?: number;
  readonly maxLineLength?: number | null;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolSuccessResult
  | ExecutableToolErrorResult
) & {
  readonly output: string;
  readonly message: string;
  readonly truncated: boolean;
  readonly brief?: string;
};

export class ToolResultBuilder {
  private readonly maxChars: number;
  private readonly maxLineLength: number | null;

  private readonly buffer: string[] = [];
  private nCharsValue = 0;
  private truncationHappened = false;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxLineLength =
      options.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : options.maxLineLength;

    if (this.maxLineLength !== null && this.maxLineLength <= TRUNCATION_MARKER.length) {
      throw new Error('maxLineLength must be greater than the truncation marker length.');
    }
  }

  get nChars(): number {
    return this.nCharsValue;
  }

  get truncated(): boolean {
    return this.truncationHappened;
  }

  write(text: string): number {
    const fn = getNative();
    if (fn !== undefined) {
      return this.writeNative(fn, text);
    }
    return this.writeTs(text);
  }

  private writeNative(
    fn: ((
      text: string,
      currentNchars: number,
      maxChars: number,
      maxLineLength: number | null,
      alreadyTruncated: boolean,
    ) => NativeWriteChunkResult),
    text: string,
  ): number {
    const result = fn(
      text,
      this.nCharsValue,
      this.maxChars,
      this.maxLineLength,
      this.truncationHappened,
    );
    if (result.output.length > 0) {
      this.buffer.push(result.output);
    }
    this.nCharsValue = result.newNchars;
    this.truncationHappened = result.truncated;
    return result.charsWritten;
  }

  private writeTs(text: string): number {
    if (this.nCharsValue >= this.maxChars) {
      if (text.length > 0 && !this.truncationHappened) {
        this.buffer.push(TRUNCATION_MARKER);
        this.nCharsValue += TRUNCATION_MARKER.length;
        this.truncationHappened = true;
      }
      return 0;
    }

    const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    let charsWritten = 0;
    for (const originalLine of lines) {
      if (this.nCharsValue >= this.maxChars) {
        if (!this.truncationHappened) {
          this.buffer.push(TRUNCATION_MARKER);
          this.nCharsValue += TRUNCATION_MARKER.length;
          this.truncationHappened = true;
        }
        break;
      }

      const remainingChars = this.maxChars - this.nCharsValue;
      const limit =
        this.maxLineLength === null
          ? remainingChars
          : Math.min(remainingChars, this.maxLineLength);
      let line = originalLine;
      if (line.length > limit) {
        const lineBreak = /[\r\n]+$/.exec(line)?.[0] ?? '';
        const suffix = TRUNCATION_MARKER + lineBreak;
        const effectiveMaxLength = Math.max(limit, suffix.length);
        line = line.slice(0, effectiveMaxLength - suffix.length) + suffix;
      }
      if (line !== originalLine) {
        this.truncationHappened = true;
      }

      this.buffer.push(line);
      charsWritten += line.length;
      this.nCharsValue += line.length;
    }

    return charsWritten;
  }

  ok(message = '', options: { readonly brief?: string } = {}): ExecutableToolResultBuilderResult {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    if (this.truncationHappened) {
      finalMessage =
        finalMessage.length === 0 ? TRUNCATION_MESSAGE : `${finalMessage} ${TRUNCATION_MESSAGE}`;
    }

    const output = this.buffer.join('');
    const shouldAppendMessage =
      finalMessage.length > 0 && (this.truncationHappened || output.length === 0);
    return {
      isError: false,
      output: shouldAppendMessage
        ? output.length === 0
          ? finalMessage
          : output.endsWith('\n')
            ? `${output}${finalMessage}`
            : `${output}\n${finalMessage}`
        : output,
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }

  error(
    message: string,
    options: { readonly brief?: string } = {},
  ): ExecutableToolResultBuilderResult {
    const finalMessage = this.truncationHappened
      ? message.length === 0
        ? TRUNCATION_MESSAGE
        : `${message} ${TRUNCATION_MESSAGE}`
      : message;
    const output = this.buffer.join('');
    return {
      isError: true,
      output:
        finalMessage.length === 0
          ? output
          : output.length === 0
            ? finalMessage
            : output.endsWith('\n')
              ? `${output}${finalMessage}`
              : `${output}\n${finalMessage}`,
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }
}
