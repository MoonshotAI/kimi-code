/**
 * Phase-2 session-ownership verification — multi-instance e2e over real REST
 * boundaries (design §3.10).
 *
 * One session write lease per session under `<home>/session-leases/<id>.lock`.
 * The permanent sentinel is protected by a kernel lock; the sibling
 * `<id>.lock.owner.json` document only advertises holder metadata.
 * Materializing routes on a peer-held session answer HTTP 200 with envelope
 * `code 40921 session.held_by_peer` + ownership details. kap-server's own e2e
 * already pins the dual-open envelope schema and graceful-close takeover; the
 * unique value here is cross-instance behavior and byte-level file integrity:
 * A creates the session, then `GET .../warnings` fires on A and B
 * concurrently — A always serves (code 0), B always loses with 40921 phase
 * `routable` + A's address — followed by a `*.jsonl` byte-integrity sweep of
 * the shared home (no torn records) and a single-lease assertion.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionLeasePath } from '@moonshot-ai/agent-core-v2';
import { ErrorCode, sessionOwnershipDetailsSchema, type Envelope } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { startServerPair } from '../harness/testing/index.js';
import { createCaseLogger } from './log.js';

describe('session ownership: concurrent dual materialization race (in-process pair)', () => {
  it(
    'holder serves, peer gets 40921 routable every round, no torn JSONL on disk',
    { timeout: 90_000 },
    async () => {
      const log = createCaseLogger('session-ownership/materialization-race');
      const pair = await startServerPair();
      try {
        const { id: sessionId } = await pair
          .connectClient(pair.a)
          .createSession({ metadata: { cwd: pair.cwd } });
        log('session created on A', { sessionId, urlA: pair.urlA, urlB: pair.urlB });

        const lease = await readLease(pair.home, sessionId);
        log('lease after create', lease);
        expect(lease?.['address']).toBe(pair.urlA);
        const lockId = lease?.['lock_id'];
        expect(typeof lockId).toBe('string');

        // Two concurrent rounds pin the same holder/peer split as any larger
        // storm — each round is a sequential await, so more rounds only cost
        // wall time.
        const ROUNDS = 2;
        for (let round = 1; round <= ROUNDS; round += 1) {
          const [a, b] = await Promise.all([
            getEnvelope(pair.urlA, warningsPath(sessionId)),
            getEnvelope(pair.urlB, warningsPath(sessionId)),
          ]);
          expect(a.status).toBe(200);
          expect(a.body.code).toBe(0);
          expect(b.status).toBe(200);
          expect(b.body.code).toBe(ErrorCode.SESSION_HELD_BY_PEER);
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

// ── Local helpers ──────────────────────────────────────────────────────────

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
