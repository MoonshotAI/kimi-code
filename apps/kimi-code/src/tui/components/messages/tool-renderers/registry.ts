import { readMediaSummary } from './media';
import { shellExecutionResultRenderer } from '../shell-execution';
import { goalSummary } from './goal';
import { waitForSummary } from './wait-for';
import {
  fetchSummary,
  fileChangeSummary,
  globSummary,
  grepSummary,
  readSummary,
  thinkSummary,
  webSearchSummary,
} from './summary';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

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
      return fileChangeSummary;
    case 'Write':
      return fileChangeSummary;
    case 'CreateGoal':
    case 'GetGoal':
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return goalSummary;
    case 'WaitFor':
      return waitForSummary;
    default:
      return renderTruncated;
  }
}

export type { ResultRenderer } from './types';
