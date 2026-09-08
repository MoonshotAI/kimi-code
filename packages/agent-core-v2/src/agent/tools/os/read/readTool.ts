import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IConfigService } from '#/app/config/config';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType } from '#/agent/media/file-type';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { makeCarriageReturnsVisible, splitLinesKeepingTerminator, type LineEndingStyle } from '#/_base/text/line-endings';
import { detectTextEncoding, type UtfTextEncoding } from '#/_base/text/encoding';
import { renderPrompt } from '#/_base/utils/render-prompt';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_CHARS_LIMIT,
  IReadTool,
  ReadInputSchema,
  TRANSCODE_MAX_BYTES,
  type ReadInput,
} from './read';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { READ_SECTION, type ReadConfig } from './configSection';
import readDescriptionTemplate from './read.md?raw';

interface LineEndingFlags {
  hasCrLf: boolean;
  hasLf: boolean;
  hasLoneCr: boolean;
}

interface ReadLineEntry {
  readonly lineNo: number;
  readonly rawContent: string;
}

interface ReadTailEntry extends ReadLineEntry {
  readonly minChars: number;
}

interface ReadRequest {
  readonly args: ReadInput;
  readonly maxChars: number;
  readonly maxCharsLimit: number;
  readonly detectedEncoding?: UtfTextEncoding;
  readonly lossyDecoding: boolean;
  readonly eventLog: boolean;
}

interface ReadPage {
  readonly request: ReadRequest;
  readonly renderedLines: readonly string[];
  readonly startLine: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly totalLines: number;
  readonly fromTail: boolean;
  readonly lineEndingStyle: LineEndingStyle;
}

function stripTrailingLf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
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

function renderLine(entry: ReadLineEntry, lineEndingStyle: LineEndingStyle): string {
  const modelContent =
    lineEndingStyle === 'crlf' && entry.rawContent.endsWith('\r')
      ? entry.rawContent.slice(0, -1)
      : entry.rawContent;
  const renderedContent =
    lineEndingStyle === 'mixed' ? makeCarriageReturnsVisible(modelContent) : modelContent;
  return `${String(entry.lineNo)}\t${renderedContent}`;
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

function encodingDisplayName(encoding: UtfTextEncoding): string {
  switch (encoding) {
    case 'utf-16le':
      return 'UTF-16 LE';
    case 'utf-16be':
      return 'UTF-16 BE';
    default:
      return 'UTF-8';
  }
}

async function* decodedLines(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines;
}

function notReadableFileOutput(path: string): string {
  return `"${path}" is not readable as UTF-8 text. Only text files can be read.`;
}

function notUtf8DecodableFileOutput(path: string): string {
  return (
    `"${path}" is not valid UTF-8 or UTF-16 text. ` +
    'Only UTF-8 and UTF-16 text files can be read; ' +
    'for other encodings (e.g. GBK), convert the file to UTF-8 first (e.g. with `iconv`).'
  );
}

export class ReadTool implements IReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Read' as const;
  get description(): string {
    const limits = this.limits();
    return renderPrompt(readDescriptionTemplate, {
      DEFAULT_MAX_CHARS: limits.defaultMaxChars,
      MAX_CHARS: limits.maxChars,
    });
  }
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadInputSchema);
  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentToolResultTruncationService private readonly resultTruncation: IAgentToolResultTruncationService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  private limits(): { defaultMaxChars: number; maxChars: number } {
    const section = this.config.get<ReadConfig | undefined>(READ_SECTION);
    const maxChars = section?.maxChars ?? DEFAULT_MAX_CHARS_LIMIT;
    return {
      defaultMaxChars: Math.min(section?.defaultMaxChars ?? DEFAULT_MAX_CHARS, maxChars),
      maxChars,
    };
  }

  private workspaceConfig(view: RuntimeWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: ReadInput): ToolExecution {
    if (args.column_offset !== undefined && (args.line_offset ?? 1) < 0) {
      return { isError: true, output: 'column_offset is only supported for forward reads. Use a positive line_offset or the forward Next Read arguments.' };
    }
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [...this.workspaceCtx.additionalDirs, ...this.skillCatalog.catalog.getSkillRoots()],
    });
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
    const workspace = this.workspaceConfig(view);
    const path = resolvePathAccessPath(args.path, {
      env,
      workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async () => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          const eventLog = this.resultTruncation.isWireJournalPath(path);
          const result = await this.execution(lease.runtime.fs!, args, path, eventLog);
          return { ...result, spillExempt: true };
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    fs: IHostFileSystem,
    args: ReadInput,
    safePath: string,
    eventLog: boolean,
  ): Promise<ExecutableToolResult> {
    try {
      let stat: Awaited<ReturnType<IHostFileSystem['stat']>>;
      try {
        stat = await fs.stat(safePath);
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return { isError: true, output: `"${args.path}" does not exist.` };
        }
        throw error;
      }
      if (!stat.isFile) {
        return { isError: true, output: `"${args.path}" is not a file.` };
      }

      const header = await fs.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header);
      if (fileType.kind === 'image' || fileType.kind === 'video') {
        return {
          isError: true,
          output: `"${args.path}" is ${fileType.kind === 'image' ? 'an' : 'a'} ${fileType.kind} file. Only text files can be read.`,
        };
      }

      const detection = detectTextEncoding(header);
      let readLines: () => AsyncIterable<string>;
      let detectedEncoding: UtfTextEncoding | undefined;
      let lossyDecoding = false;
      if (!detection.seemsBinary && detection.encoding !== 'utf-8') {
        if (stat.size > TRANSCODE_MAX_BYTES) {
          return {
            isError: true,
            output:
              `"${args.path}" is ${encodingDisplayName(detection.encoding)} text but too large to transcode ` +
              `(${String(stat.size)} bytes > ${String(TRANSCODE_MAX_BYTES)}). ` +
              'Convert it to UTF-8 first (e.g. with `iconv`).',
          };
        }
        const bytes = await fs.readBytes(safePath);
        let decoded: string;
        try {
          decoded = new TextDecoder(detection.encoding, { fatal: true }).decode(bytes);
        } catch (error) {
          if (!isTextDecodeError(error)) throw error;
          decoded = new TextDecoder(detection.encoding, { fatal: false }).decode(bytes);
          lossyDecoding = true;
        }
        detectedEncoding = detection.encoding;
        const decodedContent = splitLinesKeepingTerminator(decoded);
        readLines = () => decodedLines(decodedContent);
      } else if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output: notReadableFileOutput(args.path),
        };
      } else {
        readLines = () => fs.readLines(safePath, { errors: 'strict' });
      }

      const limits = this.limits();
      const request: ReadRequest = {
        args,
        maxChars: Math.min(args.max_chars ?? limits.defaultMaxChars, limits.maxChars),
        maxCharsLimit: limits.maxChars,
        detectedEncoding,
        lossyDecoding,
        eventLog,
      };
      const lineOffset = args.line_offset ?? 1;
      if (lineOffset >= 0) return await this.readForward(readLines(), request);
      const rereadsFile = detectedEncoding === undefined && (args.n_lines ?? Infinity) < -lineOffset;
      const result = await this.readTail(readLines, request);
      if (!result.isError && rereadsFile) {
        const currentStat = await fs.stat(safePath);
        if (!currentStat.isFile || currentStat.size !== stat.size ||
          currentStat.mtimeMs !== stat.mtimeMs || currentStat.ino !== stat.ino) {
          return { isError: true, output: 'File changed while reading its tail. Retry Read with the updated file.' };
        }
      }
      return result;
    } catch (error) {
      if (isTextDecodeError(error)) {
        return { isError: true, output: notUtf8DecodableFileOutput(args.path) };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readForward(
    lines: AsyncIterable<string>,
    request: ReadRequest,
  ): Promise<ExecutableToolResult> {
    const { args, maxChars } = request;
    const lineOffset = args.line_offset ?? 1;
    const columnOffset = args.column_offset ?? 0;
    const requestedLines = args.n_lines ?? Infinity;
    const selectedEntries: ReadLineEntry[] = [];
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    let currentLineNo = 0;
    let collectionClosed = false;
    let minimumChars = 0;

    for await (const rawLine of lines) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(args.path) };
      }
      currentLineNo += 1;
      updateLineEndingFlags(flags, rawLine);
      if (collectionClosed) continue;
      if (currentLineNo < lineOffset) continue;
      if (selectedEntries.length >= requestedLines) {
        collectionClosed = true;
        continue;
      }
      const rawContent = stripTrailingLf(rawLine);
      const lineChars = String(currentLineNo).length + 1 + Math.max(
        0,
        rawContent.length - (rawContent.endsWith('\r') ? 1 : 0) -
          (currentLineNo === lineOffset ? columnOffset : 0),
      ) + (selectedEntries.length === 0 ? 0 : 1);
      if (minimumChars + lineChars > maxChars && selectedEntries.length > 0) {
        collectionClosed = true;
        continue;
      }
      selectedEntries.push({
        lineNo: currentLineNo,
        rawContent,
      });
      minimumChars += lineChars;
      if (selectedEntries.length >= requestedLines || minimumChars >= maxChars) {
        collectionClosed = true;
      }
    }

    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    const renderedLines = selectedEntries.map((entry) => renderLine(entry, lineEndingStyle));
    const firstLine = renderedLines[0];
    if (columnOffset > 0) {
      const prefix = `${String(lineOffset)}\t`;
      const text = firstLine?.slice(prefix.length);
      if (text === undefined || columnOffset > text.length) {
        return { isError: true, output: `column_offset=${String(columnOffset)} is past the end of the starting line ${String(lineOffset)}. Read the line from column 0 to inspect its current contents.` };
      }
      if (splitsSurrogatePair(text, columnOffset)) {
        return { isError: true, output: `column_offset=${String(columnOffset)} splits a Unicode character in line ${String(lineOffset)}. Use a character boundary or the Next Read arguments.` };
      }
      renderedLines[0] = prefix + text.slice(columnOffset);
    }
    return this.finishPage({
      request,
      renderedLines,
      startLine: lineOffset,
      rangeStart: lineOffset,
      rangeEnd: Math.min(currentLineNo, lineOffset + requestedLines - 1),
      totalLines: currentLineNo,
      fromTail: false,
      lineEndingStyle,
    });
  }

  private finishPage(page: ReadPage): ExecutableToolResult {
    const { args, maxChars, maxCharsLimit, eventLog, detectedEncoding, lossyDecoding } = page.request;
    let first = 0;
    let end = page.renderedLines.length;
    let contentChars = page.renderedLines.reduce((sum, line) => sum + line.length + 1, -1);
    const firstColumn = page.fromTail ? 0 : args.column_offset ?? 0;
    const firstPrefix = `${String(page.startLine)}\t`;
    const firstText = page.renderedLines[0]?.slice(firstPrefix.length) ?? '';
    let fragmentEnd: number | undefined;

    while (true) {
      const count = end - first;
      const startLine = page.startLine + first;
      const endLine = page.startLine + end - 1;
      const lineIncomplete = fragmentEnd !== undefined;
      const complete = page.rangeStart > page.rangeEnd ||
        (count > 0 && startLine === page.rangeStart && endLine === page.rangeEnd && !lineIncomplete);
      const parts = [
        count > 0
          ? `${String(count)} ${count === 1 ? 'line' : 'lines'} read from file starting from line ${String(startLine)}.`
          : 'No lines read from file.',
        `Total lines in file: ${String(page.totalLines)}.`,
        complete ? 'Requested range complete.' : 'Character limit reached.',
        `Effective max_chars: ${String(maxChars)}.`,
      ];
      if (!lineIncomplete && ((count > 0 && endLine === page.totalLines) || page.rangeStart > page.totalLines)) {
        parts.push('End of file reached.');
      }
      if (count > 0 && !page.fromTail && (firstColumn > 0 || fragmentEnd !== undefined)) {
        parts.push(`Line ${String(startLine)} fragment: columns [${String(firstColumn)}, ${String(firstColumn + (fragmentEnd ?? firstText.length))}) of ${String(firstColumn + firstText.length)}. ${lineIncomplete ? 'Line continues.' : 'Line complete.'}`);
      }
      if (args.max_chars !== undefined && args.max_chars > maxCharsLimit) {
        parts.push(`Requested max_chars=${String(args.max_chars)} was capped at the configured maximum ${String(maxCharsLimit)}.`);
      }
      if (!complete && (count > 0 || page.fromTail)) {
        const nextStart = page.fromTail ? page.rangeStart : lineIncomplete ? startLine : endLine + 1;
        const nextEnd = page.fromTail && count > 0 ? startLine - 1 : page.rangeEnd;
        const next = {
          path: args.path,
          line_offset: nextStart,
          column_offset: fragmentEnd !== undefined ? firstColumn + fragmentEnd : undefined,
          n_lines: page.fromTail || args.n_lines !== undefined ? nextEnd - nextStart + 1 : undefined,
          max_chars: maxChars,
        };
        parts.push(`Next Read: ${JSON.stringify(next)}`);
      }
      if (eventLog) {
        parts.push('Kimi Code agent event log: read one record at a time (n_lines=1); increase max_chars for a longer record or extract fields with Bash.');
      }
      if (page.lineEndingStyle === 'mixed') {
        parts.push('Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.');
      }
      if (detectedEncoding !== undefined) {
        parts.push(`Detected file encoding: ${encodingDisplayName(detectedEncoding)}; content transcoded to UTF-8 for display. Edit and Write expect UTF-8 — convert the file's encoding first (e.g. \`iconv\` via Bash).`);
      }
      if (lossyDecoding) {
        parts.push('Lossy UTF-16 decoding: malformed sequences were replaced with U+FFFD. The decoded text may differ from the original file.');
      }
      const note = `<system>${parts.join(' ')}</system>`;
      const renderedChars = count === 0
        ? renderToolResultForModel({ output: '', note }).reduce(
          (sum, part) => sum + (part.type === 'text' ? part.text.length : 0),
          0,
        )
        : contentChars + 1 + note.length;
      if (renderedChars <= maxChars && (complete || count > 0)) {
        return {
          output: fragmentEnd !== undefined
            ? firstPrefix + firstText.slice(0, fragmentEnd)
            : page.renderedLines.slice(first, end).join('\n'),
          note,
          truncated: complete ? undefined : true,
        };
      }
      if (count === 1 && !page.fromTail) {
        const previousEnd = fragmentEnd ?? firstText.length;
        fragmentEnd = Math.min(previousEnd - 1, previousEnd - (renderedChars - maxChars));
        if (splitsSurrogatePair(firstText, fragmentEnd)) fragmentEnd -= 1;
        if (fragmentEnd <= 0) {
          return { isError: true, output: `max_chars=${String(maxChars)} is too small for file text and the Read status. Increase max_chars.` };
        }
        contentChars = firstPrefix.length + fragmentEnd;
        continue;
      }
      if (count === 0) {
        if (!complete) {
          const recovery: ExecutableToolResult = {
            isError: true,
            output: 'No complete line fits. Continue with the forward Next Read.',
            note,
            truncated: true,
          };
          const recoveryChars = renderToolResultForModel(recovery).reduce(
            (sum, part) => sum + (part.type === 'text' ? part.text.length : 0),
            0,
          );
          if (recoveryChars <= maxChars) return recovery;
        }
        return { isError: true, output: `max_chars=${String(maxChars)} is too small for the Read status. Increase max_chars.` };
      }
      const dropped = page.fromTail ? first++ : --end;
      contentChars -= page.renderedLines[dropped]!.length + 1;
    }
  }

  private async readTail(
    readLines: () => AsyncIterable<string>,
    request: ReadRequest,
  ): Promise<ExecutableToolResult> {
    const { args, maxChars } = request;
    const lineOffset = args.line_offset ?? 1;
    const requestedLines = args.n_lines ?? Infinity;
    const tailCount = -lineOffset;
    const singlePass = requestedLines >= tailCount;
    let entries: (ReadTailEntry | undefined)[] = [];
    let first = 0;
    let chars = 0;
    const retainLine = (rawLine: string, lineNo: number): void => {
      const rawContent = stripTrailingLf(rawLine);
      const minChars = String(lineNo).length + 2 + rawContent.length - (rawContent.endsWith('\r') ? 1 : 0);
      entries.push({ lineNo, rawContent, minChars });
      chars += minChars;
      while (first < entries.length && (chars - 1 > maxChars || entries.length - first > tailCount)) {
        chars -= entries[first]!.minChars;
        entries[first++] = undefined;
      }
      if (first > 1024 && first >= entries.length / 2) {
        entries = entries.slice(first);
        first = 0;
      }
    };
    const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
    let totalLines = 0;
    for await (const rawLine of readLines()) {
      if (containsNulByte(rawLine)) {
        return { isError: true, output: notReadableFileOutput(args.path) };
      }
      totalLines += 1;
      updateLineEndingFlags(flags, rawLine);
      if (singlePass) retainLine(rawLine, totalLines);
    }

    const rangeStart = Math.max(1, totalLines + lineOffset + 1);
    const rangeEnd = Math.min(totalLines, rangeStart + requestedLines - 1);
    const lineEndingStyle = lineEndingStyleFromFlags(flags);
    if (!singlePass) {
      let currentLine = 0;
      for await (const rawLine of readLines()) {
        currentLine += 1;
        if (currentLine > rangeEnd) break;
        if (currentLine < rangeStart) continue;
        if (containsNulByte(rawLine)) {
          return { isError: true, output: notReadableFileOutput(args.path) };
        }
        retainLine(rawLine, currentLine);
      }
      if (currentLine < rangeEnd || currentLine > totalLines) {
        return { isError: true, output: 'File changed while reading its tail. Retry Read with the updated file.' };
      }
    }
    const selected = entries.slice(first).map((entry) => renderLine(entry!, lineEndingStyle));
    return this.finishPage({
      request,
      renderedLines: selected,
      startLine: rangeEnd - selected.length + 1,
      rangeStart,
      rangeEnd,
      totalLines,
      fromTail: true,
      lineEndingStyle,
    });
  }

}

registerAgentToolService(IReadTool, ReadTool, {
  name: 'Read',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['fs'],
});
