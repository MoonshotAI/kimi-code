/**
 * Phase-2 session-ownership verification matrix — multi-process e2e over real
 * REST boundaries (design `.tmp/refactor-watch-design-v2.md` §3.10).
 *
 * One session write lease per session under `<home>/session-leases/<id>.lock`.
 * The permanent sentinel is protected by a kernel lock; the sibling
 * `<id>.lock.owner.json` document only advertises holder metadata.
 * Materializing routes on a peer-held session answer HTTP 200 with envelope
 * `code 40921 session.held_by_peer` + ownership details. kap-server's own e2e
 * already pins the dual-open envelope schema and graceful-close takeover; the
 * unique value here is cross-PROCESS behavior and byte-level file integrity:
 *
 *   1. Concurrent dual materialization race (in-process `startServerPair`):
 *      A creates the session, then `GET .../warnings` storms fire on A and B
 *      concurrently for several rounds — A always serves (code 0), B always
 *      loses with 40921 phase `routable` + A's address — followed by a
 *      `*.jsonl` byte-integrity sweep of the shared home (no torn records) and
 *      a single-lease assertion.
 *   2. SIGSTOP → no takeover, SIGCONT → clean continuation (subprocess pair):
 *      a stopped holder keeps the kernel lock indefinitely; B remains refused
 *      with phase `routable`, the `lock_id` stays stable, and the original
 *      holder resumes cleanly after SIGCONT.
 *   3. kill -9 → kernel release with data intact (subprocess pair): after the
 *      holder dies and is reaped, B acquires the released kernel lock with a
 *      NEW lock_id and overwrites owner metadata in place. The sentinel stays
 *      put, no stale sibling is created, and the session remains intact.
 *
 * Every subprocess scenario ends with dispose() + an explicit pid-dead check
 * (ESRCH) so no child server can linger across tests.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionLeasePath } from '@moonshot-ai/agent-core-v2';
import { ErrorCode, sessionOwnershipDetailsSchema } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { DaemonClient } from '../harness/index.js';
import {
  spawnServerProcessPair,
  startServerPair,
  waitForServerHealthy,
} from '../harness/testing/index.js';
import { createCaseLogger } from './log.js';

const SESSION_OWNERSHIP_HELD_BY_PEER = 40921;

describe('session ownership: concurrent dual materialization race (in-process pair)', () => {
  it(
    'holder serves, peer gets 40921 routable every round, no torn JSONL on disk',
    { timeout: 90_000 },
    async () => {
      const log = createCaseLogger('session-ownership/materialization-race');
      const pair = await startServerPair();
      try {
        const sessionId = await createSession(pair.urlA, pair.cwd);
        log('session created on A', { sessionId, urlA: pair.urlA, urlB: pair.urlB });

        const lease = await readLease(pair.home, sessionId);
        log('lease after create', lease);
        expect(lease?.['address']).toBe(pair.urlA);
        const lockId = lease?.['lock_id'];
        expect(typeof lockId).toBe('string');

        const ROUNDS = 5;
        for (let round = 1; round <= ROUNDS; round += 1) {
          const [a, b] = await Promise.all([
            getEnvelope(pair.urlA, warningsPath(sessionId)),
            getEnvelope(pair.urlB, warningsPath(sessionId)),
          ]);
          expect(a.status).toBe(200);
          expect(a.body.code).toBe(0);
          expect(b.status).toBe(200);
          expect(b.body.code).toBe(ErrorCode.SESSION_HELD_BY_PEER);
          expect(b.body.code).toBe(SESSION_OWNERSHIP_HELD_BY_PEER);
          const details = sessionOwnershipDetailsSchema.parse(b.body.details);
          expect(details).toEqual({ kind: 'held-by-peer', phase: 'routable', address: pair.urlA });
          if (round === 1 || round === ROUNDS) {
            log(`concurrent round ${round}/${ROUNDS}`, {
              holder: { status: a.status, code: a.body.code },
              peer: { status: b.status, code: b.body.code, details },
            });
          }
        }

        // The permanent sentinel and owner metadata remain stable under A.
        const leaseFilenames = await listLeaseFilenames(pair.home);
        const related = leaseFilenames.filter((name) => name.startsWith(`${sessionId}.lock`));
        expect(related).toEqual([`${sessionId}.lock`, `${sessionId}.lock.owner.json`]);
        const after = await readLease(pair.home, sessionId);
        expect(after?.['lock_id']).toBe(lockId);
        expect(after?.['address']).toBe(pair.urlA);

        const sweep = await assertJsonlIntegrity(pair.home);
        log('byte-integrity sweep', sweep);
        expect(sweep.files).toBeGreaterThan(0);
      } finally {
        await pair.dispose();
      }
    },
  );
});

describe('session ownership: SIGSTOP/SIGCONT (subprocess pair)', () => {
  it(
    'a stopped holder keeps the kernel lock; after SIGCONT it resumes cleanly',
    { timeout: 150_000 },
    async () => {
      const log = createCaseLogger('session-ownership/sigstop-sigcont');
      const pair = await spawnServerProcessPair();
      // If the test fails mid-stop, un-freeze the child before teardown so
      // dispose()'s SIGTERM can be acted on without the SIGKILL escalation.
      let holderStopped = false;
      try {
        await Promise.all([
          waitForServerHealthy(pair.a.baseUrl, 15_000),
          waitForServerHealthy(pair.b.baseUrl, 15_000),
        ]);
        const sessionId = await createSession(pair.a.baseUrl, pair.home);
        const leaseA = await readLease(pair.home, sessionId);
        expect(leaseA?.['address']).toBe(pair.a.baseUrl);
        expect(leaseA?.['pid']).toBe(pair.a.pid);
        const lockIdA = leaseA?.['lock_id'];
        expect(typeof lockIdA).toBe('string');
        log('holder lease before SIGSTOP', { sessionId, lease: leaseA });

        process.kill(pair.a.pid, 'SIGSTOP');
        holderStopped = true;
        log('SIGSTOP sent', { pid: pair.a.pid });

        await sleep(300);

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const b = await getEnvelope(pair.b.baseUrl, warningsPath(sessionId));
          const details = sessionOwnershipDetailsSchema.parse(b.body.details);
          log(`B resume attempt ${attempt}/2 while A is stopped`, {
            status: b.status,
            code: b.body.code,
            details,
          });
          expect(b.status).toBe(200);
          expect(b.body.code).toBe(SESSION_OWNERSHIP_HELD_BY_PEER);
          expect(details).toEqual({
            kind: 'held-by-peer',
            phase: 'routable',
            address: pair.a.baseUrl,
          });
          if (attempt === 1) await sleep(300);
        }

        // No takeover happened: same lock id and the same two permanent files.
        expect((await readLease(pair.home, sessionId))?.['lock_id']).toBe(lockIdA);
        const filenames = await listLeaseFilenames(pair.home);
        expect(filenames.filter((name) => name.startsWith(`${sessionId}.lock`))).toEqual([
          `${sessionId}.lock`,
          `${sessionId}.lock.owner.json`,
        ]);

        process.kill(pair.a.pid, 'SIGCONT');
        holderStopped = false;
        log('SIGCONT sent', { pid: pair.a.pid });
        await waitForServerHealthy(pair.a.baseUrl, 20_000);

        // The original holder still owns and serves the session.
        const aResumed = await pollUntil(async () => {
          const res = await getEnvelope(pair.a.baseUrl, warningsPath(sessionId));
          return res.body.code === 0 ? res : undefined;
        }, 'A serving the session after SIGCONT', 10_000, 500);
        log('A serving the session after SIGCONT', {
          status: aResumed.status,
          code: aResumed.body.code,
        });

        // B stays refused and remains routable to the original holder.
        const transcript: Array<{ code: number; details: unknown }> = [];
        const routable = await pollUntil(async () => {
          const res = await getEnvelope(pair.b.baseUrl, warningsPath(sessionId));
          transcript.push({ code: res.body.code, details: res.body.details });
          const details = sessionOwnershipDetailsSchema.parse(res.body.details);
          return details.kind === 'held-by-peer' && details.phase === 'routable'
            ? details
            : undefined;
        }, 'B remains 40921 routable after SIGCONT', 15_000, 500);
        log('B observations after SIGCONT', { transcript, final: routable });
        for (const entry of transcript) {
          expect(entry.code).toBe(SESSION_OWNERSHIP_HELD_BY_PEER);
        }
        expect(routable).toEqual({
          kind: 'held-by-peer',
          phase: 'routable',
          address: pair.a.baseUrl,
        });

        // Still the original kernel lease; no stale sibling ever appeared.
        expect((await readLease(pair.home, sessionId))?.['lock_id']).toBe(lockIdA);
        const swept = await assertJsonlIntegrity(pair.home);
        log('byte-integrity sweep', swept);
        expect(swept.files).toBeGreaterThan(0);
      } finally {
        if (holderStopped) {
          try {
            process.kill(pair.a.pid, 'SIGCONT');
          } catch {
            // child already dead — teardown proceeds regardless
          }
        }
        await pair.dispose();
      }
      expect(pidAlive(pair.a.pid)).toBe(false);
      expect(pidAlive(pair.b.pid)).toBe(false);
      log('exit hygiene: both child pids dead after dispose', {
        pidA: pair.a.pid,
        pidB: pair.b.pid,
      });
    },
  );
});

describe('session ownership: kill -9 kernel release (subprocess pair)', () => {
  it(
    'B acquires the released kernel lock with a new lock id and serves the intact session',
    { timeout: 120_000 },
    async () => {
      const log = createCaseLogger('session-ownership/sigkill-kernel-release');
      const pair = await spawnServerProcessPair();
      try {
        await Promise.all([
          waitForServerHealthy(pair.a.baseUrl, 15_000),
          waitForServerHealthy(pair.b.baseUrl, 15_000),
        ]);
        const sessionId = await createSession(pair.a.baseUrl, pair.home);
        const leaseA = await readLease(pair.home, sessionId);
        expect(leaseA?.['address']).toBe(pair.a.baseUrl);
        expect(leaseA?.['pid']).toBe(pair.a.pid);
        const lockIdA = leaseA?.['lock_id'];
        expect(typeof lockIdA).toBe('string');
        log('holder lease before SIGKILL', { sessionId, lease: leaseA });

        pair.a.kill('SIGKILL');
        // Await real death (zombie reaped): the kernel has released A's lock.
        const exited = await waitForPidExit(pair.a.pid, 10_000);
        log('SIGKILL delivered', { pid: pair.a.pid, exited });
        expect(exited).toBe(true);

        // Once A is gone, B acquires the released lock on its first request.
        const success = await getEnvelope(pair.b.baseUrl, warningsPath(sessionId));
        log('B resume success', { status: success.status, code: success.body.code });
        expect(success.status).toBe(200);
        expect(success.body.code).toBe(0);

        // Re-acquisition evidence: new lock id and B's metadata, written next
        // to the unchanged permanent sentinel.
        const leaseB = await readLease(pair.home, sessionId);
        log('lease after kernel release', leaseB);
        expect(typeof leaseB?.['lock_id']).toBe('string');
        expect(leaseB?.['lock_id']).not.toBe(lockIdA);
        expect(leaseB?.['pid']).toBe(pair.b.pid);
        expect(leaseB?.['address']).toBe(pair.b.baseUrl);

        const related = (await listLeaseFilenames(pair.home)).filter((name) =>
          name.startsWith(`${sessionId}.lock`),
        );
        expect(related).toEqual([`${sessionId}.lock`, `${sessionId}.lock.owner.json`]);

        // The session survived the holder change intact.
        const session = await getEnvelope<SessionWire>(pair.b.baseUrl, `/sessions/${sessionId}`);
        log('GET /sessions/{id} on B after kernel release', session.body);
        expect(session.status).toBe(200);
        expect(session.body.code).toBe(0);
        expect(session.body.data?.id).toBe(sessionId);
        expect(session.body.data?.metadata?.cwd).toBe(pair.home);

        const swept = await assertJsonlIntegrity(pair.home);
        log('byte-integrity sweep', swept);
        expect(swept.files).toBeGreaterThan(0);
      } finally {
        await pair.dispose();
      }
      expect(pidAlive(pair.a.pid)).toBe(false);
      expect(pidAlive(pair.b.pid)).toBe(false);
      log('exit hygiene: both child pids dead after dispose', {
        pidA: pair.a.pid,
        pidB: pair.b.pid,
      });
    },
  );
});

/**
 * Multi-instance session-list sync (design `.tmp/refactor-watch-design-v2.md`
 * §3.8): the event-plane hint plus the list-side ownership join. While the
 * ownership matrix above cross-checks dual-open refusals, these cases track a
 * session created on instance A as it surfaces on instance B:
 *
 *   1. A creates a session under a workspace B has never seen → B's root
 *      watcher fires → B's subscribed WS client receives a volatile,
 *      payload-less `session.list_changed` → B's re-pulled list shows the
 *      session with `ownership.held_by = 'peer'` + A's address, while B's own
 *      session reads 'self'.
 *   2. A creates a SECOND session under a workspace B already watches →
 *      discovered all the same (the per-workspace watcher layer).
 *
 * Both run on the in-process pair (real shared home, real chokidar events);
 * the hint is volatile — never journaled — so only live delivery counts.
 *
 * Test-environment note: two kap-server instances in ONE vitest process put
 * enough concurrent fs/fsync load on macOS that Node `fs.watch` (libuv
 * FSEvents — the only mechanism chokidar 4 has) coalesces directory
 * notifications under the shared sessions tree and holds them until further
 * write activity flushes the stream (observed: no delivery within 45s
 * without activity, ~200ms once the tree is tickled). Both cases therefore
 * run a {@link startSessionsTreeKicker} while waiting for the hint; it only
 * touches FILES, which the watch service ignores, so it never produces
 * hints of its own — every observed hint still corresponds to a real
 * workspace/session directory change.
 */
describe('session list sync: session.list_changed hint + ownership join (in-process pair)', () => {
  it(
    'a peer-created session under a NEW workspace surfaces via session.list_changed and lists as held_by=peer',
    { timeout: 60_000 },
    async () => {
      const pair = await startServerPair();
      const stopKicker = startSessionsTreeKicker(join(pair.home, 'sessions'));
      const client = new DaemonClient({ baseUrl: pair.urlB });
      const hints: HintRecord[] = [];
      try {
        // B owns a session so its client has something to subscribe to (global
        // volatile events fan out to subscribed connections only).
        const ownSessionId = await createSession(pair.urlB, pair.cwd);
        await client.connect();
        await client.subscribe(ownSessionId);
        const off = client.onFrame((frame) => {
          if (frame.type === 'session.list_changed') hints.push({ frame, at: Date.now() });
        });
        try {
          // Any hint caused by B's OWN create lands before the baseline; only
          // hints recorded after it count as "A's create reached B".
          const baseline = hints.length;
          const peerWorkspace = join(pair.home, 'peer-workspace');
          mkdirSync(peerWorkspace, { recursive: true });
          const peerSessionId = await createSession(pair.urlA, peerWorkspace);

          const hint = await pollUntil(
            async () => (hints.length > baseline ? hints[hints.length - 1] : undefined),
            'session.list_changed reaching B for the new workspace',
            20_000,
            100,
          );
          expect(hint.frame.session_id).toBe('__global__');
          expect((hint.frame as { volatile?: boolean }).volatile).toBe(true);
          expect(hint.frame.payload).toMatchObject({
            type: 'session.list_changed',
            agentId: 'main',
            sessionId: '__global__',
          });

          // Data plane: the re-pull (as the client would do on the hint)
          // shows A's session; ownership join marks it a routable peer, and
          // B's own session stays 'self'.
          const listed = await client.listSessions();
          const peerRow = listed.items.find((s) => s.id === peerSessionId);
          expect(peerRow?.metadata.cwd).toBe(peerWorkspace);
          expect(peerRow?.ownership).toEqual({ held_by: 'peer', address: pair.urlA });
          expect(listed.items.find((s) => s.id === ownSessionId)?.ownership).toEqual({
            held_by: 'self',
          });
        } finally {
          off();
        }
      } finally {
        stopKicker();
        await client.close();
        await pair.dispose();
      }
    },
  );

  it(
    'a second session under an ALREADY-WATCHED workspace surfaces via session.list_changed on the peer',
    { timeout: 60_000 },
    async () => {
      const pair = await startServerPair();
      const stopKicker = startSessionsTreeKicker(join(pair.home, 'sessions'));
      const client = new DaemonClient({ baseUrl: pair.urlB });
      const hints: HintRecord[] = [];
      try {
        // B's own create establishes the workspace dir; B's watcher picks it up
        // (its own write triggers the same fs events a peer's write would).
        const ownSessionId = await createSession(pair.urlB, pair.cwd);
        // Give B's root watcher time to attach the per-workspace watcher —
        // otherwise A's write below could slip into the attach window and
        // produce no hint (the list would still converge on re-pull; the hint
        // is advisory).
        await sleep(500);
        await client.connect();
        await client.subscribe(ownSessionId);
        const off = client.onFrame((frame) => {
          if (frame.type === 'session.list_changed') hints.push({ frame, at: Date.now() });
        });
        try {
          const baseline = hints.length;
          const peerSessionId = await createSession(pair.urlA, pair.cwd);

          await pollUntil(
            async () => (hints.length > baseline ? hints[hints.length - 1] : undefined),
            'session.list_changed reaching B for a second session in a known workspace',
            20_000,
            100,
          );

          const listed = await client.listSessions();
          expect(listed.items.find((s) => s.id === peerSessionId)?.ownership).toEqual({
            held_by: 'peer',
            address: pair.urlA,
          });
          expect(listed.items.find((s) => s.id === ownSessionId)?.ownership).toEqual({
            held_by: 'self',
          });
        } finally {
          off();
        }
      } finally {
        stopKicker();
        await client.close();
        await pair.dispose();
      }
    },
  );
});

interface HintRecord {
  frame: { type: string; session_id?: string; payload?: unknown };
  at: number;
}

// ── Local helpers ──────────────────────────────────────────────────────────
interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id?: string;
  details?: unknown;
}

interface SessionWire {
  id: string;
  metadata?: { cwd?: string };
}

function warningsPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/warnings`;
}

async function getEnvelope<T = unknown>(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await fetch(`${baseUrl}/api/v1${path}`);
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}

async function createSession(baseUrl: string, cwd: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { cwd } }),
  });
  const body = (await res.json()) as Envelope<{ id: string }>;
  if (res.status !== 200 || body.code !== 0) {
    throw new Error(
      `createSession failed (HTTP ${res.status}, code ${body.code}): ${JSON.stringify(body)}`,
    );
  }
  return body.data.id;
}

/**
 * macOS FSEvents delivery workaround for the in-process pair (see the
 * "session list sync" describe header). Two kap-server instances in one
 * process generate enough concurrent fs/fsync load that Node `fs.watch`
 * notifications under the shared sessions tree are coalesced and held until
 * further write activity flushes the stream — without a kicker, a
 * peer-created session dir never reaches the other instance's
 * `SessionListWatchService` within the test window.
 *
 * Every `intervalMs`, touch+unlink a FILE at the sessions root and inside
 * each workspace bucket (covering both watcher layers). File-kind events are
 * ignored by the watch service, so the kicker never produces hints of its
 * own; it only forces delivery of the pending directory events that real
 * creates are waiting on. Returns a stop function — call it before
 * `pair.dispose()` so no tick races the home teardown.
 */
function startSessionsTreeKicker(sessionsRoot: string, intervalMs = 250): () => void {
  const timer = setInterval(() => {
    let targets: string[];
    try {
      targets = [
        sessionsRoot,
        ...readdirSync(sessionsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(sessionsRoot, entry.name)),
      ];
    } catch {
      return; // sessions root gone (teardown in flight) — nothing to kick
    }
    for (const dir of targets) {
      const sentinel = join(dir, '.fs-kick');
      try {
        writeFileSync(sentinel, '');
        unlinkSync(sentinel);
      } catch {
        // best effort — a bucket can disappear mid-tick
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

type LeasePayload = Record<string, unknown>;

/** Read diagnostic owner metadata; undefined when no holder has published it. */
async function readLease(home: string, sessionId: string): Promise<LeasePayload | undefined> {
  try {
    return JSON.parse(
      await readFile(`${sessionLeasePath(home, sessionId)}.owner.json`, 'utf8'),
    ) as LeasePayload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function listLeaseFilenames(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, 'session-leases'))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Byte-level integrity sweep: every non-empty line of every `*.jsonl` under
 * `root` must parse as one complete JSON record — a torn / interleaved write
 * from a double-materialized session shows up here as a parse failure.
 */
async function assertJsonlIntegrity(root: string): Promise<{ files: number; records: number }> {
  const files = await listJsonlFiles(root);
  const violations: string[] = [];
  let records = 0;
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    content.split('\n').forEach((line, index) => {
      if (line.trim().length === 0) return;
      try {
        JSON.parse(line);
        records += 1;
      } catch {
        violations.push(`${file}:${index + 1} :: ${line.slice(0, 120)}`);
      }
    });
  }
  expect(violations).toEqual([]);
  return { files: files.length, records };
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True once `pid` is fully gone (ESRCH — zombies reaped), false on timeout. */
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return !pidAlive(pid);
}

/** Probe returning undefined ⇒ keep polling; any other value ends the wait. */
async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  description: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out (${timeoutMs}ms) waiting for: ${description}`, {
        cause: lastError,
      });
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
