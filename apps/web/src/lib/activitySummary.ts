// apps/kimi-web/src/lib/activitySummary.ts
// App shell over @moonshot-ai/app-core/lib's activitySummary: the summary
// builders live in the package with the translator injected; this module binds
// them to the app i18n instance so existing call sites keep working unchanged.

import {
  summarizeActivity as summarizeActivityBase,
  summarizeLive as summarizeLiveBase,
  type ActivitySummary,
  type ActivitySummaryItem,
  type LiveSummary,
} from '@moonshot-ai/app-core/lib';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { i18n } from '../i18n';

const t: Translator = (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));

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
