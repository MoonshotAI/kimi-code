/**
 * ReadTool — read a file from the local filesystem.
 *
 * Text files return numbered lines plus a trailing `<system>` status
 * block. Image and video files return a 4-part multi-modal wrap:
 * `[TextPart('<system>…</system>'), TextPart('<image|video path="…">'),
 *   ImageContent|VideoContent, TextPart('</image|video>')]`
 * gated on the model's `image_in` / `video_in` capability. The file kind
 * is decided by extension + magic-byte sniffing, so the model never has
 * to guess the kind before calling.
 *
 * The leading media `<system>` block summarizes mime type, byte size and
 * (for images) original pixel dimensions, guides the model to derive
 * absolute coordinates from that original size, and reminds it to
 * re-read any media it generates or edits.
 */

import type { Kaos, StatResult } from '@moonshot-ai/kaos';
import type {
  ContentPart,
  ModelCapability,
  VideoURLPart,
  VideoUploadInput as ProviderVideoUploadInput,
} from '@moonshot-ai/kosong';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { resolvePathAccessPath } from '../../policies/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType, sniffImageDimensions } from '../../support/file-type';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { makeCarriageReturnsVisible, type LineEndingStyle } from './line-endings';
import readDescriptionTemplate from './read.md';

export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;
export const MAX_MEDIA_MEGABYTES: number = 100;
const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export type VideoUploadInput = ProviderVideoUploadInput;

export type VideoUploader = (input: VideoUploadInput) => Promise<VideoURLPart>;

const PositiveLineOffsetSchema = z.number().int().min(1);
const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);

export const ReadInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to a file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.',
    ),
  line_offset: z
    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])
    .optional()
    .describe(
      `The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed ${String(MAX_LINES)}. Ignored for image and video files.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of ${String(MAX_LINES)} lines. Ignored for image and video files.`,
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
}

type TextPreviewKaos = Kaos & {
  readTextPreview: (path: string, n: number) => Promise<Buffer>;
};

function isMediaFileType(kind: 'text' | 'image' | 'video' | 'unknown'): kind is 'image' | 'video' {
  return kind === 'image' || kind === 'video';
}

function hasTextPreview(kaos: Kaos): kaos is TextPreviewKaos {
  return typeof (kaos as { readTextPreview?: unknown }).readTextPreview === 'function';
}

async function readTextHeader(kaos: Kaos, path: string, n: number): Promise<Buffer> {
  if (hasTextPreview(kaos)) {
    return kaos.readTextPreview(path, n);
  }
  return kaos.readBytes(path, n);
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

function notReadableFileOutput(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    'For binary formats, use Bash or an MCP tool if available.'
  );
}

function buildDescription(capabilities: ModelCapability): string {
  const head = renderPrompt(readDescriptionTemplate, {
    MAX_LINES,
    MAX_BYTES_KB: MAX_BYTES / 1024,
    MAX_LINE_LENGTH,
    MAX_MEDIA_MEGABYTES,
  });
  const lines: string[] = [head];
  const hasImage = capabilities.image_in;
  const hasVideo = capabilities.video_in;
  if (hasImage && hasVideo) {
    lines.push('- This tool supports image and video files for the current model.');
  } else if (hasImage) {
    lines.push(
      '- This tool supports image files for the current model.',
      '- Video files are not supported by the current model.',
    );
  } else if (hasVideo) {
    lines.push(
      '- This tool supports video files for the current model.',
      '- Image files are not supported by the current model.',
    );
  } else {
    lines.push(
      '- The current model does not support image or video input; reading an image or video file returns an error.',
    );
  }
  return lines.join('\n');
}

/**
 * Build the `<system>` summary that precedes the media content.
 *
 * Carries mime type, byte size and (for images) the original pixel
 * dimensions. When the dimensions are known it also guides the model to
 * derive absolute coordinates from that original size; it always reminds
 * the model to re-read any media it generates or edits.
 */
function buildSystemSummary(input: {
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
}): string {
  const parts: string[] = [
    `Read ${input.kind} file.`,
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
  ];
  // Coordinate guidance is only emitted when the original size is actually
  // known — sniffing fails for some image formats (TIFF/ICO/HEIC/…), and
  // telling the model to use a size that is not in the block would mislead it.
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
      'If you need to output coordinates, output relative coordinates first ' +
        'and compute absolute coordinates using the original image size.',
    );
  }
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

export class ReadTool implements BuiltinTool<ReadInput> {
  readonly name = 'Read' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadInputSchema);
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly videoUploader?: VideoUploader | undefined,
  ) {
    this.description = buildDescription(capabilities);
  }

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
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: ReadInput, safePath: string): Promise<ExecutableToolResult> {
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

      const fileType = await this.detectFileTypeForRead(safePath);
      if (isMediaFileType(fileType.kind)) {
        try {
          return await this.readMedia(args, safePath, fileType.kind, fileType.mimeType, stat);
        } catch (error) {
          // Media failures surface provider errors (e.g. a failed video
          // upload); a bare message loses which file and step failed.
          return {
            isError: true,
            output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
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

  private async detectFileTypeForRead(
    safePath: string,
  ): Promise<ReturnType<typeof detectFileType>> {
    const extensionHint = detectFileType(safePath);
    if (isMediaFileType(extensionHint.kind)) {
      const rawHeader = await this.kaos.readBytes(safePath, MEDIA_SNIFF_BYTES);
      return detectFileType(safePath, rawHeader);
    }

    try {
      const header = await readTextHeader(this.kaos, safePath, MEDIA_SNIFF_BYTES);
      return detectFileType(safePath, header);
    } catch (error) {
      if (!hasTextPreview(this.kaos)) throw error;
      const rawHeader = await this.kaos.readBytes(safePath, MEDIA_SNIFF_BYTES);
      return detectFileType(safePath, rawHeader);
    }
  }

  private async readMedia(
    args: ReadInput,
    safePath: string,
    kind: 'image' | 'video',
    mimeType: string,
    stat: StatResult,
  ): Promise<ExecutableToolResult> {
    if (kind === 'image' && !this.capabilities.image_in) {
      return {
        isError: true,
        output:
          'The current model does not support image input. ' +
          'Tell the user to use a model with image input capability.',
      };
    }
    if (kind === 'video' && !this.capabilities.video_in) {
      return {
        isError: true,
        output:
          'The current model does not support video input. ' +
          'Tell the user to use a model with video input capability.',
      };
    }

    if (stat.stSize === 0) {
      return { isError: true, output: `"${args.path}" is empty.` };
    }
    if (stat.stSize > MAX_MEDIA_BYTES) {
      return {
        isError: true,
        output:
          `"${args.path}" is ${String(stat.stSize)} bytes, which exceeds the ` +
          `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
      };
    }

    const data = await this.kaos.readBytes(safePath);
    const base64 = data.toString('base64');
    let mediaPart: ContentPart;
    if (kind === 'image') {
      mediaPart = {
        type: 'image_url',
        imageUrl: { url: `data:${mimeType};base64,${base64}` },
      };
    } else if (this.videoUploader !== undefined) {
      mediaPart = await this.videoUploader({
        data,
        mimeType,
        filename: safePath.split(/[\\/]/).at(-1),
      });
    } else {
      mediaPart = {
        type: 'video_url',
        videoUrl: { url: `data:${mimeType};base64,${base64}` },
      };
    }

    const openText = `<${kind} path="${safePath}">`;
    const closeText = `</${kind}>`;

    const dimensions = kind === 'image' ? sniffImageDimensions(data) : null;
    const systemText = buildSystemSummary({
      kind,
      mimeType,
      byteSize: stat.stSize,
      dimensions,
    });

    const output: ContentPart[] = [
      { type: 'text', text: systemText },
      { type: 'text', text: openText },
      mediaPart,
      { type: 'text', text: closeText },
    ];

    return { output, isError: false };
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

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    const renderedLines: string[] = [];
    const truncatedLineNumbers: number[] = [];
    let bytes = 0;
    let maxBytesReached = false;

    for (const entry of selectedEntries) {
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

    return this.finishReadResult({
      renderedLines,
      truncatedLineNumbers,
      maxLinesReached,
      maxBytesReached,
      lineEndingStyle,
      startLine: renderedLines.length > 0 ? lineOffset : 0,
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

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    let renderedCandidates = entries.slice(0, effectiveLimit).map((entry) => {
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
      totalLines: currentLineNo,
      requestedLines,
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
