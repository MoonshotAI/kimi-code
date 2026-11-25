import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userData: '',
  version: '1.5.0',
  info: vi.fn(),
  warn: vi.fn(),
  track: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => mocks.version,
  },
}));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { info: mocks.info, warn: mocks.warn } }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trySendDesktopEvent: mocks.track }));

import { loadUiState, savePendingSessionContinue } from '../../../src/main/app/ui-state';
import {
  continueSessionsAfterRestart,
  listBusySessions,
  prepareSessionContinue,
} from '../../../src/main/server/session-continue';

const ORIGIN = 'http://127.0.0.1:54321';
const NOW = new Date('2026-11-22T10:00:00Z').getTime();

function response(ok: boolean, status: number, payload: unknown): Response {
  return { ok, status, json: async () => payload } as Response;
}

function page(items: unknown[], nextPageToken?: string): Response {
  return response(true, 200, {
    code: 0,
    data: { items, has_more: nextPageToken !== undefined, next_page_token: nextPageToken },
  });
}

function continued(): Response {
  return response(true, 200, { code: 0, data: { continued: true } });
}

function requestedUrls(fetcher: ReturnType<typeof vi.fn>): string[] {
  return fetcher.mock.calls.map(([url]) => url as string);
}

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'kimi-session-continue-'));
  mocks.version = '1.5.0';
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(mocks.userData, { recursive: true, force: true });
});

describe('listBusySessions', () => {
  const signal = new AbortController().signal;

  it('follows every page with the server credential under one deadline', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: 's1', title: 'One', activity: 'turn' }], 'next-1'))
      .mockResolvedValueOnce(page([{ id: 's2', title: 'Two', activity: 'background' }]));

    expect(await listBusySessions(ORIGIN, 'secret', signal, fetcher)).toEqual([
      { id: 's1', title: 'One', turnRunning: true },
      { id: 's2', title: 'Two', turnRunning: false },
    ]);
    expect(requestedUrls(fetcher)).toEqual([
      `${ORIGIN}/api/v1/sessions?busy=true&archived=all&page_size=100`,
      `${ORIGIN}/api/v1/sessions?busy=true&archived=all&page_size=100&page_token=next-1`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toEqual({ headers: { Authorization: 'Bearer secret' }, signal });
    }
  });

  it('titles untitled sessions like the sidebar and keeps every title on one short line', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      page([
        { id: 's1', title: '  ', last_prompt: 'Refactor\n\nthe  parser', activity: 'turn' },
        { id: 'session-abcdefghijk', title: '', activity: 'turn' },
        { id: 's3', title: '长'.repeat(80), activity: 'turn' },
        { title: 'missing id', activity: 'turn' },
        null,
      ]),
    );

    const titles = (await listBusySessions(ORIGIN, undefined, signal, fetcher)).map((session) => session.title);

    expect(titles).toEqual(['Refactor the parser', 'session-abcd', `${'长'.repeat(59)}…`]);
  });

  it('stops paging at the page limit', async () => {
    const fetcher = vi.fn().mockResolvedValue(page([{ id: 's1', title: 'One', activity: 'turn' }], 'again'));
    expect(await listBusySessions(ORIGIN, undefined, signal, fetcher)).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('rejects when the server answers with an error status', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(false, 500, null));
    await expect(listBusySessions(ORIGIN, undefined, signal, fetcher)).rejects.toThrow('HTTP 500');
  });
});

describe('prepareSessionContinue', () => {
  it('records the sessions chosen in the restart prompt', () => {
    prepareSessionContinue(['s1', 's3']);

    expect(loadUiState().pendingSessionContinue).toEqual({
      sessionIds: ['s1', 's3'],
      armedAt: NOW,
      fromVersion: '1.5.0',
    });
    expect(mocks.track).toHaveBeenCalledWith('update_session_continue', { outcome: 'armed', session_count: 2 });
  });

  it('clears an earlier marker when no session should continue', () => {
    savePendingSessionContinue({ sessionIds: ['old'], armedAt: NOW, fromVersion: '1.5.0' });

    prepareSessionContinue([]);

    expect(loadUiState().pendingSessionContinue).toBeUndefined();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('lets a failed marker write reach the caller without reporting the sessions as armed', () => {
    mkdirSync(join(mocks.userData, 'ui-state.json'));

    expect(() => prepareSessionContinue(['s1'])).toThrow();

    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });
});

describe('continueSessionsAfterRestart', () => {
  function arm(sessionIds: string[], overrides: { armedAt?: number; fromVersion?: string } = {}): void {
    savePendingSessionContinue({
      sessionIds,
      armedAt: overrides.armedAt ?? NOW - 60_000,
      fromVersion: overrides.fromVersion ?? '1.4.2',
    });
  }

  it('does nothing without a marker', async () => {
    const fetcher = vi.fn();
    await continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('continues every recorded session once after the update', async () => {
    arm(['s1', 'a/b']);
    const fetcher = vi.fn().mockResolvedValue(continued());

    await continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);

    expect(requestedUrls(fetcher)).toEqual([
      `${ORIGIN}/api/v1/sessions/s1:continue`,
      `${ORIGIN}/api/v1/sessions/a%2Fb:continue`,
    ]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    });
    expect(mocks.track).toHaveBeenCalledWith('update_session_continue', {
      outcome: 'attempted',
      session_count: 2,
      continued_count: 2,
    });
    expect(loadUiState().pendingSessionContinue).toBeUndefined();

    await continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('continues sessions one at a time', async () => {
    arm(['s1', 's2']);
    let finishFirst!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValueOnce(continued());

    const run = continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    finishFirst(continued());
    await run;

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps going when a session cannot be continued', async () => {
    arm(['s1', 's2', 's3']);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(false, 409, { code: 40940, msg: 'Nothing to continue' }))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(continued());

    await continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringMatching(/s1 .*Nothing to continue/));
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringMatching(/s2 .*socket hang up/));
    expect(mocks.track).toHaveBeenCalledWith('update_session_continue', {
      outcome: 'attempted',
      session_count: 3,
      continued_count: 1,
    });
  });

  it('skips the marker when the app was not updated', async () => {
    arm(['s1'], { fromVersion: '1.5.0' });
    const fetcher = vi.fn();

    await continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith('update_session_continue', { outcome: 'not_updated', session_count: 1 });
    expect(loadUiState().pendingSessionContinue).toBeUndefined();
  });

  it.each([
    ['older than ten minutes', NOW - 10 * 60_000 - 1],
    ['from the future', NOW + 1_000],
  ])('skips a marker %s', async (_label, armedAt) => {
    arm(['s1'], { armedAt });
    const fetcher = vi.fn();

    await continueSessionsAfterRestart(ORIGIN, 'secret', fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith('update_session_continue', { outcome: 'expired', session_count: 1 });
    expect(loadUiState().pendingSessionContinue).toBeUndefined();
  });
});
