import type { BackgroundAgentStatusData } from '@/tui/types';

import { sanitizeShellOutput } from './shell-output';

const MONITOR_TASK_ID_PREFIX = 'monitor-';
const MONITOR_EVENT_TITLE_PREFIX = 'Monitor event: ';
const EVENT_BLOCK = /<event(?: omitted="(\d+)")?>\n([\s\S]*?)\n?<\/event>/;
const TITLE_LINE = /^Title: (.*)$/m;
const ENTITY = /&(?:lt|gt|amp);/g;
const ENTITIES: Readonly<Record<string, string>> = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };

export function isMonitorTaskId(taskId: string): boolean {
  return taskId.startsWith(MONITOR_TASK_ID_PREFIX);
}

function monitorEventDescription(title: string): string | undefined {
  if (!title.startsWith(MONITOR_EVENT_TITLE_PREFIX)) return undefined;
  const description = title.slice(MONITOR_EVENT_TITLE_PREFIX.length).trim();
  return description.length > 0 ? description : undefined;
}

export function formatMonitorEvent(
  description: string | undefined,
  lines: readonly string[],
  omitted: number,
): BackgroundAgentStatusData {
  return {
    phase: 'event',
    headline: 'monitor event',
    detail: description,
    lines: lines.map((line) => sanitizeShellOutput(line)),
    omittedLines: omitted,
  };
}

export function monitorEventFromNotification(text: string): BackgroundAgentStatusData | undefined {
  const block = EVENT_BLOCK.exec(text);
  if (block === null) return undefined;
  const lines = (block[2] ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.replaceAll(ENTITY, (entity) => ENTITIES[entity] ?? entity));
  const title = TITLE_LINE.exec(text)?.[1];
  return formatMonitorEvent(
    title === undefined ? undefined : monitorEventDescription(title),
    lines,
    Number(block[1] ?? 0),
  );
}
