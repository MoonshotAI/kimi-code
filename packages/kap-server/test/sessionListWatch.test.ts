/**
 * `SessionListWatchService` — two-layer watcher over the shared sessions tree
 * (design §3.8 event plane; run:
 * `pnpm --filter @moonshot-ai/kap-server exec vitest run test/sessionListWatch.test.ts`).
 *
 * Real chokidar (`HostFsWatchService`) + real tmp dirs; only the core event
 * bus is faked (a collect-only `publish`). Cases pin the §3.8 contract:
 * existing workspace + new session dir → hint; new workspace appears → hint;
 * session/workspace dirs deleted → hint; boot with pre-existing dirs is
 * silent; a same-window burst collapses into ONE hint; nothing fires after
 * dispose.
 */
import { mkdirSync, mkdtemp, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HostFsWatchService,
  type DomainEvent,
  type IEventService,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionListWatchService } from '../src/services/sessionListWatch/sessionListWatchService';

const DEBOUNCE_MS = 40;
/** Time given to chokidar to register newly-watched paths before mutating
    (same settle constant as the fs-watch e2e suite). */
const WATCH_SETTLE_MS = 150;
/** How long to wait for a hint before declaring it lost. */
const HINT_TIMEOUT_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function collectingEvents(): { events: IEventService; published: DomainEvent[] } {
  const published: DomainEvent[] = [];
  return {
    published,
    events: {
      publish: (event: DomainEvent) => published.push(event),
    } as unknown as IEventService,
  };
}

describe('SessionListWatchService', () => {
  let root: string;
  let sessionsDir: string;
  let published: DomainEvent[];
  let service: SessionListWatchService | undefined;

  beforeEach(async () => {
    root = await new Promise<string>((resolve, reject) =>
      mkdtemp(join(tmpdir(), 'kimi-sessionlist-watch-'), (err, dir) =>
        err === null ? resolve(dir) : reject(err),
      ),
    );
    sessionsDir = join(root, 'sessions');
    ({ published } = collectingEvents());
  });

  afterEach(async () => {
    service?.dispose();
    service = undefined;
    if (root !== '') {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  async function boot(opts?: { debounceMs?: number }): Promise<void> {
    const events = collectingEvents();
    published = events.published;
    service = new SessionListWatchService({
      sessionsDir,
      fsWatch: new HostFsWatchService(),
      events: events.events,
      debounceMs: opts?.debounceMs ?? DEBOUNCE_MS,
    });
    await service.start();
    await sleep(WATCH_SETTLE_MS);
  }

  /** Wait until at least `count` hints were published; fails the test on timeout. */
  async function waitForHints(count: number): Promise<void> {
    await vi.waitFor(() => expect(published.length).toBeGreaterThanOrEqual(count), {
      timeout: HINT_TIMEOUT_MS,
      interval: 25,
    });
  }

  function expectHintShape(event: DomainEvent | undefined): void {
    expect(event).toEqual({ type: 'session.list_changed', payload: {} });
  }

  it(
    'emits a hint when a second session dir appears under an existing workspace, and boot stays silent',
    { timeout: 20_000 },
    async () => {
      mkdirSync(join(sessionsDir, 'ws1', 's1'), { recursive: true });
      await boot();

      // ignoreInitial everywhere: pre-existing workspace/session trees must
      // not produce a boot flood before anything actually changes.
      expect(published).toHaveLength(0);

      mkdirSync(join(sessionsDir, 'ws1', 's2'));
      await waitForHints(1);
      expectHintShape(published[0]);
    },
  );

  it(
    'emits a hint when a new workspace appears, and again for a session created inside it',
    { timeout: 20_000 },
    async () => {
      await boot();
      expect(published).toHaveLength(0);

      // Root watcher: workspace dir appears.
      mkdirSync(join(sessionsDir, 'wsA'));
      await waitForHints(1);
      expectHintShape(published[0]);

      // The dynamically added per-workspace watcher picks up sessions created
      // inside the new workspace afterwards.
      await sleep(WATCH_SETTLE_MS);
      mkdirSync(join(sessionsDir, 'wsA', 's1'));
      await waitForHints(2);
      expectHintShape(published[1]);
    },
  );

  it(
    'emits a hint when a session dir is deleted',
    { timeout: 20_000 },
    async () => {
      mkdirSync(join(sessionsDir, 'ws1', 's1'), { recursive: true });
      mkdirSync(join(sessionsDir, 'ws1', 's2'), { recursive: true });
      await boot();

      rmSync(join(sessionsDir, 'ws1', 's2'), { recursive: true, force: true });
      await waitForHints(1);
      expectHintShape(published[0]);
    },
  );

  it(
    'emits a hint when a workspace dir is deleted',
    { timeout: 20_000 },
    async () => {
      mkdirSync(join(sessionsDir, 'ws1'), { recursive: true });
      await boot();

      rmSync(join(sessionsDir, 'ws1'), { recursive: true, force: true });
      await waitForHints(1);
      expectHintShape(published[0]);
    },
  );

  it(
    'debounces a same-window burst into a single hint',
    { timeout: 20_000 },
    async () => {
      mkdirSync(join(sessionsDir, 'ws1'), { recursive: true });
      await boot();

      mkdirSync(join(sessionsDir, 'ws1', 's1'));
      mkdirSync(join(sessionsDir, 'ws1', 's2'));
      mkdirSync(join(sessionsDir, 'ws1', 's3'));
      await waitForHints(1);
      // Silence several debounce windows: nothing more may arrive — the burst
      // was coalesced, and repeated hints would inflate the count.
      await sleep(DEBOUNCE_MS * 6);
      expect(published).toHaveLength(1);
    },
  );

  it(
    'stops emitting after dispose',
    { timeout: 20_000 },
    async () => {
      mkdirSync(join(sessionsDir, 'ws1'), { recursive: true });
      await boot();

      service?.dispose();

      mkdirSync(join(sessionsDir, 'ws1', 's1'));
      mkdirSync(join(sessionsDir, 'ws2'));
      await sleep(WATCH_SETTLE_MS + DEBOUNCE_MS * 5);
      expect(published).toHaveLength(0);
    },
  );
});
