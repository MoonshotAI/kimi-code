/**
 * Integration tests: {@link AcpKaos} enforces `[cwd, ...additionalDirectories]`
 * as the effective root set on every file operation.
 *
 * The boundary guarantee is the security-bearing layer of Phase 17.
 * Without it, the `additionalDirectories` capability is purely
 * advisory — an agent that wanted to `Read /etc/passwd` could bypass
 * the client's trust boundary by calling `readText('/etc/passwd')`
 * and the bridge would happily forward it. These tests use real
 * filesystem roots (mkdtemp + symlinks) and a `mock conn` that fails
 * the test if reached before the boundary check, so a regression to
 * "no boundary check" surfaces as a clear failure rather than a
 * silent leak.
 */

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { KaosError, type Environment, type Kaos, type KaosProcess, type StatResult } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpKaos } from '../src/kaos-acp';
import { resolveCanonicalRoots } from '../src/path-boundary';

let cwdRoot: string;
let extraRoot: string;

beforeEach(async () => {
  cwdRoot = await fsp.mkdtemp(path.join(tmpdir(), 'acp-kaos-cwd-'));
  extraRoot = await fsp.mkdtemp(path.join(tmpdir(), 'acp-kaos-extra-'));
});

afterEach(async () => {
  await fsp.rm(cwdRoot, { recursive: true, force: true });
  await fsp.rm(extraRoot, { recursive: true, force: true });
});

/**
 * Connection mock whose every RPC call is recorded AND returns dummy
 * content (instead of throwing). Tests assert `rpcCalls.readTextFile`
 * is empty after a boundary-violation attempt: a non-zero count means
 * the boundary check fired AFTER the RPC was made, which is the
 * regression we want to catch.
 */
function makeRecordingConn(): {
  conn: AgentSideConnection;
  rpcCalls: { readTextFile: number; writeTextFile: number };
} {
  const rpcCalls = { readTextFile: 0, writeTextFile: 0 };
  return {
    rpcCalls,
    conn: {
      readTextFile: vi.fn(async () => {
        rpcCalls.readTextFile += 1;
        return { content: '' };
      }),
      writeTextFile: vi.fn(async () => {
        rpcCalls.writeTextFile += 1;
        return {};
      }),
    } as unknown as AgentSideConnection,
  };
}

/** Minimal inner Kaos that never delegates (tests don't exercise it). */
function makeInner(): Kaos {
  return {
    name: 'mock-inner',
    osEnv: { os: 'linux', shell: 'bash' } as unknown as Environment,
    pathClass: () => 'posix',
    normpath: (p: string) => p,
    gethome: () => '/home/mock',
    getcwd: () => '/cwd',
    chdir: async () => undefined,
    withCwd: () => makeInner(),
    withEnv: () => makeInner(),
    stat: async () => ({}) as StatResult,
    iterdir: async function* () {
      yield* [];
    },
    glob: async function* () {
      yield* [];
    },
    mkdir: async () => undefined,
    exec: async () => ({}) as KaosProcess,
    execWithEnv: async () => ({}) as KaosProcess,
    readText: async () => 'INNER',
    readBytes: async () => Buffer.alloc(0),
    readLines: async function* () {
      yield* [];
    },
    writeText: async (_p: string, data: string) => data.length,
    writeBytes: async () => 0,
  } as unknown as Kaos;
}

async function makeKaos(opts?: {
  overrideConn?: { conn: AgentSideConnection; rpcCalls: { readTextFile: number; writeTextFile: number } };
}): Promise<AcpKaos> {
  const roots = await resolveCanonicalRoots([cwdRoot, extraRoot]);
  const recording = opts?.overrideConn ?? makeRecordingConn();
  return new AcpKaos(recording.conn, 'session-test', makeInner(), roots);
}

describe('AcpKaos — boundary enforcement', () => {
  it('readText outside roots throws KaosError and never reaches the conn', async () => {
    const recording = makeRecordingConn();
    const kaos = await makeKaos({ overrideConn: recording });
    await expect(kaos.readText('/etc/passwd')).rejects.toBeInstanceOf(KaosError);
    expect(recording.rpcCalls.readTextFile).toBe(0);
  });

  it('readText via symlink escape inside cwd throws KaosError and never reaches the conn', async () => {
    const outside = await fsp.mkdtemp(path.join(tmpdir(), 'acp-kaos-out-'));
    try {
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
      await fsp.symlink(outside, path.join(cwdRoot, 'escape'), 'dir');
      const recording = makeRecordingConn();
      const kaos = await makeKaos({ overrideConn: recording });
      await expect(kaos.readText(path.join(cwdRoot, 'escape', 'secret.txt'))).rejects.toBeInstanceOf(
        KaosError,
      );
      expect(recording.rpcCalls.readTextFile).toBe(0);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('readText inside cwd delegates to the conn (no boundary violation)', async () => {
    const roots = await resolveCanonicalRoots([cwdRoot]);
    const target = path.join(cwdRoot, 'plain.txt');
    await fsp.writeFile(target, 'hi');
    const conn = {
      readTextFile: vi.fn(async () => ({ content: 'from-rpc' })),
      writeTextFile: vi.fn(),
    } as unknown as AgentSideConnection;
    const kaos = new AcpKaos(conn, 'session-test', makeInner(), roots);
    const out = await kaos.readText(target);
    expect(out).toBe('from-rpc');
    expect(conn.readTextFile).toHaveBeenCalledOnce();
  });

  it('readText inside an additionalDirectories root delegates to the conn', async () => {
    const target = path.join(extraRoot, 'lib.ts');
    await fsp.writeFile(target, 'export {};');
    const roots = await resolveCanonicalRoots([cwdRoot, extraRoot]);
    const conn = {
      readTextFile: vi.fn(async () => ({ content: 'from-rpc' })),
      writeTextFile: vi.fn(),
    } as unknown as AgentSideConnection;
    const kaos = new AcpKaos(conn, 'session-test', makeInner(), roots);
    const out = await kaos.readText(target);
    expect(out).toBe('from-rpc');
  });

  it('writeText outside roots throws KaosError', async () => {
    const recording = makeRecordingConn();
    const kaos = await makeKaos({ overrideConn: recording });
    await expect(kaos.writeText('/tmp/acp-kaos-should-not-exist.txt', 'x')).rejects.toBeInstanceOf(
      KaosError,
    );
    expect(recording.rpcCalls.writeTextFile).toBe(0);
  });

  it('writeText to a non-existent path whose parent symlink-escapes throws', async () => {
    const outside = await fsp.mkdtemp(path.join(tmpdir(), 'acp-kaos-out-'));
    try {
      await fsp.symlink(outside, path.join(cwdRoot, 'esc'), 'dir');
      const recording = makeRecordingConn();
      const kaos = await makeKaos({ overrideConn: recording });
      await expect(
        kaos.writeText(path.join(cwdRoot, 'esc', 'new.txt'), 'x'),
      ).rejects.toBeInstanceOf(KaosError);
      // RPC non-reach proof: the boundary check fires BEFORE writeTextFile.
      expect(recording.rpcCalls.writeTextFile).toBe(0);
      // And: nothing got written to the escape target either.
      const targetExists = await fsp
        .stat(path.join(outside, 'new.txt'))
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(false);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('readBytes outside roots throws KaosError (no longer bypasses via inner)', async () => {
    const kaos = await makeKaos();
    await expect(kaos.readBytes('/etc/passwd')).rejects.toBeInstanceOf(KaosError);
  });

  it('stat outside roots throws KaosError', async () => {
    const kaos = await makeKaos();
    await expect(kaos.stat('/etc/passwd')).rejects.toBeInstanceOf(KaosError);
  });

  it('iterdir outside roots throws KaosError', async () => {
    const kaos = await makeKaos();
    // iterdir returns an async iterator; we have to start consuming
    // before the throw surfaces.
    await expect((async () => {
      for await (const _ of kaos.iterdir('/etc')) {
        // drain
      }
    })()).rejects.toBeInstanceOf(KaosError);
  });

  it('glob outside roots throws KaosError', async () => {
    const kaos = await makeKaos();
    await expect((async () => {
      for await (const _ of kaos.glob('/etc', '*')) {
        // drain
      }
    })()).rejects.toBeInstanceOf(KaosError);
  });

  it('mkdir outside roots throws KaosError', async () => {
    const kaos = await makeKaos();
    await expect(kaos.mkdir('/tmp/acp-kaos-mkdir')).rejects.toBeInstanceOf(KaosError);
  });

  it('withCwd preserves the effective roots across the wrapper', async () => {
    const kaos = await makeKaos();
    const child = kaos.withCwd('/somewhere/else') as AcpKaos;
    // The child shares roots — even though the bound cwd has moved,
    // a path under `/etc` is still rejected because `/etc` isn't in
    // the session's effective root set.
    await expect(child.readText('/etc/passwd')).rejects.toBeInstanceOf(KaosError);
  });
});
