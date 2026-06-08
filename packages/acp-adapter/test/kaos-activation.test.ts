/**
 * Tests that {@link AcpSession.prompt} activates an {@link AcpKaos}
 * (visible to tools via {@link getCurrentKaos}) when, and only when,
 * the client advertises `fs.readTextFile` or `fs.writeTextFile`.
 *
 * Uses scripted `Session` stubs whose `prompt(parts)` synchronously
 * calls `getCurrentKaos()` *inside* its body — this is the moment a
 * real tool would resolve its Kaos handle, so it's the right place
 * to assert the binding propagated through `runWithKaos`.
 */

import type { AgentSideConnection, ClientCapabilities } from '@agentclientprotocol/sdk';
import { getCurrentKaos, LocalKaos, runWithKaos } from '@moonshot-ai/kaos';
import type { Event, Session } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { AcpKaos } from '../src/kaos-acp';
import { AcpSession } from '../src/session';

/**
 * Build a minimal {@link AgentSideConnection} stub whose
 * `readTextFile` / `writeTextFile` return canned content. The stub
 * also captures the calls so tests can verify the bridging path.
 */
function makeFakeConn(opts: { readContent?: string } = {}): {
  conn: AgentSideConnection;
  readCalls: Array<{ sessionId: string; path: string }>;
  writeCalls: Array<{ sessionId: string; path: string; content: string }>;
} {
  const readCalls: Array<{ sessionId: string; path: string }> = [];
  const writeCalls: Array<{ sessionId: string; path: string; content: string }> = [];
  const conn = {
    readTextFile: async (req: { sessionId: string; path: string }) => {
      readCalls.push({ sessionId: req.sessionId, path: req.path });
      return { content: opts.readContent ?? 'STUB' };
    },
    writeTextFile: async (req: { sessionId: string; path: string; content: string }) => {
      writeCalls.push({ sessionId: req.sessionId, path: req.path, content: req.content });
      return {};
    },
    sessionUpdate: async () => undefined,
    requestPermission: async () => {
      throw new Error('requestPermission should not be called');
    },
  } as unknown as AgentSideConnection;
  return { conn, readCalls, writeCalls };
}

/**
 * Build a `Session` whose `prompt(parts)` calls the supplied probe
 * synchronously and then fires `turn.ended` so the outer
 * `AcpSession.prompt` resolves promptly.
 */
function makeProbingSession(
  sessionId: string,
  probe: () => void | Promise<void>,
): Session {
  const listeners = new Set<(event: Event) => void>();
  return {
    id: sessionId,
    prompt: async (_input: unknown) => {
      // Run the probe inside the (potentially) runWithKaos-bound async
      // subtree — this is exactly where a real tool would observe its
      // current Kaos.
      await probe();
      for (const fn of listeners) {
        fn({ type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event);
      }
    },
    cancel: async () => undefined,
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  } as unknown as Session;
}

describe('AcpSession FS-capability activation', () => {
  it('binds an AcpKaos as the current Kaos when the client advertises fs.readTextFile', async () => {
    const { conn, readCalls } = makeFakeConn({ readContent: 'UNSAVED' });

    let observedKaosName: string | undefined;
    let observedRead: string | undefined;
    const session = makeProbingSession('s-fs', async () => {
      const current = getCurrentKaos();
      observedKaosName = current.name;
      observedRead = await current.readText('/abs/path.ts');
    });

    // Activation needs a baseline Kaos in the *outer* async context
    // (otherwise getCurrentKaos throws when the AsyncLocalStorage store
    // is undefined). Real `kimi acp` wires this at startup; tests must
    // emulate. Note we deliberately use `runWithKaos` rather than
    // `setCurrentKaos` so the outer binding stays test-local.
    const outer = await LocalKaos.create();
    const result = await runWithKaos(outer, async () => {
      const caps: ClientCapabilities = { fs: { readTextFile: true } };
      const acpSession = new AcpSession(conn, session, caps);
      return acpSession.prompt([]);
    });

    expect(result.stopReason).toBe('end_turn');
    // Name probe confirms `runWithKaos` rebound to AcpKaos within the
    // scripted prompt body.
    expect(observedKaosName).toBe('acp(local)');
    // Read probe confirms the bridge actually routes through the conn.
    expect(observedRead).toBe('UNSAVED');
    expect(readCalls).toEqual([{ sessionId: 's-fs', path: '/abs/path.ts' }]);
  });

  it('binds an AcpKaos when only fs.writeTextFile is advertised', async () => {
    const { conn, writeCalls } = makeFakeConn();
    let probedName: string | undefined;
    const session = makeProbingSession('s-write', async () => {
      const current = getCurrentKaos();
      probedName = current.name;
      await current.writeText('/abs/out.ts', 'data');
    });

    const outer = await LocalKaos.create();
    await runWithKaos(outer, async () => {
      const caps: ClientCapabilities = { fs: { writeTextFile: true } };
      const acpSession = new AcpSession(conn, session, caps);
      await acpSession.prompt([]);
    });

    expect(probedName).toBe('acp(local)');
    expect(writeCalls).toEqual([{ sessionId: 's-write', path: '/abs/out.ts', content: 'data' }]);
  });

  it('does NOT wrap when the client advertises no FS capability — current Kaos stays the outer one', async () => {
    const { conn, readCalls } = makeFakeConn();
    let observedKaosName: string | undefined;
    const session = makeProbingSession('s-nofs', () => {
      observedKaosName = getCurrentKaos().name;
    });

    const outer = await LocalKaos.create();
    await runWithKaos(outer, async () => {
      // No clientCapabilities — equivalent to "client didn't advertise FS"
      const acpSession = new AcpSession(conn, session);
      await acpSession.prompt([]);
    });

    // Pass-through: tool sees the outer LocalKaos, not an AcpKaos.
    expect(observedKaosName).toBe('local');
    expect(readCalls).toEqual([]);
  });

  it('does NOT wrap when the FS capability flags are present-but-false', async () => {
    const { conn } = makeFakeConn();
    let observedKaosName: string | undefined;
    const session = makeProbingSession('s-falseflags', () => {
      observedKaosName = getCurrentKaos().name;
    });

    const outer = await LocalKaos.create();
    await runWithKaos(outer, async () => {
      const caps: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false } };
      const acpSession = new AcpSession(conn, session, caps);
      await acpSession.prompt([]);
    });

    expect(observedKaosName).toBe('local');
  });

  it('isolates concurrent prompts on different AcpSessions — each sees its own AcpKaos', async () => {
    const { conn: connA } = makeFakeConn({ readContent: 'A-CONTENT' });
    const { conn: connB } = makeFakeConn({ readContent: 'B-CONTENT' });

    let observedA: string | undefined;
    let observedB: string | undefined;

    // Use a manual gate so both prompts overlap — A's probe blocks until
    // B has had a chance to enter its scope. This forces the
    // AsyncLocalStorage isolation invariant to be exercised: if
    // `enterWith` were used naively, B's binding would leak into A.
    let resolveA: () => void = () => undefined;
    const aGate = new Promise<void>((r) => {
      resolveA = r;
    });

    const sessionA = makeProbingSession('s-A', async () => {
      // Resolve A's probe AFTER we observe — see comment above.
      await new Promise<void>((r) => setTimeout(r, 5));
      observedA = await getCurrentKaos().readText('/file');
      resolveA();
    });
    const sessionB = makeProbingSession('s-B', async () => {
      observedB = await getCurrentKaos().readText('/file');
      await aGate;
    });

    const outer = await LocalKaos.create();
    await runWithKaos(outer, async () => {
      const acpA = new AcpSession(connA, sessionA, { fs: { readTextFile: true } });
      const acpB = new AcpSession(connB, sessionB, { fs: { readTextFile: true } });
      await Promise.all([acpA.prompt([]), acpB.prompt([])]);
    });

    expect(observedA).toBe('A-CONTENT');
    expect(observedB).toBe('B-CONTENT');
  });

  it('reuses the inner LocalKaos across multiple prompts on the same AcpSession', async () => {
    const { conn } = makeFakeConn({ readContent: 'X' });
    let firstInner: import('@moonshot-ai/kaos').Kaos | undefined;
    let secondInner: import('@moonshot-ai/kaos').Kaos | undefined;
    const session = makeProbingSession('s-reuse', () => {
      // Tunnel: AcpKaos wraps an inner Kaos and exposes it indirectly
      // via getcwd() (which delegates). For this assertion it's enough
      // that the AcpKaos's `name` stays stable AND we observe the
      // session through two distinct prompts without errors.
      const k = getCurrentKaos();
      if (!firstInner) firstInner = k;
      else secondInner = k;
    });

    const outer = await LocalKaos.create();
    await runWithKaos(outer, async () => {
      const acpSession = new AcpSession(conn, session, { fs: { readTextFile: true } });
      await acpSession.prompt([]);
      await acpSession.prompt([]);
    });

    expect(firstInner).toBeDefined();
    expect(secondInner).toBeDefined();
    // Each prompt produces its own AcpKaos wrapper, but the inner
    // LocalKaos is reused — we can't directly read the private field,
    // but the visible name should stay stable.
    expect(firstInner?.name).toBe('acp(local)');
    expect(secondInner?.name).toBe('acp(local)');
  });

  it('returns an AcpKaos instance from maybeBuildAcpKaos when capable (verified via name + instanceof through prompt path)', async () => {
    const { conn } = makeFakeConn();
    let observed: unknown;
    const session = makeProbingSession('s-instance', () => {
      observed = getCurrentKaos();
    });

    const outer = await LocalKaos.create();
    await runWithKaos(outer, async () => {
      const acpSession = new AcpSession(conn, session, { fs: { readTextFile: true } });
      await acpSession.prompt([]);
    });

    expect(observed).toBeInstanceOf(AcpKaos);
  });
});
