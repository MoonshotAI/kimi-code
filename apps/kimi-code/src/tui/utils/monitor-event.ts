import type { BackgroundAgentStatusData } from '@/tui/types';

const MONITOR_TASK_ID_PREFIX = 'monitor-';
const MONITOR_EVENT_TITLE_PREFIX = 'Monitor event: ';
const EVENT_BLOCK = /<event>\n([\s\S]*?)\n?<\/event>/;
const TITLE_LINE = /^Title: (.*)$/m;

export function isMonitorTaskId(taskId: string): boolean {
  return taskId.startsWith(MONITOR_TASK_ID_PREFIX);
}

function monitorEventLines(text: string): readonly string[] | undefined {
  const block = EVENT_BLOCK.exec(text)?.[1];
  if (block === undefined) return undefined;
  return block
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
}

function monitorEventDescription(title: string): string | undefined {
  if (!title.startsWith(MONITOR_EVENT_TITLE_PREFIX)) return undefined;
  const description = title.slice(MONITOR_EVENT_TITLE_PREFIX.length).trim();
  return description.length > 0 ? description : undefined;
}

export function formatMonitorEvent(
  description: string | undefined,
  lines: readonly string[],
): BackgroundAgentStatusData {
  return { phase: 'event', headline: 'monitor event', detail: description, lines };
}

export function monitorEventFromNotification(text: string): BackgroundAgentStatusData | undefined {
  const lines = monitorEventLines(text);
  if (lines === undefined) return undefined;
  const title = TITLE_LINE.exec(text)?.[1];
  return formatMonitorEvent(title === undefined ? undefined : monitorEventDescription(title), lines);
}
