/**
 * `toolResultTruncation` domain (L3) — `IAgentToolResultTruncationService` implementation.
 *
 * Persists complete oversized text tool results through `storage`, addressed
 * under the current `scopeContext` agent root, and renders a model-visible
 * preview with an absolute file path rooted at `bootstrap.homeDir`. Bound at
 * Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { ContentPart } from '#/kosong/contract/message';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { join } from 'pathe';
import {
  IAgentToolResultTruncationService,
  type ToolResultTruncationInput,
} from './toolResultTruncation';

const TOOL_RESULT_MAX_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;

const encoder = new TextEncoder();

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
    const text = persistableToolResultText(input.result.output);
    if (text === undefined || text.length <= TOOL_RESULT_MAX_CHARS) return input.result;
    if (input.result.truncated === true) return input.result;

    const saved = await this.saveToolResult(input.toolName, input.toolCallId, text);
    if (saved === undefined) return input.result;

    return {
      ...input.result,
      output: renderPersistedToolResult(input.toolName, input.toolCallId, text, saved.outputPath),
      truncated: true,
    } as T;
  }

  private async saveToolResult(
    toolName: string,
    toolCallId: string,
    text: string,
  ): Promise<{ readonly outputPath: string } | undefined> {
    try {
      const key = `${safeToolResultFileStem(toolName, toolCallId)}-${randomUUID()}.txt`;
      await this.storage.write(this.storageScope, key, encoder.encode(text), { atomic: true });
      return { outputPath: join(this.bootstrap.homeDir, this.storageScope, key) };
    } catch {
      return undefined;
    }
  }
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
    '',
    '[preview]',
    text.slice(0, TOOL_RESULT_PREVIEW_CHARS),
  ];
  return lines.join('\n');
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
  InstantiationType.Eager,
  'toolResultTruncation',
);
