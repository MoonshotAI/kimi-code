/**
 * `fileTools` domain — ReadTool, the model's UTF-8 text file reader.
 *
 * Renders a text file as `<line-number>\t<content>` per line as `output`, and
 * rides a `<system>…</system>` status block on the `note` side channel
 * (rendered to the model at projection time, never to UIs) summarizing how
 * much was read (line and byte counts, truncation, and line-ending notes).
 * Pure CRLF files are displayed with LF line endings; mixed or lone carriage
 * returns are shown as `\r` so the model can reproduce them exactly.
 *
 * Binary, non-UTF-8, NUL-containing, image and video files are refused;
 * images/videos are redirected to ReadMediaFile. Supports one-based
 * `line_offset` / `n_lines` pagination and a negative `line_offset` tail mode,
 * bounded by the per-call line/byte caps.
 *
 * Path safety goes through the shared path access resolver used by
 * Read/Write/Edit. Read access flows through the os `hostFs` domain
 * (`IHostFileSystem`); path semantics (home expansion, path class) come from
 * the `hostEnvironment` domain.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/read.ts`). The
 * optional `scanTextFile` / `readLineRange` / `readTailLines` fast-paths are
 * intentionally dropped: `IHostFileSystem` streams through `readLines` only.
 */

import { z } from 'zod';

import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType } from '#/agent/media/file-type';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { makeCarriageReturnsVisible, type LineEndingStyle } from '#/_base/text/line-endings';
import { renderPrompt } from '#/_base/utils/render-prompt';
import readDescriptionTemplate from './read.md?raw';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
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

export type ReadInput = z.infer<typeof ReadInputSchema>;
export type ReadOutput = z.infer<typeof ReadOutputSchema>;

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

function renderEntries(
  entries: readonly ReadLineEntry[],
  lineEndingStyle: LineEndingStyle,
): {
  renderedLines: string[];
  truncatedLineNumbers: number[];
  maxBytesReached: boolean;
} {
  const renderedLines: string[] = [];
  const truncatedLineNumbers: number[] = [];
  let bytes = 0;
  let maxBytesReached = false;

  for (const entry of entries) {
    const rendered = renderLine(entry, lineEndingStyle);
    const lineBytes = renderedLineBytes(rendered.line, renderedLines.length === 0);
    if (renderedLines.length > 0 && bytes + lineBytes > MAX_BYTES) {
      maxBytesReached = true;
      break;
    }

    if (rendered.wasTruncated) {
      truncatedLineNumbers.push(entry.lineNo);
    }
    renderedLines.push(rendered.line);
    bytes += lineBytes;
    if (bytes >= MAX_BYTES) {
      maxBytesReached = true;
      break;
    }
  }

  return { renderedLines, truncatedLineNumbers, maxBytesReached };
}

function isFileNotFoundError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const code = (unwrapped as { code?: unknown })['code'];
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isTextDecodeError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const code = (unwrapped as { code?: unknown })['code'];
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true;
  if (!(unwrapped instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(unwrapped.message);
}

function containsNulByte(text: string): boolean {
  return text.includes('\u0000');
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
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private get workspaceConfig(): WorkspaceConfig {
    return extendWorkspaceWithSkillRoots(
      {
        workspaceDir: this.workspaceCtx.workDir,
        additionalDirs: this.workspaceCtx.additionalDirs,
      },
      this.skillCatalog?.catalog.getSkillRoots() ?? [],
      this.env.pathClass,
    );
  }

  resolveExecution(args: ReadInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspaceConfig,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspaceConfig.workspaceDir,
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: ReadInput, safePath: string): Promise<ExecutableToolResult> {
    try {
      let stat: Awaited<ReturnType<IHostFileSystem['stat']>>;
      try {
        stat = await this.fs.stat(safePath);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return { isError: true, output: `"${args.path}" does not exist.` };
        }
        throw error;
      }
      if (!stat.isFile) {
        return { isError: true, output: `"${args.path}" is not a file.` };
      }

      const header = await this.fs.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header);
      if (fileType.kind === 'image' || fileType.kind === 'video') {
        return {
          isError: true,
          output: `"${args.path}" is a ${fileType.kind} file. Use ReadMediaFile to read image or video files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output: notReadableFileOutput(args.path),
        };
      }

      const lineOffset = args.line_offset ?? 1;
      const requestedLines = args.n_lines ?? MAX_LINES;
      const effectiveLimit = Math.min(requestedLines, MAX_LINES);

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

    for await (const rawLine of this.fs.readLines(safePath, { errors: 'strict' })) {
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

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    const rendered = renderEntries(selectedEntries, lineEndingStyle);

    return this.finishReadResult({
      renderedLines: rendered.renderedLines,
      truncatedLineNumbers: rendered.truncatedLineNumbers,
      maxLinesReached,
      maxBytesReached: rendered.maxBytesReached,
      lineEndingStyle,
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

    for await (const rawLine of this.fs.readLines(safePath, { errors: 'strict' })) {
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

    return this.finishTailEntries({
      entries,
      lineEndingFlags: flags,
      effectiveLimit,
      totalLines: currentLineNo,
      requestedLines,
    });
  }

  private finishTailEntries(input: {
    entries: readonly ReadLineEntry[];
    lineEndingFlags: LineEndingFlags;
    effectiveLimit: number;
    totalLines: number;
    requestedLines: number;
  }): ExecutableToolResult {
    const lineEndingStyle = lineEndingStyleFromFlags(input.lineEndingFlags);
    let renderedCandidates = input.entries.slice(0, input.effectiveLimit).map((entry) => {
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
      for (let i = renderedCandidates.length - 1; i >= 0; i -= 1) {
        const candidate = renderedCandidates[i];
        if (candidate === undefined) continue;
        const lineBytes = renderedLineBytes(candidate.rendered.line, kept.length === 0);
        if (bytes + lineBytes > MAX_BYTES) break;
        kept.unshift(candidate);
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
      maxLinesReached: false,
      maxBytesReached,
      lineEndingStyle,
      startLine: renderedCandidates[0]?.entry.lineNo ?? 0,
      totalLines: input.totalLines,
      requestedLines: input.requestedLines,
    });
  }

  private finishReadResult(input: FinishReadResultInput): ExecutableToolResult {
    return {
      output: input.renderedLines.join('\n'),
      note: `<system>${this.finishMessage(input)}</system>`,
    };
  }

  private finishMessage(input: FinishReadResultInput): string {
    const lineCount = input.renderedLines.length;
    const lineWord = lineCount === 1 ? 'line' : 'lines';
    const parts =
      lineCount > 0
        ? [
            `${String(lineCount)} ${lineWord} read from file starting from line ${String(input.startLine)}.`,
          ]
        : ['No lines read from file.'];

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

registerTool(ReadTool);
