/**
 * Unit tests for {@link AcpKaos}. Uses a hand-rolled mock of
 * {@link AgentSideConnection} that records calls and lets each test
 * stub `readTextFile` / `writeTextFile` independently — much cheaper
 * than spinning up the full ndjson pipe for the per-method assertions
 * (we already have an end-to-end test in `e2e-fs.test.ts` for the wire
 * round-trip).
 */

import type {
  AgentSideConnection,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { KaosError, type Environment, type Kaos, type KaosProcess, type StatResult } from '@moonshot-ai/kaos';
import { describe, expect, it } from 'vitest';

import { AcpKaos } from '../src/kaos-acp';

interface MockConn {
  readCalls: ReadTextFileRequest[];
  writeCalls: WriteTextFileRequest[];
  readHandler: (req: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  writeHandler: (req: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
  asConn(): AgentSideConnection;
}

function makeMockConn(opts: {
  readHandler?: (req: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  writeHandler?: (req: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
}): MockConn {
  const readCalls: ReadTextFileRequest[] = [];
  const writeCalls: WriteTextFileRequest[] = [];
  const readHandler =
    opts.readHandler ?? (async () => ({ content: '' } as ReadTextFileResponse));
  const writeHandler =
    opts.writeHandler ?? (async () => ({} as WriteTextFileResponse));
  const conn = {
    readTextFile: async (req: ReadTextFileRequest) => {
      readCalls.push(req);
      return readHandler(req);
    },
    writeTextFile: async (req: WriteTextFileRequest) => {
      writeCalls.push(req);
      return writeHandler(req);
    },
  } as unknown as AgentSideConnection;
  return {
    readCalls,
    writeCalls,
    readHandler,
    writeHandler,
    asConn: () => conn,
  };
}

/**
 * Minimal stub of an inner {@link Kaos}. Records delegation; throws if
 * a non-pass-through method is called (defensive — those should never
 * land here in the bridging layer).
 */
interface MockInnerKaos extends Kaos {
  __spy: {
    pathClassCalls: number;
    normpathCalls: string[];
    gethomeCalls: number;
    getcwdCalls: number;
    chdirCalls: string[];
    withCwdCalls: string[];
    statCalls: Array<{ path: string; options?: { followSymlinks?: boolean } }>;
    iterdirCalls: string[];
    globCalls: Array<{ path: string; pattern: string; options?: { caseSensitive?: boolean } }>;
    mkdirCalls: Array<{ path: string; options?: { parents?: boolean; existOk?: boolean } }>;
    execCalls: string[][];
    execWithEnvCalls: Array<{ args: string[]; env?: Record<string, string> }>;
    readTextCalls: string[];
    writeTextCalls: Array<{ path: string; data: string }>;
  };
}

function makeMockInner(): MockInnerKaos {
  const spy = {
    pathClassCalls: 0,
    normpathCalls: [] as string[],
    gethomeCalls: 0,
    getcwdCalls: 0,
    chdirCalls: [] as string[],
    withCwdCalls: [] as string[],
    statCalls: [] as Array<{ path: string; options?: { followSymlinks?: boolean } }>,
    iterdirCalls: [] as string[],
    globCalls: [] as Array<{ path: string; pattern: string; options?: { caseSensitive?: boolean } }>,
    mkdirCalls: [] as Array<{ path: string; options?: { parents?: boolean; existOk?: boolean } }>,
    execCalls: [] as string[][],
    execWithEnvCalls: [] as Array<{ args: string[]; env?: Record<string, string> }>,
    readTextCalls: [] as string[],
    writeTextCalls: [] as Array<{ path: string; data: string }>,
  };

  const inner: MockInnerKaos = {
    __spy: spy,
    name: 'mock-inner',
    osEnv: { os: 'linux', shell: 'bash' } as unknown as Environment,
    pathClass: () => {
      spy.pathClassCalls += 1;
      return 'posix';
    },
    normpath: (p: string) => {
      spy.normpathCalls.push(p);
      return p;
    },
    gethome: () => {
      spy.gethomeCalls += 1;
      return '/home/mock';
    },
    getcwd: () => {
      spy.getcwdCalls += 1;
      return '/cwd';
    },
    chdir: async (p: string) => {
      spy.chdirCalls.push(p);
    },
    withCwd: (cwd: string) => {
      spy.withCwdCalls.push(cwd);
      // Return a fresh inner stub so the wrapper test can verify the
      // returned AcpKaos still bridges through the same conn.
      const child = makeMockInner();
      return child;
    },
    stat: async (path: string, options?: { followSymlinks?: boolean }) => {
      spy.statCalls.push({ path, options });
      return {
        stMode: 0o100644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 0,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      } as StatResult;
    },
    // eslint-disable-next-line require-yield
    iterdir: async function* (path: string) {
      spy.iterdirCalls.push(path);
    },
    // eslint-disable-next-line require-yield
    glob: async function* (
      path: string,
      pattern: string,
      options?: { caseSensitive?: boolean },
    ) {
      spy.globCalls.push({ path, pattern, options });
    },
    mkdir: async (path: string, options?: { parents?: boolean; existOk?: boolean }) => {
      spy.mkdirCalls.push({ path, options });
    },
    exec: async (...args: string[]) => {
      spy.execCalls.push(args);
      return {} as KaosProcess;
    },
    execWithEnv: async (args: string[], env?: Record<string, string>) => {
      spy.execWithEnvCalls.push({ args, env });
      return {} as KaosProcess;
    },
    readBytes: async () => Buffer.alloc(0),
    readText: async (path: string) => {
      // Used to verify that AcpKaos.readText does NOT fall back to inner.
      spy.readTextCalls.push(path);
      return 'INNER';
    },
    readLines: async function* () {},
    writeBytes: async () => 0,
    writeText: async (path: string, data: string) => {
      spy.writeTextCalls.push({ path, data });
      return data.length;
    },
  };
  return inner;
}

describe('AcpKaos', () => {
  describe('readText', () => {
    it('forwards path and sessionId to conn.readTextFile, returning response.content', async () => {
      const conn = makeMockConn({
        readHandler: async () => ({ content: 'HELLO' }),
      });
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);

      const result = await kaos.readText('/a.ts');

      expect(result).toBe('HELLO');
      expect(conn.readCalls).toEqual([{ sessionId: 's1', path: '/a.ts' }]);
      // Crucially: inner.readText must NOT be called — we bridge through ACP.
      expect(inner.__spy.readTextCalls).toEqual([]);
    });

    it('wraps RPC errors in KaosError with cause set', async () => {
      const rpcErr = new Error('rpc died');
      const conn = makeMockConn({
        readHandler: async () => {
          throw rpcErr;
        },
      });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());

      await expect(kaos.readText('/x.ts')).rejects.toMatchObject({
        name: 'KaosError',
      });
      await expect(kaos.readText('/x.ts')).rejects.toBeInstanceOf(KaosError);
      // Verify cause is preserved.
      try {
        await kaos.readText('/x.ts');
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as Error & { cause?: unknown }).cause).toBe(rpcErr);
        expect((err as Error).message).toContain('acp: readTextFile failed for /x.ts');
        expect((err as Error).message).toContain('rpc died');
      }
    });
  });

  describe('readBytes', () => {
    it('returns the first N utf8 bytes of the file content', async () => {
      const conn = makeMockConn({
        readHandler: async () => ({ content: 'abcdef' }),
      });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());

      const buf = await kaos.readBytes('/a.ts', 3);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.toString('utf8')).toBe('abc');
    });

    it('returns the full buffer when n is omitted', async () => {
      const conn = makeMockConn({
        readHandler: async () => ({ content: 'abcdef' }),
      });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());

      const buf = await kaos.readBytes('/a.ts');
      expect(buf.toString('utf8')).toBe('abcdef');
    });
  });

  describe('readLines', () => {
    async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
      const out: string[] = [];
      for await (const line of gen) out.push(line);
      return out;
    }

    it('yields each line of "a\\nb\\nc"', async () => {
      const conn = makeMockConn({ readHandler: async () => ({ content: 'a\nb\nc' }) });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      expect(await collect(kaos.readLines('/a.ts'))).toEqual(['a', 'b', 'c']);
    });

    it('drops the trailing empty token when the file ends with a newline', async () => {
      // "a\nb\n" → ['a', 'b'] (NOT ['a', 'b', ''])
      const conn = makeMockConn({ readHandler: async () => ({ content: 'a\nb\n' }) });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      expect(await collect(kaos.readLines('/a.ts'))).toEqual(['a', 'b']);
    });

    it('yields the final line without a trailing newline', async () => {
      const conn = makeMockConn({ readHandler: async () => ({ content: 'a\nb' }) });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      expect(await collect(kaos.readLines('/a.ts'))).toEqual(['a', 'b']);
    });

    it('yields nothing for an empty file', async () => {
      const conn = makeMockConn({ readHandler: async () => ({ content: '' }) });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      expect(await collect(kaos.readLines('/a.ts'))).toEqual([]);
    });
  });

  describe('writeText', () => {
    it('forwards content to conn.writeTextFile and returns char count', async () => {
      const conn = makeMockConn({});
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      const n = await kaos.writeText('/a.ts', 'hello');
      expect(n).toBe(5);
      expect(conn.writeCalls).toEqual([{ sessionId: 's1', path: '/a.ts', content: 'hello' }]);
    });

    it('append mode merges with existing content', async () => {
      const conn = makeMockConn({
        readHandler: async () => ({ content: 'old:' }),
      });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      const n = await kaos.writeText('/a.ts', 'new', { mode: 'a' });
      // Return value is the size of the appended data, not the merged size.
      expect(n).toBe(3);
      // First a read, then a write with the merged content.
      expect(conn.readCalls).toEqual([{ sessionId: 's1', path: '/a.ts' }]);
      expect(conn.writeCalls).toEqual([
        { sessionId: 's1', path: '/a.ts', content: 'old:new' },
      ]);
    });

    it('append mode treats a missing file (read error) as empty existing content', async () => {
      const conn = makeMockConn({
        readHandler: async () => {
          throw new Error('ENOENT');
        },
      });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      const n = await kaos.writeText('/missing.ts', 'fresh', { mode: 'a' });
      expect(n).toBe(5);
      expect(conn.writeCalls).toEqual([
        { sessionId: 's1', path: '/missing.ts', content: 'fresh' },
      ]);
    });

    it('wraps writeTextFile RPC errors in KaosError with cause set', async () => {
      const rpcErr = new Error('write rpc died');
      const conn = makeMockConn({
        writeHandler: async () => {
          throw rpcErr;
        },
      });
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());

      await expect(kaos.writeText('/a.ts', 'hello')).rejects.toBeInstanceOf(KaosError);
      try {
        await kaos.writeText('/a.ts', 'hello');
      } catch (err) {
        expect((err as Error & { cause?: unknown }).cause).toBe(rpcErr);
        expect((err as Error).message).toContain('acp: writeTextFile failed for /a.ts');
        expect((err as Error).message).toContain('write rpc died');
      }
    });
  });

  describe('writeBytes', () => {
    it('forwards utf8-decoded content via conn.writeTextFile, returns byte count', async () => {
      const conn = makeMockConn({});
      const kaos = new AcpKaos(conn.asConn(), 's1', makeMockInner());
      const n = await kaos.writeBytes('/a.ts', Buffer.from('hi'));
      expect(n).toBe(2);
      expect(conn.writeCalls).toEqual([{ sessionId: 's1', path: '/a.ts', content: 'hi' }]);
    });
  });

  describe('withCwd', () => {
    it('returns an AcpKaos that still bridges through the same conn', async () => {
      const conn = makeMockConn({
        readHandler: async () => ({ content: 'BRIDGED' }),
      });
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);
      const child = kaos.withCwd('/new/cwd');

      expect(child).toBeInstanceOf(AcpKaos);
      // Reading on the wrapped child must still hit the mocked ACP conn,
      // NOT the inner Kaos's local readText.
      const text = await child.readText('/foo.ts');
      expect(text).toBe('BRIDGED');
      expect(conn.readCalls).toEqual([{ sessionId: 's1', path: '/foo.ts' }]);
      expect(inner.__spy.withCwdCalls).toEqual(['/new/cwd']);
    });
  });

  describe('pass-through delegation', () => {
    it('delegates pathClass, normpath, gethome, getcwd to inner', () => {
      const conn = makeMockConn({});
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);

      expect(kaos.pathClass()).toBe('posix');
      expect(kaos.normpath('/foo')).toBe('/foo');
      expect(kaos.gethome()).toBe('/home/mock');
      expect(kaos.getcwd()).toBe('/cwd');

      expect(inner.__spy.pathClassCalls).toBe(1);
      expect(inner.__spy.normpathCalls).toEqual(['/foo']);
      expect(inner.__spy.gethomeCalls).toBe(1);
      expect(inner.__spy.getcwdCalls).toBe(1);
    });

    it('delegates chdir, stat, mkdir to inner', async () => {
      const conn = makeMockConn({});
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);

      await kaos.chdir('/x');
      await kaos.stat('/y', { followSymlinks: false });
      await kaos.mkdir('/z', { parents: true });

      expect(inner.__spy.chdirCalls).toEqual(['/x']);
      expect(inner.__spy.statCalls).toEqual([{ path: '/y', options: { followSymlinks: false } }]);
      expect(inner.__spy.mkdirCalls).toEqual([{ path: '/z', options: { parents: true } }]);
    });

    it('delegates iterdir and glob to inner', async () => {
      const conn = makeMockConn({});
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);

      // Just consume the generators — the inner spy records the call.
      for await (const _ of kaos.iterdir('/d')) {
        // no-op
      }
      for await (const _ of kaos.glob('/d', '**/*.ts', { caseSensitive: true })) {
        // no-op
      }

      expect(inner.__spy.iterdirCalls).toEqual(['/d']);
      expect(inner.__spy.globCalls).toEqual([
        { path: '/d', pattern: '**/*.ts', options: { caseSensitive: true } },
      ]);
    });

    it('delegates exec and execWithEnv to inner', async () => {
      const conn = makeMockConn({});
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);

      await kaos.exec('ls', '-la');
      await kaos.execWithEnv(['env'], { FOO: 'bar' });

      expect(inner.__spy.execCalls).toEqual([['ls', '-la']]);
      expect(inner.__spy.execWithEnvCalls).toEqual([{ args: ['env'], env: { FOO: 'bar' } }]);
    });
  });

  describe('identity', () => {
    it('exposes a wrapping name and the inner osEnv', () => {
      const conn = makeMockConn({});
      const inner = makeMockInner();
      const kaos = new AcpKaos(conn.asConn(), 's1', inner);
      expect(kaos.name).toBe('acp(mock-inner)');
      expect(kaos.osEnv).toBe(inner.osEnv);
    });
  });
});
