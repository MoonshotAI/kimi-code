import {
  summarizeActivity as summarizeActivityBase,
  summarizeLive as summarizeLiveBase,
  type ActivitySummary,
  type ActivitySummaryItem,
  type LiveSummary,
} from '@moonshot-ai/app-core/lib';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { t } from '@moonshot-ai/app-client/client';
import { browserClauseProvider } from '../chat/tool-calls/browserActivity';
import type { BrowserToolContext } from '../chat/tool-calls/browserToolPresentation';

export type {
  ActivitySummary,
  ActivitySummaryItem,
  ActivitySummaryTool,
  LiveSummary,
  SummaryClause,
  SummaryFragment,
  SummaryTone,
} from '@moonshot-ai/app-core/lib';

export interface ActivityBrowserOptions {
  contextOf?: (tool: ToolCall) => BrowserToolContext | undefined;
  recovered?: ReadonlySet<object>;
}

export function summarizeActivity(
  items: ActivitySummaryItem[],
  opts: { durationMs?: number; browser?: ActivityBrowserOptions } = {},
): ActivitySummary {
  return summarizeActivityBase(t, items, { durationMs: opts.durationMs, providers: [browserClauseProvider(t, opts.browser)] });
}

export function summarizeLive(
  items: ActivitySummaryItem[],
  current: ActivitySummaryItem | null,
  browser?: ActivityBrowserOptions,
): LiveSummary {
  return summarizeLiveBase(t, items, current, [browserClauseProvider(t, browser)]);
}
