// App shell over @moonshot-ai/app-core/lib's activitySummary: the summary
// builders live in the package with the translator injected; this module binds
// them to the app-client deps translator (registered by each app's main.ts).

import {
  summarizeActivity as summarizeActivityBase,
  summarizeLive as summarizeLiveBase,
  type ActivitySummary,
  type ActivitySummaryItem,
  type LiveSummary,
} from '@moonshot-ai/app-core/lib';
import { t } from '@moonshot-ai/app-client/client';

export type {
  ActivitySummary,
  ActivitySummaryItem,
  ActivitySummaryTool,
  LiveSummary,
  SummaryClause,
  SummaryFragment,
  SummaryTone,
} from '@moonshot-ai/app-core/lib';

export function summarizeActivity(
  items: ActivitySummaryItem[],
  opts: { durationMs?: number } = {},
): ActivitySummary {
  return summarizeActivityBase(t, items, opts);
}

export function summarizeLive(items: ActivitySummaryItem[], current: ActivitySummaryItem | null): LiveSummary {
  return summarizeLiveBase(t, items, current);
}
