import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KimiError } from '../../src/errors';
import { mergeStdioEnv, resolveStdioCwd, StdioMcpClient } from '../../src/mcp/client-stdio';

const here = import.meta.dirname;
const fixture = join(here, 'fixtures', 'mock-stdio-server.mjs');
const cwdFixture = join(here, 'fixtures', 'cwd-stdio-server.mjs');
const stderrThenExitFixture = join(here, 'fixtures', 'stderr-then-exit-stdio-server.mjs');
const crashAfterConnectFixture = join(here, 'fixtures', 'crash-after-connect-stdio-server.mjs');

describe('stdio MCP working directory resolution', () => {
  it('preserves the UNC share when resolving a relative server cwd', () => {
    expect(
      resolveStdioCwd('tools/mcp server', '\\\\Server\\Share\\Workspace'),
    ).toBe('//Server/Share/Workspace/tools/mcp server');
  });

  it('normalizes a drive path containing spaces and non-ASCII segments', () => {
    expect(
      resolveStdioCwd('工具\\server', 'C:\\Users\\Example User\\项目'),
    ).toBe('C:/Users/Example User/项目/工具/server');
  });
});

/**
 * Errors that prove the transport close was fully processed: once the SDK's
 * `_onclose` ran, new requests are rejected with 'Not connected' and pending
 * ones with 'Connection closed'. Anything else (e.g. EPIPE from a racy stdin
 * write) can fire before the child's exit is observed and is not proof of
 * death.
 */
function isPostCloseTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Not connected') || message.includes('Connection closed');
}

describe('StdioMcpClient', () => {
  it('rejects unsupported executor at construction time', () => {
    expect(
      () =>
        new StdioMcpClient({
          transport: 'stdio',
          command: 'true',
          executor: 'kaos',
        }),
    ).toThrow(
      expect.objectContaining({ name: 'KimiError', code: 'not_implemented' }) as unknown as Error,
    );
    // Sanity-check the error class identity too.
    let thrown: unknown;
    try {
      const client = new StdioMcpClient({ transport: 'stdio', command: 'true', executor: 'kaos' });
      void client;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KimiError);
  });

  it('uses defaultCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdFixture],
      },
      { defaultCwd: cwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('prefers explicit config.cwd over defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const configuredCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-configured-cwd-'));
    const client = new StdioMcpClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdFixture],
        cwd: configuredCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(configuredCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(['boom', 'echo', 'read_env']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { KIMI_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'KIMI_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('inherits parent process env so PATH/HOME survive; config.env overrides on conflict', async () => {
    const parentOnly = `KIMI_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `KIMI_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `kimi-test-stderr-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { KIMI_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      // Even when connect fails, the buffered stderr must be retrievable so
      // higher layers can include it in the user-facing error message.
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    try {
      await client.connect();
      // Confirm the buffer cap is documented and finite (4 KB is plenty for a
      // useful tail). The exact value is an implementation detail but
      // exposing it for tests prevents unbounded growth from regressing.
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `kimi-test-crash-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '500', KIMI_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ stderr: reason.stderr, error: reason.error?.message });
    });
    try {
      await client.connect();
      // Wait for the child to exit and onclose to fire.
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `kimi-test-early-${Date.now()}`;
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_STDERR: banner, KIMI_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      // Drive the child to exit AFTER a successful tool response. The fixture
      // schedules `process.exit` via setImmediate so the reply is fully
      // flushed before the pipe closes; this exercises the post-handshake
      // disconnect path with no startup-timing race.
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      // Wait deterministically for the child to actually exit. The fixture
      // flushes `banner\n` to stderr before calling `process.exit`, so
      // observing the banner is proof the exit syscall has been issued.
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);
      // Drain probe: keep probing until a request fails with an error that is
      // only possible AFTER the transport close was fully processed — the
      // SDK's `_onclose` synchronously invokes our `onclose` hook (buffering
      // `pendingUnexpectedClose`) before any rejection can reach this loop.
      // A plain stdin write error (e.g. EPIPE) can win the race against the
      // child's exit notification and says nothing about close processing, so
      // it must not end the loop. This is what gives us a buffer to replay —
      // registering the listener first would intercept the close as a live
      // fire instead.
      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch (error) {
          if (isPostCloseTransportError(error)) {
            transportConfirmedDead = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);
      // `pendingUnexpectedClose` is set; registering the listener must
      // invoke it synchronously inside the call. The replayed reason's
      // `stderr` is a snapshot taken at close time, which can race the
      // delivery of the child's final stderr chunk, so its content is not
      // asserted here — the tail itself is covered by the `stderrSnapshot`
      // assertion above.
      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onUnexpectedClose((reason) => {
        syncedOnRegister = true;
        received = { stderr: reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received).toBeDefined();
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = new StdioMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    // Give any pending onclose listener a chance to fire so we are sure it is
    // suppressed and not merely racing.
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);
});

describe('mergeStdioEnv', () => {
  it('enables NODE_USE_ENV_PROXY for a proxy set only in the server config.env', () => {
    const merged = mergeStdioEnv({ HTTP_PROXY: 'http://corp:3128' }, { PATH: '/usr/bin' });
    expect(merged['HTTP_PROXY']).toBe('http://corp:3128');
    expect(merged['NODE_USE_ENV_PROXY']).toBe('1');
    expect(merged['NO_PROXY']).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('does not inject NODE_USE_ENV_PROXY when no proxy is configured', () => {
    const merged = mergeStdioEnv(undefined, { PATH: '/usr/bin' });
    expect(merged['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('lets config.env override the parent env', () => {
    const merged = mergeStdioEnv({ FOO: 'override' }, { FOO: 'parent', PATH: '/x' });
    expect(merged['FOO']).toBe('override');
  });
});
