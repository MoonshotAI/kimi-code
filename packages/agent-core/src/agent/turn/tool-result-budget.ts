import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import type { ContentPart } from '@moonshot-ai/kosong';
import { join } from 'pathe';

import type { ExecutableToolResult } from '../../loop';

const TOOL_RESULT_MAX_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;

interface BudgetToolResultOptions {
  readonly homedir?: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: ExecutableToolResult;
}

type SavedToolResult =
  | { readonly outputPath: string }
  | { readonly error: string };

export async function budgetToolResultForModel(
  options: BudgetToolResultOptions,
): Promise<ExecutableToolResult> {
  const text = persistableToolResultText(options.result.output);
  if (text === undefined || text.length <= TOOL_RESULT_MAX_CHARS) return options.result;
  if (text.includes('\n[Full output saved]\n')) return options.result;

  const saved = await saveToolResult(options, text);
  const output = renderPersistedToolResult(options.toolName, options.toolCallId, text, saved);
  return options.result.isError === true
    ? { ...options.result, output, isError: true }
    : { ...options.result, output };
}

function persistableToolResultText(output: ExecutableToolResult['output']): string | undefined {
  if (typeof output === 'string') return output;
  if (
    !output.every((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
  ) {
    return undefined;
  }
  return output.map((part) => part.text).join('');
}

async function saveToolResult(
  options: Pick<BudgetToolResultOptions, 'homedir' | 'toolName' | 'toolCallId'>,
  text: string,
): Promise<SavedToolResult> {
  if (options.homedir === undefined) return { error: 'No session directory is available.' };
  try {
    const dir = join(options.homedir, 'tool-results');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(
      dir,
      `${safeToolResultFileStem(options.toolName, options.toolCallId)}.txt`,
    );
    await writeFile(outputPath, text, 'utf8');
    return { outputPath };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function renderPersistedToolResult(
  toolName: string,
  toolCallId: string,
  text: string,
  saved: SavedToolResult,
): string {
  const lines = [
    `Tool output exceeded ${String(TOOL_RESULT_MAX_CHARS)} characters; showing a preview only.`,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    `output_size_chars: ${String(text.length)}`,
    `output_size_bytes: ${String(Buffer.byteLength(text, 'utf8'))}`,
  ];
  if ('outputPath' in saved) {
    lines.push(
      `output_path: ${saved.outputPath}`,
      'next_step: Use Read with output_path to page through the full output.',
    );
  } else {
    lines.push('full_output_available: false', `full_output_error: ${saved.error}`);
  }
  lines.push('', '[preview]', text.slice(0, TOOL_RESULT_PREVIEW_CHARS));
  return lines.join('\n');
}

function safeToolResultFileStem(toolName: string, toolCallId: string): string {
  const label = `${toolName}-${toolCallId}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  const hash = createHash('sha256').update(`${toolName}:${toolCallId}`).digest('hex').slice(0, 12);
  return `${label || 'tool-result'}-${hash}`;
}
