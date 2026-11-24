import { describe, expect, it } from 'vitest';
import {
  cleanNotificationRest,
  compactNotificationOutputPath,
  formatNotificationDuration,
  isStockNotificationTitle,
  notificationStatus,
  notificationVariant,
  parseStockNotificationBody,
  splitNotificationWallTime,
  stockNotificationDisplay,
} from '../src/client';
import type { TaskNotification } from '../src/client/types';

const COMPLETED: TaskNotification = {
  id: 'task:bash-lo9yv9ch:completed',
  type: 'task.completed',
  sourceKind: 'background_task',
  sourceId: 'bash-lo9yv9ch',
  title: 'desktop dev (renderer HMR + embedded server)',
  severity: 'info',
  body: 'Background process completed.',
  raw: '{}',
};

describe('notificationStatus / notificationVariant', () => {
  const base = COMPLETED;
  const withType = (type: string, severity = 'info') => ({ ...base, type, severity });

  it('derives status from the type suffix', () => {
    expect(notificationStatus(withType('task.completed'))).toBe('completed');
    expect(notificationStatus(withType('task.failed'))).toBe('failed');
    expect(notificationStatus(withType('task.timed_out'))).toBe('timed_out');
    expect(notificationStatus(withType('task.killed'))).toBe('killed');
    expect(notificationStatus(withType('task.lost'))).toBe('lost');
    expect(notificationStatus(withType('task.whatever'))).toBe('info');
  });

  it('maps status to variant, with severity as the fallback for unknown types', () => {
    expect(notificationVariant(withType('task.completed'))).toBe('ok');
    expect(notificationVariant(withType('task.failed'))).toBe('err');
    expect(notificationVariant(withType('task.timed_out'))).toBe('err');
    expect(notificationVariant(withType('task.lost'))).toBe('err');
    expect(notificationVariant(withType('task.killed'))).toBe('warn');
    expect(notificationVariant(withType('task.whatever', 'error'))).toBe('err');
    expect(notificationVariant(withType('task.whatever', 'warning'))).toBe('warn');
    expect(notificationVariant(withType('task.whatever', 'info'))).toBe('info');
  });
});

describe('parseStockNotificationBody', () => {
  it('parses the plain status sentences', () => {
    expect(parseStockNotificationBody('mark-stable gate completed.')).toEqual({
      status: 'completed',
      description: 'mark-stable gate',
      reason: undefined,
      rest: undefined,
    });
    expect(parseStockNotificationBody('Build on M4 failed.')).toMatchObject({
      status: 'failed',
      description: 'Build on M4',
    });
    expect(parseStockNotificationBody('Nightly bench timed out.')).toMatchObject({
      status: 'timed_out',
      description: 'Nightly bench',
    });
    expect(parseStockNotificationBody('Watcher lost.')).toMatchObject({
      status: 'lost',
      description: 'Watcher',
    });
  });

  it('parses the v2 stopped forms', () => {
    expect(parseStockNotificationBody('Build on M4 was stopped by user.')).toMatchObject({
      status: 'killed',
      description: 'Build on M4',
      userStopped: true,
    });
    expect(parseStockNotificationBody('Build on M4 was stopped.')).toMatchObject({
      status: 'killed',
      description: 'Build on M4',
      userStopped: false,
    });
    expect(parseStockNotificationBody('Build on M4 was stopped. Reason: OOM')).toMatchObject({
      status: 'killed',
      description: 'Build on M4',
      reason: 'OOM',
    });
  });

  it('parses the v2 reason suffix and the v1 reason forms', () => {
    expect(parseStockNotificationBody('pnpm build failed. Reason: exit code 1')).toMatchObject({
      status: 'failed',
      description: 'pnpm build',
      reason: 'exit code 1',
    });
    expect(parseStockNotificationBody('pnpm build was killed: OOM.')).toMatchObject({
      status: 'killed',
      description: 'pnpm build',
      reason: 'OOM',
    });
    expect(parseStockNotificationBody('pnpm build failed: exit code 1.')).toMatchObject({
      status: 'failed',
      description: 'pnpm build',
      reason: 'exit code 1',
    });
  });

  it('keeps a description that itself ends in a status word', () => {
    expect(parseStockNotificationBody('deploy completed completed.')).toMatchObject({
      status: 'completed',
      description: 'deploy completed',
    });
  });

  it('empties a boilerplate-only description', () => {
    expect(parseStockNotificationBody('Background process completed.')).toMatchObject({
      status: 'completed',
      description: '',
    });
    expect(parseStockNotificationBody('Background agent failed.')).toMatchObject({
      status: 'failed',
      description: '',
    });
  });

  it('keeps the recovery block as rest after a parsed first line', () => {
    const body = 'Explore the codebase failed.\n\nTo recover or continue this subagent, call Agent(resume="agent-1", …).';
    expect(parseStockNotificationBody(body)).toMatchObject({
      status: 'failed',
      description: 'Explore the codebase',
      rest: 'To recover or continue this subagent, call Agent(resume="agent-1", …).',
    });
  });

  it('returns undefined for free-form bodies', () => {
    expect(parseStockNotificationBody('Background process failed with exit code 1.')).toBeUndefined();
    expect(parseStockNotificationBody('anything the model wrote')).toBeUndefined();
    expect(parseStockNotificationBody('')).toBeUndefined();
    expect(parseStockNotificationBody(' completed.')).toBeUndefined();
    expect(parseStockNotificationBody('Wall time: 1.250 seconds')).toBeUndefined();
  });

  it('parses Wall time prefixed bodies from agent-core-v2', () => {
    const body =
      'Wall time: 47.461 seconds\nRun gh auth login device flow and wait for browser authorization completed.';
    expect(parseStockNotificationBody(body)).toEqual({
      status: 'completed',
      description: 'Run gh auth login device flow and wait for browser authorization',
      wallTimeMs: 47461,
      reason: undefined,
      rest: undefined,
    });

    const crlf = 'Wall time: 600.012 seconds\r\nNightly bench timed out. Reason: deadline exceeded';
    expect(parseStockNotificationBody(crlf)).toEqual({
      status: 'timed_out',
      description: 'Nightly bench',
      wallTimeMs: 600012,
      reason: 'deadline exceeded',
      rest: undefined,
    });
  });
});

describe('notification formatting helpers', () => {
  it('splits optional Wall time lines without mutating plain bodies', () => {
    expect(splitNotificationWallTime('Plain result')).toEqual({
      content: 'Plain result',
      hadWallTime: false,
    });
    expect(splitNotificationWallTime('Wall time: 0.420 seconds\nDone')).toEqual({
      wallTimeMs: 420,
      content: 'Done',
      hadWallTime: true,
    });
  });

  it('formats durations including sub-second tasks', () => {
    expect(formatNotificationDuration(undefined)).toBe('');
    expect(formatNotificationDuration(0)).toBe('0s');
    expect(formatNotificationDuration(420)).toBe('<1s');
    expect(formatNotificationDuration(47461)).toBe('47s');
    expect(formatNotificationDuration(600012)).toBe('10m');
  });

  it('compacts long output paths to the trailing task segment and filename', () => {
    expect(
      compactNotificationOutputPath(
        '/Users/demo/.kimi/sessions/019a7c40/agents/main/tasks/bash-wcoonksc/output.log',
      ),
    ).toBe('bash-wcoonksc/output.log');
    expect(compactNotificationOutputPath('C:\\Users\\demo\\tasks\\bash-1\\output.log')).toBe(
      'bash-1/output.log',
    );
    expect(compactNotificationOutputPath('output.log')).toBe('output.log');
  });

  it('strips stock subagent recovery boilerplate while keeping custom trailing lines', () => {
    expect(
      cleanNotificationRest(
        'To recover or continue this subagent, call Agent(resume="agent-1", prompt="continue").',
      ),
    ).toBeUndefined();
    expect(
      cleanNotificationRest(
        'Partial summary saved.\n\nTo recover or continue this subagent, call Agent(resume="agent-1", prompt="continue").',
      ),
    ).toBe('Partial summary saved.');
    expect(cleanNotificationRest('Custom note')).toBe('Custom note');
  });
});

describe('isStockNotificationTitle / stockNotificationDisplay', () => {
  const base = COMPLETED;
  const withFields = (title: string, body: string, type: string) => ({ ...base, title, body, type });

  it('recognizes only the daemon stock titles', () => {
    expect(isStockNotificationTitle('Background process completed')).toBe(true);
    expect(isStockNotificationTitle('Background agent timed_out')).toBe(true);
    expect(isStockNotificationTitle('Background agent timed out')).toBe(true);
    expect(isStockNotificationTitle('desktop dev (renderer HMR + embedded server)')).toBe(false);
    expect(isStockNotificationTitle('')).toBe(false);
  });

  it('parses the body when the title is stock and the status matches the type', () => {
    expect(
      stockNotificationDisplay(
        withFields('Background process completed', 'mark-stable gate completed.', 'task.completed'),
      ),
    ).toMatchObject({ status: 'completed', description: 'mark-stable gate' });
  });

  it('passes free-form notifications through untouched', () => {
    expect(
      stockNotificationDisplay(
        withFields('desktop dev (renderer HMR + embedded server)', 'Background process completed.', 'task.completed'),
      ),
    ).toBeUndefined();
    expect(
      stockNotificationDisplay(withFields('Build monitor', 'No jobs completed.', 'task.completed')),
    ).toBeUndefined();
  });

  it('rejects a body whose status contradicts the notification type', () => {
    expect(
      stockNotificationDisplay(
        withFields('Background process failed', 'No jobs completed.', 'task.failed'),
      ),
    ).toBeUndefined();
    expect(
      stockNotificationDisplay(
        withFields('Background process failed', 'Build on M4 failed.', 'task.completed'),
      ),
    ).toBeUndefined();
  });

  it('rejects an unparseable stock-titled body', () => {
    expect(
      stockNotificationDisplay(
        withFields('Background process failed', 'Background process failed with exit code 1.', 'task.failed'),
      ),
    ).toBeUndefined();
  });
});
