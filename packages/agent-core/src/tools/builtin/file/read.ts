import type { Kaos, KaosProcess, StatResult } from '@moonshot-ai/kaos';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';

import type { ExperimentalFlagResolver } from '../../../flags';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { resolvePathAccessPath } from '../../policies/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType } from '../../support/file-type';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { makeCarriageReturnsVisible, type LineEndingStyle } from './line-endings';
import readDescriptionTemplate from './read.md';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const PDF_TEXT_EXTRACTION_TIMEOUT_MS = 120_000;
const PDF_TEXT_EXTRACTION_MAX_STDERR_BYTES = 16 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a text file, including PDF files when experimental PDF text extraction is enabled. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      `The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed ${String(MAX_LINES)}.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of ${String(MAX_LINES)} lines.`,
    ),
});

export const ReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export type ReadInput = z.Infer<typeof ReadInputSchema>;
export type ReadOutput = z.Infer<typeof ReadOutputSchema>;

interface LineEndingFlags {
  hasCrLf: boolean;
  hasLf: boolean;
  hasLoneCr: boolean;
}

interface ReadLineEntry {
  readonly lineNo: number;
  readonly rawContent: string;
}

interface RenderedLine {
  readonly line: string;
  readonly wasTruncated: boolean;
}

interface FinishReadResultInput {
  readonly renderedLines: readonly string[];
  readonly truncatedLineNumbers: readonly number[];
  readonly maxLinesReached: boolean;
  readonly maxBytesReached: boolean;
  readonly lineEndingStyle: LineEndingStyle;
  readonly startLine: number;
  readonly totalLines: number;
  readonly requestedLines: number;
  readonly sourceKind?: string;
}

interface FinishEntriesReadResultInput {
  readonly entries: readonly ReadLineEntry[];
  readonly flags: LineEndingFlags;
  readonly maxLinesReached: boolean;
  readonly requestedLines: number;
  readonly startLine: number;
  readonly totalLines: number;
  readonly sourceKind?: string;
  readonly byteTruncationMode?: 'head' | 'tail';
}

interface CollectTextResult {
  readonly result?: ExecutableToolResult;
  readonly flags: LineEndingFlags;
  readonly totalLines: number;
}

interface StreamTextOptions {
  readonly onEntry: (entry: ReadLineEntry) => void;
}

interface CappedStreamResult {
  readonly text: string;
  readonly truncated: boolean;
}

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const marker = '...';
  const target = Math.max(maxLength, marker.length);
  return line.slice(0, target - marker.length) + marker;
}

function stripTrailingLf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function updateLineEndingFlags(flags: LineEndingFlags, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        flags.hasCrLf = true;
        i += 1;
      } else {
        flags.hasLoneCr = true;
      }
    } else if (code === 10) {
      flags.hasLf = true;
    }
  }
}

function lineEndingStyleFromFlags(flags: LineEndingFlags): LineEndingStyle {
  if (flags.hasLoneCr || (flags.hasCrLf && flags.hasLf)) return 'mixed';
  if (flags.hasCrLf) return 'crlf';
  return 'lf';
}

function renderLine(entry: ReadLineEntry, lineEndingStyle: LineEndingStyle): RenderedLine {
  const modelContent =
    lineEndingStyle === 'crlf' && entry.rawContent.endsWith('\r')
      ? entry.rawContent.slice(0, -1)
      : entry.rawContent;
  const truncated = truncateLine(modelContent, MAX_LINE_LENGTH);
  const renderedContent =
    lineEndingStyle === 'mixed' ? makeCarriageReturnsVisible(truncated) : truncated;
  return {
    line: `${String(entry.lineNo)}\t${renderedContent}`,
    wasTruncated: truncated !== modelContent,
  };
}

function renderedLineBytes(renderedLine: string, isFirst: boolean): number {
  return (isFirst ? 0 : 1) + Buffer.byteLength(renderedLine, 'utf8');
}

function isRegularFileMode(stMode: number): boolean {
  return (stMode & S_IFMT) === S_IFREG;
}

function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isTextDecodeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true;
  if (!(error instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(error.message);
}

function containsNulByte(text: string): boolean {
  return text.includes('\u0000');
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted|abort/i.test(error.message))
  );
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function pdftotextUnavailableOutput(): string {
  return (
    'PDF text extraction requires `pdftotext` from Poppler, but it was not found. ' +
    'Install Poppler (macOS: `brew install poppler`; Ubuntu/Debian: `sudo apt-get install poppler-utils`) and retry.'
  );
}

async function readStreamWithCap(stream: Readable, maxBytes: number): Promise<CappedStreamResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    if (truncated) continue;
    if (total + buf.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(buf.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      continue;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function collectTextLines(
  stream: Readable,
  options: StreamTextOptions,
): Promise<CollectTextResult> {
  const decoder = new StringDecoder('utf8');
  const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
  let totalLines = 0;
  let pending = '';

  const flushLine = (line: string): void => {
    totalLines += 1;
    updateLineEndingFlags(flags, line);
    const entry = {
      lineNo: totalLines,
      rawContent: stripTrailingLf(line),
    };
    options.onEntry(entry);
  };

  for await (const chunk of stream) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    pending += decoder.write(buf);
    let start = 0;
    for (let i = 0; i < pending.length; i += 1) {
      if (pending.codePointAt(i) !== 10) continue;
      flushLine(pending.slice(start, i + 1));
      start = i + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.end();
  if (pending.length > 0) {
    flushLine(pending);
  }

  return { flags, totalLines };
}

function pdfNotReadableOutput(path: string, reason: string): string {
  return `Failed to extract text from PDF "${path}" with pdftotext: ${reason}`;
}

function notReadableFileOutput(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    'If it is an image or video, use ReadMediaFile. ' +
    'For other binary formats, use Bash or an MCP tool if available.'
  );
}

const READ_DESCRIPTION = renderPrompt(readDescriptionTemplate, {
  MAX_LINES,
  MAX_BYTES_KB: MAX_BYTES / 1024,
  MAX_LINE_LENGTH,
});

export class ReadTool implements BuiltinTool<ReadInput> {
  readonly name = 'Read' as const;
  readonly description = READ_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadInputSchema);
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    private readonly experimentalFlags?: ExperimentalFlagResolver,
  ) {}

  resolveExecution(args: ReadInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: ({ signal }) => this.execution(args, path, signal),
    };
  }

  private async execution(
    args: ReadInput,
    safePath: string,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    try {
      let stat: StatResult;
      try {
        stat = await this.kaos.stat(safePath);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return { isError: true, output: `"${args.path}" does not exist.` };
        }
        throw error;
      }
      if (!isRegularFileMode(stat.stMode)) {
        return { isError: true, output: `"${args.path}" is not a file.` };
      }

      const header = await this.kaos.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header);
      if (fileType.kind === 'image' || fileType.kind === 'video') {
        return {
          isError: true,
          output: `"${args.path}" is a ${fileType.kind} file. Use ReadMediaFile to read image or video files.`,
        };
      }
      const lineOffset = args.line_offset ?? 1;
      const requestedLines = args.n_lines ?? MAX_LINES;
      const effectiveLimit = Math.min(requestedLines, MAX_LINES);

      if (fileType.kind === 'text' && fileType.mimeType === 'application/pdf') {
        if (this.experimentalFlags?.enabled('pdf_read') !== true) {
          return {
            isError: true,
            output:
              `"${args.path}" is a PDF file. PDF text extraction is experimental; ` +
              'enable KIMI_CODE_EXPERIMENTAL_PDF_READ to read it with pdftotext.',
          };
        }
        if (lineOffset < 0) {
          return await this.readPdfTail(
            safePath,
            args.path,
            lineOffset,
            effectiveLimit,
            requestedLines,
            signal,
          );
        }
        return await this.readPdfForward(
          safePath,
          args.path,
          lineOffset,
          effectiveLimit,
          requestedLines,
          signal,
        );
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output: notReadableFileOutput(args.path),
        };
      }

      if (lineOffset < 0) {
        return await this.readTail(
          safePath,
          args.path,
          lineOffset,
          effectiveLimit,
          requestedLines,
        );
      }
      return await this.readForward(
        safePath,
        args.path,
        lineOffset,
        effectiveLimit,
        requestedLines,
      );
    } catch (error) {
      if (isTextDecodeError(error)) {
        return { isError: true, output: notReadableFileOutput(args.path) };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readForward(
    safePath: string,
    displayPath: string,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
  ): Promise<ExecutableToolResult> {
    const selectedEntries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    let currentLineNo = 0;
    let maxLinesReached = false;
    let collectionClosed = false;

    for await (const rawLine of this.kaos.readLines(safePath, { errors: 'strict' })) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(displayPath) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      if (collectionClosed) {
        if (effectiveLimit >= MAX_LINES && currentLineNo >= lineOffset) {
          maxLinesReached = true;
        }
        continue;
      }
      if (currentLineNo < lineOffset) continue;
      if (selectedEntries.length >= effectiveLimit) {
        if (effectiveLimit >= MAX_LINES) {
          maxLinesReached = true;
        }
        collectionClosed = true;
        continue;
      }
      selectedEntries.push({
        lineNo: currentLineNo,
        rawContent: stripTrailingLf(rawLine),
      });
      if (selectedEntries.length >= effectiveLimit) {
        collectionClosed = true;
      }
    }

    return this.finishEntriesReadResult({
      entries: selectedEntries,
      flags,
      maxLinesReached,
      startLine: selectedEntries.length > 0 ? lineOffset : 0,
      totalLines: currentLineNo,
      requestedLines,
    });
  }

  private async readTail(
    safePath: string,
    displayPath: string,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
  ): Promise<ExecutableToolResult> {
    const tailCount = Math.abs(lineOffset);
    const entries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    let currentLineNo = 0;

    for await (const rawLine of this.kaos.readLines(safePath, { errors: 'strict' })) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(displayPath) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      entries.push({
        lineNo: currentLineNo,
        rawContent: stripTrailingLf(rawLine),
      });
      if (entries.length > tailCount) {
        entries.shift();
      }
    }

    const selected = entries.slice(0, effectiveLimit);
    return this.finishEntriesReadResult({
      entries: selected,
      flags,
      maxLinesReached: false,
      startLine: selected[0]?.lineNo ?? 0,
      totalLines: currentLineNo,
      requestedLines,
      byteTruncationMode: 'tail',
    });
  }

  private async readPdfForward(
    safePath: string,
    displayPath: string,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const selectedEntries: ReadLineEntry[] = [];
    let maxLinesReached = false;
    let collectionClosed = false;
    const extraction = await this.extractPdfText(safePath, displayPath, signal, {
      onEntry: (entry) => {
        if (collectionClosed) {
          if (effectiveLimit >= MAX_LINES && entry.lineNo >= lineOffset) {
            maxLinesReached = true;
          }
          return;
        }
        if (entry.lineNo < lineOffset) return;
        if (selectedEntries.length >= effectiveLimit) {
          if (effectiveLimit >= MAX_LINES) {
            maxLinesReached = true;
          }
          collectionClosed = true;
          return;
        }
        selectedEntries.push(entry);
        if (selectedEntries.length >= effectiveLimit) {
          collectionClosed = true;
        }
      },
    });
    if (extraction.result !== undefined) return extraction.result;

    return this.finishEntriesReadResult({
      entries: selectedEntries,
      flags: extraction.flags,
      maxLinesReached,
      requestedLines,
      startLine: selectedEntries.length > 0 ? lineOffset : 0,
      totalLines: extraction.totalLines,
      sourceKind: 'PDF',
    });
  }

  private async readPdfTail(
    safePath: string,
    displayPath: string,
    lineOffset: number,
    effectiveLimit: number,
    requestedLines: number,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const tailCount = Math.abs(lineOffset);
    const entries: ReadLineEntry[] = [];
    const extraction = await this.extractPdfText(safePath, displayPath, signal, {
      onEntry: (entry) => {
        entries.push(entry);
        if (entries.length > tailCount) {
          entries.shift();
        }
      },
    });
    if (extraction.result !== undefined) return extraction.result;

    const selected = entries.slice(0, effectiveLimit);
    return this.finishEntriesReadResult({
      entries: selected,
      flags: extraction.flags,
      maxLinesReached: false,
      requestedLines,
      startLine: selected[0]?.lineNo ?? 0,
      totalLines: extraction.totalLines,
      sourceKind: 'PDF',
      byteTruncationMode: 'tail',
    });
  }

  private async extractPdfText(
    safePath: string,
    displayPath: string,
    signal: AbortSignal,
    options: StreamTextOptions,
  ): Promise<CollectTextResult> {
    if (signal.aborted) {
      return {
        result: { isError: true, output: pdfNotReadableOutput(displayPath, 'aborted') },
        flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
        totalLines: 0,
      };
    }

    let proc: KaosProcess;
    try {
      proc = await this.kaos.exec('pdftotext', '-layout', '-enc', 'UTF-8', safePath, '-');
    } catch (error) {
      if (isEnoentError(error)) {
        return {
          result: { isError: true, output: pdftotextUnavailableOutput() },
          flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
          totalLines: 0,
        };
      }
      return {
        result: {
          isError: true,
          output: pdfNotReadableOutput(
            displayPath,
            error instanceof Error ? error.message : String(error),
          ),
        },
        flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
        totalLines: 0,
      };
    }

    try {
      proc.stdin.end();
    } catch {
      /* process already gone */
    }

    let timedOut = false;
    let aborted = false;
    let killed = false;
    const killProc = async (): Promise<void> => {
      if (killed) return;
      killed = true;
      try {
        await proc.kill('SIGTERM');
      } catch {
        /* process already gone */
      }
      try {
        proc.stdout.destroy();
      } catch {
        /* ignore */
      }
      try {
        proc.stderr.destroy();
      } catch {
        /* ignore */
      }
    };
    const onAbort = (): void => {
      aborted = true;
      void killProc();
    };
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) onAbort();

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProc();
    }, PDF_TEXT_EXTRACTION_TIMEOUT_MS);

    try {
      const [textResult, stderrResult, exitCode] = await Promise.all([
        collectTextLines(proc.stdout, options),
        readStreamWithCap(proc.stderr, PDF_TEXT_EXTRACTION_MAX_STDERR_BYTES),
        proc.wait(),
      ]);
      if (timedOut) {
        return {
          result: {
            isError: true,
            output: pdfNotReadableOutput(
              displayPath,
              `pdftotext timed out after ${String(PDF_TEXT_EXTRACTION_TIMEOUT_MS / 1000)}s`,
            ),
          },
          flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
          totalLines: 0,
        };
      }
      if (aborted) {
        return {
          result: { isError: true, output: pdfNotReadableOutput(displayPath, 'aborted') },
          flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
          totalLines: 0,
        };
      }
      if (exitCode !== 0) {
        const detail = stderrResult.text.trim() || `pdftotext exited with code ${String(exitCode)}`;
        return {
          result: { isError: true, output: pdfNotReadableOutput(displayPath, detail) },
          flags: textResult.flags,
          totalLines: textResult.totalLines,
        };
      }
      return textResult;
    } catch (error) {
      if (isAbortError(error)) {
        return {
          result: { isError: true, output: pdfNotReadableOutput(displayPath, 'aborted') },
          flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
          totalLines: 0,
        };
      }
      return {
        result: {
          isError: true,
          output: pdfNotReadableOutput(
            displayPath,
            error instanceof Error ? error.message : String(error),
          ),
        },
        flags: { hasCrLf: false, hasLf: false, hasLoneCr: false },
        totalLines: 0,
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private finishEntriesReadResult(input: FinishEntriesReadResultInput): ExecutableToolResult {
    const lineEndingStyle = lineEndingStyleFromFlags(input.flags);
    let renderedCandidates = input.entries.map((entry) => {
      return { entry, rendered: renderLine(entry, lineEndingStyle) };
    });

    let totalBytes = 0;
    for (const [index, candidate] of renderedCandidates.entries()) {
      totalBytes += renderedLineBytes(candidate.rendered.line, index === 0);
    }

    let maxBytesReached = false;
    if (totalBytes > MAX_BYTES) {
      maxBytesReached = true;
      const kept: typeof renderedCandidates = [];
      let bytes = 0;
      const iterateFromTail = input.byteTruncationMode === 'tail';
      const start = iterateFromTail ? renderedCandidates.length - 1 : 0;
      const end = iterateFromTail ? -1 : renderedCandidates.length;
      const step = iterateFromTail ? -1 : 1;
      for (let i = start; i !== end; i += step) {
        const candidate = renderedCandidates[i];
        if (candidate === undefined) continue;
        const lineBytes = renderedLineBytes(candidate.rendered.line, kept.length === 0);
        if (bytes + lineBytes > MAX_BYTES && (iterateFromTail || kept.length > 0)) break;
        if (iterateFromTail) {
          kept.unshift(candidate);
        } else {
          kept.push(candidate);
        }
        bytes += lineBytes;
      }
      renderedCandidates = kept;
    }

    const renderedLines: string[] = [];
    const truncatedLineNumbers: number[] = [];
    for (const candidate of renderedCandidates) {
      renderedLines.push(candidate.rendered.line);
      if (candidate.rendered.wasTruncated) {
        truncatedLineNumbers.push(candidate.entry.lineNo);
      }
    }

    return this.finishReadResult({
      renderedLines,
      truncatedLineNumbers,
      maxLinesReached: input.maxLinesReached,
      maxBytesReached,
      lineEndingStyle,
      startLine: renderedCandidates[0]?.entry.lineNo ?? input.startLine,
      totalLines: input.totalLines,
      requestedLines: input.requestedLines,
      sourceKind: input.sourceKind,
    });
  }

  private finishReadResult(input: FinishReadResultInput): ExecutableToolResult {
    return {
      output: this.finishOutput(input.renderedLines, this.finishMessage(input)),
    };
  }

  private finishOutput(renderedLines: readonly string[], message: string): string {
    const rendered = renderedLines.join('\n');
    const status = `<system>${message}</system>`;
    return rendered.length > 0 ? `${rendered}\n${status}` : status;
  }

  private finishMessage(input: FinishReadResultInput): string {
    const lineCount = input.renderedLines.length;
    const lineWord = lineCount === 1 ? 'line' : 'lines';
    const parts =
      lineCount > 0
        ? [
            `${String(lineCount)} ${lineWord} read from ${input.sourceKind ?? 'file'} starting from line ${String(input.startLine)}.`,
          ]
        : [`No lines read from ${input.sourceKind ?? 'file'}.`];

    parts.push(`Total lines in file: ${String(input.totalLines)}.`);
    if (input.maxLinesReached) {
      parts.push(`Max ${String(MAX_LINES)} lines reached.`);
    } else if (input.maxBytesReached) {
      parts.push(`Max ${String(MAX_BYTES)} bytes reached.`);
    } else if (lineCount < input.requestedLines) {
      parts.push('End of file reached.');
    }
    if (input.truncatedLineNumbers.length > 0) {
      parts.push(`Lines [${input.truncatedLineNumbers.join(', ')}] were truncated.`);
    }
    if (input.lineEndingStyle === 'mixed') {
      parts.push(
        'Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
      );
    }
    return parts.join(' ');
  }
}
