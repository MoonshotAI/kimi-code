/**
 * Monitor notification rendering — builds the notification payload for a
 * fired monitor, rendered into chat history via `renderNotificationXml`
 * (category `'monitor'`), mirroring the background-task notification
 * pipeline in `agent/background/index.ts`.
 *
 * The payload is rebuilt from the persisted {@link MonitorRecord} plus its
 * {@link MonitorFireDetails} so a fired-but-undelivered notification can be
 * re-appended verbatim after a session resume.
 */

import { escapeXml } from '../../utils/xml-escape';

import type { MonitorTrigger } from '../context/types';

import type { MonitorFileEvent, MonitorRecord } from './manager';

/** Everything needed to rebuild a fire notification after a resume. */
export interface MonitorFireDetails {
  readonly trigger: MonitorTrigger;
  /** The output line that matched (task_output / command monitors). */
  readonly matchedLine?: string;
  /** Exit code of the watched command (`exit` trigger). Null when unknown. */
  readonly exitCode?: number | null;
  /** File event kind that fired a file monitor. */
  readonly fileEvent?: MonitorFileEvent;
  /** Path of the file whose event fired a file monitor. */
  readonly filePath?: string;
  /** Epoch ms when the monitor fired. */
  readonly firedAt: number;
}

export type MonitorNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'monitor';
  readonly type: string;
  readonly source_kind: 'monitor';
  readonly source_id: string;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
};

/**
 * Cap on the matched line echoed into the notification body so a single
 * pathological line cannot flood the context window.
 */
const MATCHED_LINE_MAX_CHARS = 500;

function truncateMatchedLine(line: string): string {
  if (line.length <= MATCHED_LINE_MAX_CHARS) return line;
  return `${line.slice(0, MATCHED_LINE_MAX_CHARS)}…(truncated)`;
}

export function buildMonitorNotification(
  record: MonitorRecord,
  fire: MonitorFireDetails,
): MonitorNotification {
  const lines: string[] = [];
  if (record.description !== undefined) lines.push(`Description: ${record.description}`);
  switch (record.type) {
    case 'task_output':
      lines.push(`Watched task: ${record.taskId ?? 'unknown'}`);
      lines.push(`Pattern: /${record.pattern ?? ''}/`);
      break;
    case 'command':
      lines.push(`Command: ${record.command ?? ''}`);
      if (record.pattern !== undefined) lines.push(`Pattern: /${record.pattern}/`);
      break;
    case 'file':
      lines.push(`Path: ${record.path ?? ''}`);
      lines.push(`Events: ${(record.events ?? ['created', 'modified']).join(', ')}`);
      break;
  }
  switch (fire.trigger) {
    case 'match':
      if (record.type === 'file') {
        lines.push(`File ${fire.fileEvent ?? 'changed'}: ${fire.filePath ?? ''}`);
      } else {
        lines.push(`Matched line: ${escapeXml(truncateMatchedLine(fire.matchedLine ?? ''))}`);
      }
      break;
    case 'exit':
      lines.push(
        fire.exitCode === null || fire.exitCode === undefined
          ? 'The command exited.'
          : `The command exited with code ${String(fire.exitCode)}.`,
      );
      break;
    case 'timeout':
      lines.push(`The monitor timed out after ${String(record.timeoutS)}s without firing.`);
      break;
  }
  lines.push(`Fired at: ${new Date(fire.firedAt).toISOString()}`);
  lines.push('This monitor is one-shot and is now closed; create a new monitor to keep watching.');
  return {
    id: record.notificationId ?? `monitor:${record.id}`,
    category: 'monitor',
    type: `monitor.${fire.trigger}`,
    source_kind: 'monitor',
    source_id: record.id,
    title: `Monitor ${record.type} ${fire.trigger}`,
    severity: fire.trigger === 'timeout' ? 'warning' : 'info',
    body: lines.join('\n'),
  };
}
