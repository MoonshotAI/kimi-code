import { randomUUID } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS,
  type ExecutableToolResult,
} from '#/tool/toolContract';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { ContentPart } from '#/kosong/contract/message';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { join, normalize } from 'pathe';
import {
  IAgentToolResultTruncationService,
  type ToolResultTruncationInput,
} from './toolResultTruncation';

const TOOL_RESULT_PREVIEW_HEAD_CHARS = 4_096;
const TOOL_RESULT_PREVIEW_TAIL_CHARS = 1_024;
const TOOL_RESULT_MAX_LINE_CHARS = 2_000;
const TRUNCATION_MARKER = '[...truncated]';

const encoder = new TextEncoder();

interface ShapedOutput {
  readonly output: ExecutableToolResult['output'];
  readonly textChars: number;
  readonly hasMedia: boolean;
}

export class ToolResultTruncationService implements IAgentToolResultTruncationService {
  declare readonly _serviceBrand: undefined;

  private readonly storageScope: string;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext agent: IAgentScopeContext,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    this.storageScope = agent.scope('tool-results');
  }

  async truncateForModel<T extends ExecutableToolResult>(
    input: ToolResultTruncationInput<T>,
  ): Promise<T> {
    const { result } = input;
    if (result.spillExempt === true) return result;

    const rawText = persistableToolResultText(result.output);
    if (rawText.length <= DEFAULT_TOOL_RESULT_MAX_CHARS) return result;

    const { spill, ...rest } = result;
    const retainedText =
      rawText.length <= DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS
        ? rawText
        : rawText.slice(0, DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS);
    const shaped = shapeOutput(result.output, TOOL_RESULT_MAX_LINE_CHARS);
    const totalChars = spill?.totalChars ?? rawText.length;
    const suffix = spill?.suffix ?? '';

    const saved =
      spill?.outputPath !== undefined
        ? { outputPath: spill.outputPath, preservedChars: totalChars }
        : await this.saveToolResult(input.toolName, input.toolCallId, retainedText);
    if (saved === undefined) {
      const fallback = renderUnpersistedToolResult(
        input.toolName,
        input.toolCallId,
        retainedText,
        totalChars,
        DEFAULT_TOOL_RESULT_MAX_CHARS,
        suffix,
      );
      return { ...rest, output: mergeSpillPointer(shaped.output, fallback), truncated: true } as T;
    }

    if (shaped.textChars <= DEFAULT_TOOL_RESULT_MAX_CHARS) {
      const inlineSuffix = dropInlineSuffixLines(suffix, persistableToolResultText(shaped.output));
      return {
        ...rest,
        output: appendToToolResultOutput(
          shaped.output,
          renderAppendedSpillPointer(
            saved.outputPath,
            saved.preservedChars,
            totalChars,
            inlineSuffix,
            shaped.hasMedia,
          ),
        ),
        truncated: true,
      } as T;
    }
    const pointer = renderPersistedToolResult(
      input.toolName,
      input.toolCallId,
      retainedText,
      saved.outputPath,
      saved.preservedChars,
      totalChars,
      DEFAULT_TOOL_RESULT_MAX_CHARS,
      suffix,
      shaped.hasMedia,
    );
    return {
      ...rest,
      output: mergeSpillPointer(shaped.output, pointer),
      truncated: true,
    } as T;
  }

  isSpillFilePath(path: string): boolean {
    const dir = normalize(join(this.bootstrap.homeDir, this.storageScope));
    const normalized = normalize(path);
    return normalized === dir || normalized.startsWith(`${dir}/`);
  }

  private async saveToolResult(
    toolName: string,
    toolCallId: string,
    text: string,
  ): Promise<{ readonly outputPath: string; readonly preservedChars: number } | undefined> {
    try {
      const key = `${safeToolResultFileStem(toolName, toolCallId)}-${randomUUID()}.txt`;
      await this.storage.write(this.storageScope, key, encoder.encode(text), { atomic: true });
      return {
        outputPath: join(this.bootstrap.homeDir, this.storageScope, key),
        preservedChars: text.length,
      };
    } catch {
      return undefined;
    }
  }
}

function shapeOutput(
  output: ExecutableToolResult['output'],
  maxLineChars: number,
): ShapedOutput {
  if (typeof output === 'string') {
    const shaped = shapeStringPerLine(output, maxLineChars);
    return { output: shaped.text, textChars: shaped.text.length, hasMedia: false };
  }
  const out: ContentPart[] = [];
  let textChars = 0;
  let hasMedia = false;
  for (const part of output) {
    if (part.type === 'text') {
      const shaped = shapeStringPerLine(part.text, maxLineChars);
      out.push({ type: 'text', text: shaped.text });
      textChars += shaped.text.length;
      continue;
    }
    if (part.type === 'think') {
      textChars += part.think.length + (part.encrypted?.length ?? 0);
    } else {
      hasMedia = true;
    }
    out.push(part);
  }
  return { output: out, textChars, hasMedia };
}

function shapeStringPerLine(
  text: string,
  maxLineChars: number,
): { readonly text: string; readonly truncated: boolean } {
  let truncated = false;
  const lines = text.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
  const out: string[] = [];
  for (const originalLine of lines) {
    let line = originalLine;
    if (line.length > maxLineChars) {
      const lineBreak = /[\r\n]+$/.exec(line)?.[0] ?? '';
      const suffix = TRUNCATION_MARKER + lineBreak;
      const effectiveMaxLength = Math.max(maxLineChars, suffix.length);
      line = line.slice(0, effectiveMaxLength - suffix.length) + suffix;
      truncated = true;
    }
    out.push(line);
  }
  return { text: out.join(''), truncated };
}

function persistableToolResultText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  let text = '';
  for (const part of output) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'think') text += part.think;
  }
  return text;
}

function mergeSpillPointer(
  output: ExecutableToolResult['output'],
  pointer: string,
): ExecutableToolResult['output'] {
  if (typeof output === 'string') return pointer;
  const mediaParts = output.filter((part) => part.type !== 'text' && part.type !== 'think');
  if (mediaParts.length === 0) return pointer;
  return [{ type: 'text', text: pointer }, ...mediaParts];
}

function renderAppendedSpillPointer(
  outputPath: string,
  preservedChars: number,
  totalChars: number,
  suffix: string,
  hasMedia: boolean,
): string {
  const firstLine =
    totalChars > preservedChars
      ? `[Per-line truncation occurred; only the first ${String(preservedChars)} characters (of ${String(totalChars)}) were saved to a file.`
      : hasMedia
        ? '[Per-line truncation occurred; the complete text output was saved to a file (media parts stay attached to this result).'
        : '[Per-line truncation occurred; the complete output was saved to a file.';
  const lines = [
    firstLine,
    `output_path: ${outputPath}`,
    'next_step: Use Read with output_path to page through the saved output, or Grep to search it.]',
  ];
  if (suffix.length > 0) lines.push('', suffix);
  return lines.join('\n');
}

function appendToToolResultOutput(
  output: ExecutableToolResult['output'],
  note: string,
): ExecutableToolResult['output'] {
  if (typeof output === 'string') {
    return output.endsWith('\n') || output.length === 0 ? `${output}${note}` : `${output}\n${note}`;
  }
  const parts = [...output];
  const last = parts.at(-1);
  if (last !== undefined && last.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: `${last.text}\n${note}` };
  } else {
    parts.push({ type: 'text', text: note });
  }
  return parts;
}

function renderPersistedToolResult(
  toolName: string,
  toolCallId: string,
  previewText: string,
  outputPath: string,
  preservedChars: number,
  totalChars: number,
  maxChars: number,
  suffix: string,
  hasMedia: boolean,
): string {
  const partial = preservedChars < totalChars;
  const lines = [
    partial
      ? `Tool output exceeded ${String(maxChars)} characters; the first ${String(preservedChars)} characters (of ${String(totalChars)}) were saved to a file.`
      : hasMedia
        ? `Tool output exceeded ${String(maxChars)} characters; the full text output was saved to a file (media parts stay attached to this result).`
        : `Tool output exceeded ${String(maxChars)} characters; the full output was saved to a file.`,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    partial
      ? `output_size_chars: ${String(totalChars)} (only the first ${String(preservedChars)} characters were preserved)`
      : `output_size_chars: ${String(totalChars)}`,
  ];
  if (preservedChars === previewText.length) {
    lines.push(`output_size_bytes: ${String(Buffer.byteLength(previewText, 'utf8'))}`);
  }
  lines.push(
    `output_path: ${outputPath}`,
    'next_step: Use Read with output_path to page through the saved output, or Grep to search it.',
  );
  appendPreviewLines(lines, previewText);
  if (suffix.length > 0) lines.push('', suffix);
  return lines.join('\n');
}

function renderUnpersistedToolResult(
  toolName: string,
  toolCallId: string,
  previewText: string,
  totalChars: number,
  maxChars: number,
  suffix: string,
): string {
  const lines = [
    `Tool output exceeded ${String(maxChars)} characters and could not be saved to a file; only this preview is available.`,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    `output_size_chars: ${String(totalChars)}`,
  ];
  appendPreviewLines(lines, previewText);
  if (suffix.length > 0) lines.push('', suffix);
  return lines.join('\n');
}

function appendPreviewLines(lines: string[], previewText: string): void {
  const head = previewText.slice(0, TOOL_RESULT_PREVIEW_HEAD_CHARS);
  const tailStart = Math.max(head.length, previewText.length - TOOL_RESULT_PREVIEW_TAIL_CHARS);
  const tail = previewText.slice(tailStart);
  lines.push('', `[preview: chars [0, ${String(head.length)})]`, head);
  if (tail !== '') {
    if (tailStart > head.length) {
      lines.push('', `[elided: chars [${String(head.length)}, ${String(tailStart)})]`);
    }
    lines.push('', `[preview: chars [${String(tailStart)}, ${String(previewText.length)})]`, tail);
  }
}

function dropInlineSuffixLines(suffix: string, shapedText: string): string {
  if (suffix.length === 0) return '';
  const lines = suffix.split('\n');
  if (!lines.some((line) => line.length > 0 && shapedText.includes(line))) return suffix;
  return lines
    .filter((line) => line.length > 0 && !shapedText.includes(line))
    .join('\n');
}

function safeToolResultFileStem(toolName: string, toolCallId: string): string {
  const label = `${toolName}-${toolCallId}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return label || 'tool-result';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolResultTruncationService,
  ToolResultTruncationService,
  ScopeActivation.OnScopeCreated,
  'toolResultTruncation',
);
