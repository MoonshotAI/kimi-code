/**
 * Tool result renderer registry.
 *
 * Each tool name maps to a `ResultRenderer` that turns the tool's
 * `ToolResultBlockData` into renderable Components. Tools without an
 * explicit entry fall through to `renderTruncated` (the original
 * 3-line + ctrl+o behavior).
 *
 * Keep this dispatch flat — tool names live next to the renderer they
 * choose, so adding a new tool means appending one case.
 */

import { readMediaSummary } from './media';
import { shellExecutionResultRenderer } from '../shell-execution';
import { goalSummary } from './goal';
import {
  editSummary,
  fetchSummary,
  globSummary,
  grepSummary,
  readSummary,
  thinkSummary,
  webSearchSummary,
  writeSummary,
} from './summary';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

/**
 * True when a tool has no dedicated renderer and falls back to the generic
 * truncated output (every MCP tool and any tool not listed below). Used to
 * decide whether subagent sub-tool output should be previewed the same way
 * the main agent previews it.
 */
export function isGenericToolResult(toolName: string): boolean {
  return pickResultRenderer(toolName) === renderTruncated;
}

export function pickResultRenderer(toolName: string): ResultRenderer {
  switch (toolName) {
    case 'Read':
      return readSummary;
    case 'ReadMediaFile':
      return readMediaSummary;
    case 'Grep':
      return grepSummary;
    case 'Glob':
      return globSummary;
    case 'FetchURL':
      return fetchSummary;
    case 'WebSearch':
      return webSearchSummary;
    case 'Bash':
      return shellExecutionResultRenderer;
    case 'Think':
      return thinkSummary;
    case 'Edit':
      return editSummary;
    case 'Write':
      return writeSummary;
    case 'CreateGoal':
    case 'GetGoal':
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return goalSummary;
    default:
      return renderTruncated;
  }
}

export type { ResultRenderer } from './types';
