import type { ContentPart } from '@moonshot-ai/kosong';

import type { ExecutableToolResult } from '../../loop/types';

export type ToolTelemetryResult = ExecutableToolResult;

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

function toolResultText(result: ToolTelemetryResult): string {
  return toolOutputText(result.output);
}

export function telemetryToolOutcome(
  result: ToolTelemetryResult,
): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  if (result.cancelledByUser === true) return 'cancelled';
  return 'error';
}

export function telemetryToolErrorType(result: ToolTelemetryResult): string {
  const text = toolResultText(result);
  if (text.startsWith('Tool "') && text.includes('" not found')) return 'ToolNotFound';
  if (text.startsWith('Invalid args for tool "')) return 'ToolInputError';
  if (text.includes('prepareToolExecution hook failed')) return 'HookError';
  if (text.includes('finalizeToolResult hook failed')) return 'HookError';
  if (text.includes('blocked')) return 'ToolBlocked';
  return 'ToolError';
}
