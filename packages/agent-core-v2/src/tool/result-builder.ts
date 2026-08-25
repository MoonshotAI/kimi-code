import { BugIndicatingError } from '#/errors';

import type { ExecutableToolErrorResult, ExecutableToolSuccessResult } from './toolContract';

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;
const DEFAULT_MAX_RETAINED_CHARS = 10_000_000;
const TRUNCATION_MARKER = '[...truncated]';
const TRUNCATION_MESSAGE = 'Output is truncated to fit in the message.';

export interface ToolResultBuilderOptions {
  readonly maxChars?: number;
  readonly maxLineLength?: number | null;
  readonly retainFullOutput?: boolean;
  readonly maxRetainedChars?: number;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolErrorResult
  | ExecutableToolSuccessResult
) & {
  readonly output: string;
  readonly truncated: boolean;
  readonly brief?: string;
  readonly untruncatedOutput?: string;
  readonly untruncatedOutputTotalChars?: number;
};

export class ToolResultBuilder {
  private readonly maxChars: number;
  private readonly maxLineLength: number | null;
  private readonly maxRetainedChars: number;

  private readonly buffer: string[] = [];
  private readonly retained: string[] | null = null;
  private retainedChars = 0;
  private nCharsValue = 0;
  private totalCharsValue = 0;
  private truncationHappened = false;
  private charCapTruncationHappened = false;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxLineLength =
      options.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : options.maxLineLength;
    this.maxRetainedChars = options.maxRetainedChars ?? DEFAULT_MAX_RETAINED_CHARS;
    if (options.retainFullOutput === true) {
      this.retained = [];
    }

    if (this.maxLineLength !== null && this.maxLineLength <= TRUNCATION_MARKER.length) {
      throw new BugIndicatingError('maxLineLength must be greater than the truncation marker length.');
    }
  }

  get nChars(): number {
    return this.nCharsValue;
  }

  get totalChars(): number {
    return this.totalCharsValue;
  }

  get truncated(): boolean {
    return this.truncationHappened;
  }

  write(text: string): number {
    this.totalCharsValue += text.length;
    if (this.retained !== null && this.retainedChars < this.maxRetainedChars) {
      const remainingRetention = this.maxRetainedChars - this.retainedChars;
      const kept = text.length <= remainingRetention ? text : text.slice(0, remainingRetention);
      this.retained.push(kept);
      this.retainedChars += kept.length;
    }
    if (this.nCharsValue >= this.maxChars) {
      if (text.length > 0) {
        this.charCapTruncationHappened = true;
        if (!this.truncationHappened) {
          this.buffer.push(TRUNCATION_MARKER);
          this.nCharsValue += TRUNCATION_MARKER.length;
          this.truncationHappened = true;
        }
      }
      return 0;
    }

    const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    let charsWritten = 0;
    for (const originalLine of lines) {
      if (this.nCharsValue >= this.maxChars) {
        this.charCapTruncationHappened = true;
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
        if (line.length > remainingChars) {
          this.charCapTruncationHappened = true;
        }
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
      truncated: this.truncationHappened,
      brief: options.brief,
      ...this.fullOutputFields(),
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
      truncated: this.truncationHappened,
      brief: options.brief,
      ...this.fullOutputFields(),
    };
  }

  private fullOutputFields(): {
    readonly untruncatedOutput?: string;
    readonly untruncatedOutputTotalChars?: number;
  } {
    if (this.retained === null || !this.charCapTruncationHappened) return {};
    return {
      untruncatedOutput: this.retained.join(''),
      untruncatedOutputTotalChars: this.totalCharsValue,
    };
  }
}
