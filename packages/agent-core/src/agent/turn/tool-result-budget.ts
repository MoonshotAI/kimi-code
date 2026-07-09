import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';

import type { ContentPart } from '@moonshot-ai/kosong';
import { join } from 'pathe';

import type { ExecutableToolResult } from '../../loop';

const TOOL_RESULT_MAX_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;
const TOOL_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TOOL_RESULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastCleanupAt = 0;

interface BudgetToolResultOptions {
  readonly homedir?: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: ExecutableToolResult;
}

export async function budgetToolResultForModel(
  options: BudgetToolResultOptions,
): Promise<ExecutableToolResult> {
  const text = persistableToolResultText(options.result.output);
  if (text === undefined || text.length <= TOOL_RESULT_MAX_CHARS) return options.result;
  if (options.result.truncated === true) return options.result;
  if (options.homedir === undefined) return options.result;

  void maybeCleanupOldToolResults(options.homedir);
  const outputPath = await saveToolResult(
    { homedir: options.homedir, toolName: options.toolName, toolCallId: options.toolCallId },
    text,
  );
  if (outputPath === undefined) return options.result;
  const output = renderPersistedToolResult(options.toolName, options.toolCallId, text, outputPath);
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

async function maybeCleanupOldToolResults(homedir: string): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < TOOL_RESULT_CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    const dir = join(homedir, 'tool-results');
    const entries = await readdir(dir);
    const cutoff = now - TOOL_RESULT_MAX_AGE_MS;
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dir, entry);
        try {
          const stats = await stat(entryPath);
          if (stats.isFile() && stats.mtimeMs < cutoff) {
            await unlink(entryPath);
          }
        } catch {
          // Individual file cleanup failures are best-effort.
        }
      }),
    );
  } catch {
    // Directory may not exist yet; cleanup is best-effort.
  }
}

async function saveToolResult(
  options: { readonly homedir: string; readonly toolName: string; readonly toolCallId: string },
  text: string,
): Promise<string | undefined> {
  try {
    const dir = join(options.homedir, 'tool-results');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const outputPath = join(
      dir,
      `${safeToolResultFileStem(options.toolName, options.toolCallId)}-${randomUUID()}.txt`,
    );
    await writeFile(outputPath, text, { encoding: 'utf8', flag: 'wx' });
    return outputPath;
  } catch {
    return undefined;
  }
}

function renderPersistedToolResult(
  toolName: string,
  toolCallId: string,
  text: string,
  outputPath: string,
): string {
  const lines = [
    `Tool output exceeded ${String(TOOL_RESULT_MAX_CHARS)} characters; showing a preview only.`,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    `output_size_chars: ${String(text.length)}`,
    `output_size_bytes: ${String(Buffer.byteLength(text, 'utf8'))}`,
    `output_path: ${outputPath}`,
    'next_step: Use Read with output_path to page through the full output.',
  ];
  lines.push('', '[preview]', text.slice(0, TOOL_RESULT_PREVIEW_CHARS));
  return lines.join('\n');
}

function safeToolResultFileStem(toolName: string, toolCallId: string): string {
  const label = `${toolName}-${toolCallId}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return label || 'tool-result';
}
