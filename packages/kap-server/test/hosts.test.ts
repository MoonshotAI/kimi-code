import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { Duplex } from 'node:stream';
import type { OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { FileTokenStorage, KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { IBootstrapService, IConfigService, IOAuthService, IOAuthToolkit } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';
import WebSocketClient, { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';

import { HOST_API_LEVEL, HOST_PROTOCOL_VERSION } from '../src/services/hosts/hostProtocol';
import { matchHostProxyPath, proxyHostWebSocket, registerHostProxyRoutes, upstreamHeaders } from '../src/services/hosts/hostProxy';
import type { HostCredential } from '../src/services/hosts/hostAuth';
import { HostBridgeManager, sendHostCredentialUpdate } from '../src/services/hosts/hostBridgeManager';
import { hostsSectionSchema, hostWireSchema, isValidHostId } from '../src/services/hosts/hostsConfig';
import { HostRequestError, type HostHttpRequest, type HostHttpResponse, type HostSession } from '../src/services/hosts/hostSession';
import { StdioHostSession } from '../src/services/hosts/stdioHostSession';
import { JsonlRpcStream } from '../src/transport/jsonlRpcStream';
import { registerHostsRoutes } from '../src/routes/hosts';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import {
  HostConnectError,
  SshKapBridge,
  classifySshFailure,
  parseBootstrapOutput,
  parseProbeOutput,
  remoteBinCommand,
  remoteKimiCommand,
} from '../src/services/hosts/sshKapBridge';
import {
  attachRpcStream,
  HOST_RPC_MAX_BODY_BYTES,
  startUnixRpcServer,
  WS_BACKPRESSURE_TIMEOUT_MS,
} from '../src/transport/stdioRpc';

function thrown(run: () => unknown): HostConnectError {
  try {
    run();
  } catch (error) {
    if (error instanceof HostConnectError) return error;
    throw error;
  }
  throw new Error('expected a HostConnectError');
}

describe('host proxy path', () => {
  it('splits the host id from the upstream path and keeps the query', () => {
    expect(matchHostProxyPath('/api/v1/hosts/dev/proxy/api/v1/sessions?limit=1')).toEqual({
      hostId: 'dev',
      path: '/api/v1/sessions?limit=1',
    });
    expect(matchHostProxyPath('/api/v1/hosts/dev/proxy')).toEqual({ hostId: 'dev', path: '/' });
  });

  it('does not match control-plane routes', () => {
    expect(matchHostProxyPath('/api/v1/hosts')).toBeUndefined();
    expect(matchHostProxyPath('/api/v1/hosts/dev/projects')).toBeUndefined();
  });

  it('decodes the host id and rejects a malformed percent-encoding', () => {
    expect(matchHostProxyPath('/api/v1/hosts/dev%2Dbox/proxy')).toEqual({ hostId: 'dev-box', path: '/' });
    expect(matchHostProxyPath('/api/v1/hosts/%E0%A4%A/proxy')).toBeUndefined();
  });

  it('strips local credentials and browser identity on the way upstream', () => {
    expect(
      upstreamHeaders({
        authorization: 'Bearer local',
        origin: 'http://example.test',
        host: '127.0.0.1:58627',
        connection: 'keep-alive',
        'x-kimi-client-id': 'client',
      }),
    ).toEqual({
      host: '127.0.0.1',
      'x-kimi-client-id': 'client',
    });
  });
});

describe('host configuration', () => {
  it('accepts an alias entry and rejects unknown fields or option-like hosts', () => {
    expect(hostsSectionSchema.safeParse({ dev: { host: 'dev-box', identityFile: '~/.ssh/key' } }).success).toBe(true);
    expect(hostsSectionSchema.safeParse({ dev: { host: 'dev-box', type: 'ssh' } }).success).toBe(false);
    expect(hostsSectionSchema.safeParse({ dev: { host: '-oProxyCommand=x' } }).success).toBe(false);
  });

  it('maps the wire entry to the config entry through one schema', () => {
    expect(hostWireSchema.parse({ host: 'dev-box', identity_file: '~/.ssh/key', remote_bin: 'kimi' })).toEqual({
      host: 'dev-box',
      identityFile: '~/.ssh/key',
      remoteBin: 'kimi',
    });
  });

  it('keeps host ids safe for URL path segments', () => {
    expect(isValidHostId('dev_box-1.example')).toBe(true);
    expect(isValidHostId('a/b')).toBe(false);
    expect(isValidHostId('')).toBe(false);
  });
});

describe('ssh bootstrap', () => {
  it('quotes the remote binary while keeping home expansion', () => {
    expect(remoteBinCommand(undefined)).toBe(`"$HOME"/'.kimi-code/bin/kimi'`);
    expect(remoteBinCommand('kimi')).toBe('kimi');
    expect(remoteBinCommand('/opt/my kimi')).toBe(`'/opt/my kimi'`);
    expect(remoteKimiCommand('kimi', 'server ensure-daemon')).toBe('kimi --version; kimi server ensure-daemon');
  });

  it('finds the marker line among shell startup noise', () => {
    const stdout = `welcome\n1.0.0\n__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"pid":42,"version":"1.0.0"}\n`;
    expect(parseBootstrapOutput(stdout)).toEqual({ pid: 42, version: '1.0.0' });
    expect(parseBootstrapOutput('command output without a marker\n')).toBeUndefined();
  });

  it('reports a remote below the host protocol as outdated with its version', () => {
    const error = thrown(() =>
      parseBootstrapOutput('__KIMI_ENSURE_DAEMON__{"version":"0.40.0"}\n'),
    );
    expect(error.failure).toBe('executor_outdated');
    expect(error.remoteVersion).toBe('0.40.0');
    expect(error.message).toContain('kimi upgrade');
    expect(thrown(() => parseProbeOutput('0.40.0\n__KIMI_ENSURE_DAEMON__{"protocol":0}\n')).remoteVersion).toBe('0.40.0');
  });

  it('reports a remote below the host API level as outdated and accepts a newer one', () => {
    const marker = (apiLevel: number | undefined): string =>
      `__KIMI_ENSURE_DAEMON__${JSON.stringify({ protocol: HOST_PROTOCOL_VERSION, api_level: apiLevel, version: '2.5.2' })}\n`;
    for (const apiLevel of [undefined, HOST_API_LEVEL - 1]) {
      const error = thrown(() => parseBootstrapOutput(marker(apiLevel)));
      expect(error.failure).toBe('executor_outdated');
      expect(error.remoteVersion).toBe('2.5.2');
      expect(error.message).toContain('kimi upgrade');
    }
    expect(parseBootstrapOutput(marker(HOST_API_LEVEL + 1))).toEqual({ version: '2.5.2', pid: undefined });
  });

  it.each([
    ['version_mismatch_busy', 'remote_busy'],
    ['start_timeout', 'remote_start_failed'],
    ['lock_timeout', 'remote_start_failed'],
    ['something_new', 'unknown'],
  ] as const)('maps the ensure-daemon error %s to %s', (code, failure) => {
    const stdout = `__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"version":"2.0.0","error":"${code}","message":"m"}\n`;
    const error = thrown(() => parseBootstrapOutput(stdout));
    expect(error.failure).toBe(failure);
    expect(error.remoteVersion).toBe('2.0.0');
  });

  it('reads the protocol and version from a probe', () => {
    expect(parseProbeOutput(`__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"version":"2.0.0"}\n`)).toEqual({
      protocol: HOST_PROTOCOL_VERSION,
      version: '2.0.0',
    });
  });

  it.skipIf(process.platform === 'win32')('reports an older kimi without the probe as outdated with its version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-fake-ssh-'));
    try {
      const ssh = join(dir, 'ssh');
      writeFileSync(ssh, "#!/bin/sh\necho 'motd line'\necho '0.40.0'\necho \"error: unknown option '--probe'\" >&2\nexit 1\n");
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      const error = await bridge.probe().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HostConnectError);
      expect((error as HostConnectError).failure).toBe('executor_outdated');
      expect((error as HostConnectError).remoteVersion).toBe('0.40.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['ssh: Could not resolve hostname dev: Name or service not known', 255, 'host_not_found'],
    ['ssh: connect to host dev port 22: Connection refused', 255, 'connection_refused'],
    ['ssh: connect to host dev port 22: Operation timed out', 255, 'connect_timeout'],
    ['user@dev: Permission denied (publickey).', 255, 'authentication_failed'],
    ['Host key verification failed.', 255, 'host_key_changed'],
    ['Error: remote port forwarding failed for listen path /s', 255, 'port_forwarding_denied'],
    ['bash: kimi: command not found', 127, 'executor_not_found'],
    ["error: unknown command 'ensure-daemon'", 1, 'executor_outdated'],
    ['`kimi server` has been deprecated and no longer works.', 1, 'executor_outdated'],
    ["error: unknown command 'web'. See 'kimi --help'.", 1, 'executor_outdated'],
    ["error: too many arguments for 'web'. Expected 0 arguments but got 1.", 1, 'executor_outdated'],
    ["error: unknown option '--probe'", 1, 'executor_outdated'],
    ['something else', 1, 'unknown'],
  ] as const)('classifies %s', (stderr, code, failure) => {
    expect(classifySshFailure(stderr, code)).toBe(failure);
  });

  it.skipIf(process.platform === 'win32')('kills a bootstrap ssh when disposed before it finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-fake-ssh-'));
    try {
      const ssh = join(dir, 'ssh');
      const pidfile = join(dir, 'pid');
      writeFileSync(ssh, `#!/bin/sh\necho $$ > '${pidfile}'\nexec sleep 30\n`);
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      const pending = bridge.connect();
      let pid = 0;
      await vi.waitFor(() => {
        pid = Number.parseInt(readFileSync(pidfile, 'utf8'), 10);
        expect(pid).toBeGreaterThan(0);
      });
      bridge.dispose();
      await expect(pending).rejects.toBeInstanceOf(HostConnectError);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('continues after an unmatched frame in the same stdout chunk as the marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-handshake-'));
    try {
      const ssh = join(dir, 'ssh');
      writeFileSync(
        ssh,
        `#!/bin/sh
printf '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"version":"1.2.3"}\\n{"type":"http.res","id":"early","status":200,"headers":{},"body":"e30="}\\n'
read line
printf '{"type":"http.res","id":"1","status":200,"headers":{},"body":"e30="}\\n'
`,
      );
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      try {
        const session = await bridge.connect();
        const response = await session.request({ method: 'GET', path: '/healthz', headers: {} });
        expect(response.status).toBe(200);
      } finally {
        bridge.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('preserves UTF-8 bytes when the handshake splits a character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-handshake-bytes-'));
    try {
      const ssh = join(dir, 'ssh');
      writeFileSync(
        ssh,
        `#!/usr/bin/env node
const output = Buffer.from(${JSON.stringify(`__KIMI_ENSURE_DAEMON__${JSON.stringify({ protocol: HOST_PROTOCOL_VERSION, api_level: HOST_API_LEVEL, version: '版本1.2.3' })}\n`)});
const split = output.indexOf(Buffer.from('版本')) + 1;
process.stdout.write(output.subarray(0, split));
setImmediate(() => {
  process.stdout.write(output.subarray(split));
});
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify(${JSON.stringify({ type: 'ws.msg', id: '1', data: '你好' })}) + '\\n');
});
process.stdin.resume();
`,
      );
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      try {
        const session = await bridge.connect();
        expect(session.version).toBe('版本1.2.3');
        const message = new Promise<string>((resolve) => {
          session.openWebSocket('/api/v1/ws', {
            onMessage: resolve,
            onClose() {},
            onBackpressure() {},
          });
        });
        expect(await message).toBe('你好');
      } finally {
        bridge.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('multiplexes HTTP and WebSocket frames over ssh stdio and re-establishes after a clean idle exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-fake-ssh-'));
    try {
      const ssh = join(dir, 'ssh');
      const count = join(dir, 'count');
      writeFileSync(
        ssh,
        `#!/bin/sh
echo x >> '${count}'
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"pid":100,"version":"1.2.3"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"http.req"'*)
      body=$(printf '{"ok":true}' | base64 | tr -d '\\n')
      echo "{\\"type\\":\\"http.res\\",\\"id\\":\\"1\\",\\"status\\":200,\\"headers\\":{\\"content-type\\":\\"application/json\\"},\\"body\\":\\"$body\\"}"
      ;;
    *'"type":"ws.open"'*)
      echo '{"type":"ws.msg","id":"2","data":"hello"}'
      exit 0
      ;;
  esac
done
`,
      );
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      try {
        const session = await bridge.connect();
        expect(bridge.status).toBe('ready');
        expect(bridge.remoteVersion).toBe('1.2.3');
        const res = await session.request({ method: 'GET', path: '/api/v1/healthz', headers: {} });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true });

        const messages: string[] = [];
        await new Promise<void>((resolve) => {
          session.openWebSocket('/api/v1/ws', {
            onMessage: (data) => messages.push(data),
            onClose: () => {
              resolve();
            },
            onBackpressure() {},
          });
        });
        expect(messages).toEqual(['hello']);
        await vi.waitFor(() => {
          expect(bridge.session).toBeUndefined();
          expect(bridge.status).toBe('ready');
        });
        const reconnected = await bridge.connect();
        expect(reconnected.version).toBe('1.2.3');
        expect(readFileSync(count, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
      } finally {
        bridge.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps retrying with backoff after an abnormal exit until the host is reachable again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-fake-ssh-'));
    try {
      const ssh = join(dir, 'ssh');
      const count = join(dir, 'count');
      writeFileSync(
        ssh,
        `#!/bin/sh
echo x >> '${count}'
attempt=$(wc -l < '${count}' | tr -d ' ')
if [ "$attempt" = 2 ]; then
  echo 'ssh: connect to host dev port 22: Connection refused' >&2
  exit 255
fi
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"pid":100,"version":"1.2.3"}'
if [ "$attempt" = 1 ]; then exit 1; fi
while IFS= read -r line; do :; done
`,
      );
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      try {
        await bridge.connect();
        await vi.waitFor(
          () => {
            expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(3);
            expect(bridge.session).toBeDefined();
            expect(bridge.status).toBe('ready');
          },
          { timeout: 10_000, interval: 50 },
        );
      } finally {
        bridge.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('host HTTP session', () => {
  it('rejects a pending request when the transport closes', async () => {
    let stream: Duplex;
    stream = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        Duplex.prototype.write.call(stream, chunk, encoding, callback);
      },
    });
    const session = new StdioHostSession('1.0.0', stream);
    const pending = session.request({ method: 'GET', path: '/held', headers: {} });
    stream.destroy();
    await expect(pending).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('cancels a timed out request and ignores its late response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-http-timeout-'));
    try {
      const ssh = join(dir, 'ssh');
      const cancel = join(dir, 'cancel');
      writeFileSync(ssh, `#!/bin/sh
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"version":"1.2.3"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"http.cancel"'*)
      echo "$line" > '${cancel}'
      echo '{"type":"http.res","id":"1","status":200,"headers":{}}'
      ;;
  esac
done
`);
      chmodSync(ssh, 0o755);
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      try {
        const session = await bridge.connect();
        const request = session.request({
          method: 'GET', path: '/held', headers: {}, timeoutMs: 10,
        });
        await expect(request).rejects.toThrow('host request timed out');
        await vi.waitFor(() => expect(readFileSync(cancel, 'utf8')).toContain('"type":"http.cancel"'));
      } finally {
        bridge.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('host WebSocket backpressure', () => {

  it('pauses a client while ssh is blocked and resumes after drain', async () => {
    const app = Fastify();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server address');
    const received: string[] = [];
    let blocked = false;
    let release!: () => void;
    const drain = new Promise<void>((resolve) => { release = resolve; });
    const session = {
      version: '1.0.0',
      request: async () => { throw new Error('unexpected HTTP request'); },
      openWebSocket: (_path: string, handlers: { onMessage(data: string): void; onBackpressure(blocked: boolean): void }) => ({
        send: (data: string) => {
          received.push(data);
          if (blocked) {
            handlers.onBackpressure(true);
            void drain.then(() => {
              handlers.onBackpressure(false);
            });
          }
        },
        close() {},
      }),
    };
    app.server.on('upgrade', (req, upgradeSocket, head) => {
      void proxyHostWebSocket({ session: () => session } as never, { hostId: 'dev', path: '/api/v1/ws' }, req, upgradeSocket, head);
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${address.port}/api/v1/hosts/dev/proxy/api/v1/ws`);
    try {
      await new Promise<void>((resolve) => ws.once('open', resolve));
      blocked = true;
      ws.send('first');
      await vi.waitFor(() => {
        expect(received).toEqual(['first']);
      });
      ws.send('second');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual(['first']);
      release();
      await vi.waitFor(() => {
        expect(received).toEqual(['first', 'second']);
      });
    } finally {
      ws.terminate();
      await app.close();
    }
  });

  it('closes the RPC stream after sustained backpressure without more client messages', async () => {
    vi.useFakeTimers();
    try {
      let stream: Duplex;
      stream = new Duplex({
        highWaterMark: 1,
        read() {},
        write(chunk, encoding, callback) {
          Duplex.prototype.write.call(stream, chunk, encoding, callback);
        },
      });
      const onClose = vi.fn();
      const session = new StdioHostSession('1.0.0', stream, { onClose });
      session.openWebSocket('/api/v1/ws', {
        onMessage() {},
        onBackpressure() {},
        onClose() {},
      });
      await vi.advanceTimersByTimeAsync(WS_BACKPRESSURE_TIMEOUT_MS + 100);
      expect(stream.destroyed).toBe(true);
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ name: 'RpcBackpressureError' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers a maximum-size body frame and closes the RPC stream once its send buffer exceeds the limit', async () => {
    const stream = new Duplex({ read() {}, write() {} });
    const onClose = vi.fn();
    const rpc = new JsonlRpcStream<{ type: string; body: string }>(stream, () => {}, () => {}, onClose);
    const body = Buffer.alloc(HOST_RPC_MAX_BODY_BYTES).toString('base64');
    rpc.write({ type: 'http.res', body });
    expect(stream.destroyed).toBe(false);
    for (let frame = 0; frame < 3; frame += 1) rpc.write({ type: 'http.res', body });
    expect(stream.destroyed).toBe(true);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ name: 'RpcBackpressureError' })));
  });

  it('keeps a slow RPC stream that still makes progress and closes it once it stalls', async () => {
    vi.useFakeTimers();
    try {
      let stalled = false;
      const stream = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          if (!stalled) setTimeout(callback, 1000);
        },
      });
      const onClose = vi.fn();
      const rpc = new JsonlRpcStream<{ type: string }>(stream, () => {}, () => {}, onClose);
      rpc.write({ type: 'x'.repeat(10 * 64 * 1024) });
      await vi.advanceTimersByTimeAsync(WS_BACKPRESSURE_TIMEOUT_MS * 3);
      expect(stream.destroyed).toBe(false);
      expect(rpc.bufferedBytes).toBe(0);

      stalled = true;
      rpc.write({ type: 'x'.repeat(64 * 1024) });
      await vi.advanceTimersByTimeAsync(WS_BACKPRESSURE_TIMEOUT_MS + 1);
      expect(stream.destroyed).toBe(true);
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ name: 'RpcBackpressureError' }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('host API', () => {
  it('serves hosts without an experimental flag', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-hosts-no-flag-'));
    const previousFlag = process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'];
    process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'] = '0';
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/hosts`, {
        headers: { authorization: `Bearer ${server.authTokenService.getToken()}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ code: 0, data: { hosts: [] } });
    } finally {
      if (previousFlag === undefined) delete process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'];
      else process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'] = previousFlag;
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('host management routes', () => {
  it('tests, creates, updates and removes hosts through the real HTTP API', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-hosts-routes-'));
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const probe = vi.spyOn(SshKapBridge.prototype, 'probe').mockResolvedValue({
      version: '2.0.0',
      protocol: HOST_PROTOCOL_VERSION,
    });
    const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${server.authTokenService.getToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      const tested = await request('POST', '/api/v1/hosts:test', { host: 'dev@example.test' });
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({ code: 0, data: { connected: true, remote_version: '2.0.0' } });
      expect(probe).toHaveBeenCalledOnce();
      const created = await request('PUT', '/api/v1/hosts/dev', { host: 'dev@example.test', name: 'Dev' });
      expect(created.status).toBe(200);
      await request('PUT', '/api/v1/hosts/other', { host: 'other.example.test' });
      const updated = await request('PUT', '/api/v1/hosts/dev', { host: 'new.example.test', enabled: false });
      expect(updated.status).toBe(200);
      const listed = await request('GET', '/api/v1/hosts');
      expect(await listed.json()).toMatchObject({ data: { hosts: [
        { id: 'dev', host: 'new.example.test', enabled: false, status: 'disconnected' },
        { id: 'other', host: 'other.example.test' },
      ] } });
      expect((await request('DELETE', '/api/v1/hosts/dev')).status).toBe(200);
      const remaining = await request('GET', '/api/v1/hosts');
      expect(await remaining.json()).toEqual({ code: 0, msg: 'success', data: { hosts: [{ id: 'other', host: 'other.example.test', connected: false, status: 'pending' }] }, request_id: expect.any(String) });
    } finally {
      vi.restoreAllMocks();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('host connection', () => {
  it('reports a disabled host as disconnected instead of pending', async () => {
    const config = {
      ready: Promise.resolve(),
      get: <T,>() => ({ dev: { host: 'dev-box', enabled: false } }) as T,
      replace: vi.fn(async () => {}),
      onDidSectionChange: () => ({ dispose() {} }),
    };
    const core = {
      accessor: {
        get: (service: unknown) => {
          if (service === IConfigService) return config;
          if (service === IBootstrapService) return { osHomeDir: '/tmp' };
          throw new Error(`unexpected service ${String(service)}`);
        },
      },
    };
    let connect!: (req: unknown, reply: { send(payload: unknown): void }) => Promise<void>;
    const host = {
      get() {},
      put() {},
      delete() {},
      post(path: string, _options: unknown, handler: typeof connect) {
        if (path === '/hosts::connect') connect = handler;
      },
    };
    const manager = new HostBridgeManager(core as never, { warn() {} });
    registerHostsRoutes(host as never, core as never, manager);
    let payload!: { data: Record<string, unknown> };
    await connect(
      { id: 'request', body: { id: 'dev' } },
      { send: (value: { data: Record<string, unknown> }) => { payload = value; } },
    );
    expect(payload.data).toMatchObject({
      id: 'dev',
      enabled: false,
      status: 'disconnected',
    });
    manager.close();
  });
});

describe('host HTTP proxy', () => {
  it('enforces request limits and maps timeouts to gateway responses', async () => {
    const app = Fastify();
    registerHostProxyRoutes(app, {
      session: () => ({
        version: '1.0.0',
        request: async () => { throw new HostRequestError('timeout', 'host request timed out'); },
        openWebSocket: () => { throw new Error('unexpected websocket'); },
      }),
    } as never);
    await app.ready();
    const timeout = await app.inject({ method: 'GET', url: '/api/v1/hosts/dev/proxy/api/v1/healthz' });
    expect(timeout.statusCode).toBe(504);
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/dev/proxy/api/v1/files',
      headers: { 'content-length': String(HOST_RPC_MAX_BODY_BYTES + 1) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().code).toBe(41301);
    await app.close();
  });

  it('cancels the remote request when the client disconnects', async () => {
    const app = Fastify();
    let sessionRequest!: { signal?: AbortSignal };
    registerHostProxyRoutes(app, {
      session: () => ({
        version: '1.0.0',
        request: (input: typeof sessionRequest) => {
          sessionRequest = input;
          return new Promise(() => {});
        },
        openWebSocket: () => { throw new Error('unexpected websocket'); },
      }),
    } as never);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server address');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write('POST /api/v1/hosts/dev/proxy/api/v1/sessions/s1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx');
      await vi.waitFor(() => expect(sessionRequest).toBeDefined());
      socket.destroy();
      await vi.waitFor(() => expect(sessionRequest.signal?.aborted).toBe(true));
    } finally {
      socket.destroy();
      await app.close();
    }
  });
});

describe('host credentials', () => {
  it.skipIf(process.platform === 'win32')('shares only the local access token and never refreshes on the remote host', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'kimi-host-local-'));
    const remoteHome = await mkdtemp(join(tmpdir(), 'kimi-host-remote-'));
    const localStorage = new FileTokenStorage(join(localHome, 'credentials'));
    const now = Math.floor(Date.now() / 1000);
    await localStorage.save('kimi-code', {
      accessToken: 'local-access', refreshToken: 'local-refresh', expiresAt: now + 3600, expiresIn: 3600, scope: '', tokenType: 'Bearer',
    });
    const refreshRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/oauth/token')) {
        if (typeof init?.body !== 'string') throw new TypeError('expected form body');
        refreshRequests.push(new URLSearchParams(init.body).get('refresh_token') ?? '');
        return Response.json({ access_token: `local-access-${String(refreshRequests.length + 1)}`, refresh_token: 'local-refresh-next', expires_in: 3600, token_type: 'Bearer', scope: '' });
      }
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test-model', limit: { context: 100_000 } }] });
      throw new Error(`unexpected request ${url}`);
    }));
    writeFileSync(join(localHome, 'config.toml'), '[hosts.dev]\nhost = "dev"\n');
    const env = { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' };
    const local = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: localHome, logLevel: 'silent', env });
    const remote = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: remoteHome, logLevel: 'silent',
      socketPath: join(remoteHome, 'daemon.sock'), managedBy: 'ensure-daemon', env,
    });
    const client = createConnection(join(remoteHome, 'daemon.sock'));
    const pending = new Map<string, (response: HostHttpResponse) => void>();
    createInterface({ input: client, crlfDelay: Infinity }).on('line', (line) => {
      const frame = JSON.parse(line) as { id?: string; status?: number; headers?: OutgoingHttpHeaders; body?: string };
      if (frame.id === undefined) return;
      pending.get(frame.id)?.({ status: frame.status ?? 500, headers: frame.headers ?? {}, body: Buffer.from(frame.body ?? '', 'base64') });
      pending.delete(frame.id);
    });
    let requestId = 0;
    const shared: HostCredential[] = [];
    const session: HostSession = {
      version: 'test',
      request: (input: HostHttpRequest) => new Promise<HostHttpResponse>((resolve) => {
        const id = `credential-${String(++requestId)}`;
        const update = JSON.parse(input.body?.toString('utf8') ?? '{}') as { action?: string; credential?: HostCredential };
        if (update.credential !== undefined) shared.push(update.credential);
        pending.set(id, resolve);
        client.write(`${JSON.stringify({ type: 'http.req', id, method: input.method, path: input.path, headers: input.headers, body: input.body?.toString('base64') })}\n`);
      }),
      openWebSocket: () => { throw new Error('not used'); },
    };
    vi.spyOn(SshKapBridge.prototype, 'connect').mockResolvedValue(session);
    vi.spyOn(SshKapBridge.prototype, 'session', 'get').mockReturnValue(session);
    const manager = local.hostBridges;
    const remoteAccess = () => remote.core.accessor.get(IOAuthService).resolveTokenProvider(KIMI_CODE_PROVIDER_NAME)!.getAccessToken({ force: true });
    const remoteCached = () => remote.core.accessor.get(IOAuthToolkit).getCachedAccessToken(KIMI_CODE_PROVIDER_NAME);
    try {
      await manager.connect('dev');
      await manager.syncCredentials();
      expect(shared.at(-1)).toMatchObject({ access_token: 'local-access' });
      expect(shared.at(-1)).not.toHaveProperty('refresh_token');
      expect(existsSync(join(remoteHome, 'server', 'host-credential.json'))).toBe(false);
      await expect(new FileTokenStorage(join(remoteHome, 'credentials')).load('kimi-code')).resolves.toBeUndefined();
      await expect(remoteAccess()).resolves.toBe('local-access');

      await localStorage.save('kimi-code', { accessToken: 'local-access', refreshToken: 'local-refresh', expiresAt: now + 10, expiresIn: 3600, scope: '', tokenType: 'Bearer' });
      await manager.syncCredentials();
      expect(refreshRequests).toEqual(['local-refresh']);
      await expect(remoteAccess()).resolves.toBe('local-access-2');

      await sendHostCredentialUpdate(session, { action: 'put', credential: { ...shared.at(-1)!, access_token: 'stale', expires_at: now + 60 } });
      await expect(remoteAccess()).resolves.toBe('local-access-2');

      vi.useFakeTimers({ toFake: ['Date'], now: (now + 7200) * 1000 });
      await expect(remoteAccess()).rejects.toThrow(/expired/);
      vi.useRealTimers();
      expect(refreshRequests).toEqual(['local-refresh']);

      const remoteProvider = remote.core.accessor.get(IConfigService).get<Record<string, unknown>>('providers')?.[KIMI_CODE_PROVIDER_NAME];
      await local.core.accessor.get(IConfigService).replace('providers', { [KIMI_CODE_PROVIDER_NAME]: remoteProvider });
      await vi.waitFor(async () => {
        expect(await remoteCached()).toBe('local-access-2');
      });
      await local.core.accessor.get(IOAuthService).logout();
      await vi.waitFor(async () => {
        expect(await remoteCached()).toBeUndefined();
      });
      await expect(remoteAccess()).rejects.toThrow(/No Kimi credential/);

      await localStorage.save('kimi-code', { accessToken: 'next-account', refreshToken: 'next-refresh', expiresAt: now + 3600, expiresIn: 3600, scope: '', tokenType: 'Bearer' });
      await manager.syncCredentials();
      await expect(remoteAccess()).resolves.toBe('next-account');
      await local.core.accessor.get(IConfigService).replace('hosts', {});
      await vi.waitFor(async () => {
        expect(await remoteCached()).toBeUndefined();
      });
      expect(refreshRequests).toEqual(['local-refresh']);
    } finally {
      vi.useRealTimers();
      client.destroy();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      manager.close();
      await local.close();
      await remote.close();
      await rm(localHome, { recursive: true, force: true });
      await rm(remoteHome, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('host model providers', () => {
  it.skipIf(process.platform === 'win32')('copies portable providers with their models and leaves existing remote providers alone', async () => {
    const localHome = await mkdtemp(join(tmpdir(), 'kimi-host-local-'));
    const remoteHome = await mkdtemp(join(tmpdir(), 'kimi-host-remote-'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    writeFileSync(join(localHome, 'config.toml'), '[hosts.dev]\nhost = "dev"\n');
    const env = { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' };
    const local = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: localHome, logLevel: 'silent', env });
    const remote = await startServer({
      hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: remoteHome, logLevel: 'silent',
      socketPath: join(remoteHome, 'daemon.sock'), managedBy: 'ensure-daemon', env,
    });
    const client = createConnection(join(remoteHome, 'daemon.sock'));
    const pending = new Map<string, (response: HostHttpResponse) => void>();
    createInterface({ input: client, crlfDelay: Infinity }).on('line', (line) => {
      const frame = JSON.parse(line) as { id?: string; status?: number; headers?: OutgoingHttpHeaders; body?: string };
      if (frame.id === undefined) return;
      pending.get(frame.id)?.({ status: frame.status ?? 500, headers: frame.headers ?? {}, body: Buffer.from(frame.body ?? '', 'base64') });
      pending.delete(frame.id);
    });
    let requestId = 0;
    const session: HostSession = {
      version: 'test',
      request: (input: HostHttpRequest) => new Promise<HostHttpResponse>((resolve) => {
        const id = `providers-${String(++requestId)}`;
        pending.set(id, resolve);
        client.write(`${JSON.stringify({ type: 'http.req', id, method: input.method, path: input.path, headers: input.headers, body: input.body?.toString('base64') })}\n`);
      }),
      openWebSocket: () => { throw new Error('not used'); },
    };
    vi.spyOn(SshKapBridge.prototype, 'connect').mockResolvedValue(session);
    vi.spyOn(SshKapBridge.prototype, 'session', 'get').mockReturnValue(session);
    const localConfig = local.core.accessor.get(IConfigService);
    const remoteConfig = remote.core.accessor.get(IConfigService);
    await localConfig.ready;
    await remoteConfig.ready;
    await localConfig.replace('providers', {
      gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', apiKey: 'sk-gateway', customHeaders: { 'x-team': 'core' } },
      taken: { type: 'openai', baseUrl: 'https://taken.example.test/v1', apiKey: 'sk-local' },
      fromEnv: { type: 'openai', baseUrl: 'https://env.example.test/v1', apiKeyEnv: 'GATEWAY_KEY' },
      ollama: { type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
      signedIn: { type: 'openai', oauth: { storage: 'file', key: 'signed-in' } },
    });
    await localConfig.replace('models', {
      'gateway/large': { provider: 'gateway', model: 'large', maxContextSize: 200_000, maxOutputSize: 8_000, adaptiveThinking: true },
      'taken/small': { provider: 'taken', model: 'small', maxContextSize: 32_000 },
      'ollama/local': { provider: 'ollama', model: 'local', maxContextSize: 8_000 },
    });
    await remoteConfig.replace('providers', { taken: { type: 'openai', baseUrl: 'https://taken.example.test/v1', apiKey: 'sk-remote' } });
    const manager = local.hostBridges;
    try {
      const result = await manager.copyProviders('dev');
      expect(result.copied).toEqual(['gateway']);
      expect(result.skipped).toEqual(expect.arrayContaining([
        { id: 'fromEnv', reason: 'env_key' },
        { id: 'ollama', reason: 'loopback' },
        { id: 'signedIn', reason: 'oauth' },
        { id: 'taken', reason: 'exists' },
      ]));
      expect(result.skipped).toHaveLength(4);
      const providers = remoteConfig.inspect<Record<string, Record<string, unknown>>>('providers').userValue ?? {};
      expect(providers['gateway']).toMatchObject({ apiKey: 'sk-gateway', customHeaders: { 'x-team': 'core' } });
      expect(providers['taken']).toMatchObject({ apiKey: 'sk-remote' });
      expect(providers).not.toHaveProperty('ollama');
      const models = remoteConfig.inspect<Record<string, Record<string, unknown>>>('models').userValue ?? {};
      expect(models['gateway/large']).toMatchObject({ provider: 'gateway', maxOutputSize: 8_000, adaptiveThinking: true });
      expect(models).not.toHaveProperty('taken/small');
      expect(models).not.toHaveProperty('ollama/local');

      await expect(manager.copyProviders('dev')).resolves.toMatchObject({ copied: [] });
      await expect(manager.copyProviders('missing')).rejects.toThrow(/not configured/);
    } finally {
      client.destroy();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      manager.close();
      await local.close();
      await remote.close();
      await rm(localHome, { recursive: true, force: true });
      await rm(remoteHome, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('stdio rpc transport', () => {
  it.skipIf(process.platform === 'win32')('routes HTTP requests and WebSocket frames over a unix domain socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-rpc-sock-'));
    const socketPath = join(dir, 'daemon.sock');
    const app = Fastify();
    app.post('/api/v1/echo', async (req) => ({ body: req.body, host: req.headers.host }));
    await app.ready();

    const wssV1 = new WebSocketServer({ noServer: true });
    wssV1.on('connection', (ws) => {
      ws.on('message', (data) => {
        ws.send(`ack:${Buffer.isBuffer(data) ? data.toString('utf8') : ''}`);
      });
    });

    const rpcServer = await startUnixRpcServer(socketPath, { app, wssV1 });
    const client = createConnection(socketPath);
    try {
      const lines = createInterface({ input: client, crlfDelay: Infinity });
      const iterator = lines[Symbol.asyncIterator]();
      const nextLine = async (): Promise<Record<string, unknown>> => {
        while (true) {
          const { value: line, done } = await iterator.next();
          if (done) throw new Error('RPC stream ended');
          if (line.trim().length > 0) return JSON.parse(line.trim()) as Record<string, unknown>;
        }
      };

      client.write(
        `${JSON.stringify({
          type: 'http.req',
          id: 'req-1',
          method: 'POST',
          path: '/api/v1/echo',
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ ping: 1 })).toString('base64'),
        })}\n`,
      );
      const httpRes = await nextLine();
      expect(httpRes['type']).toBe('http.res');
      expect(httpRes['status']).toBe(200);
      expect(JSON.parse(Buffer.from(httpRes['body'] as string, 'base64').toString('utf8'))).toEqual({
        body: { ping: 1 },
        host: '127.0.0.1',
      });

      client.write(`${JSON.stringify({ type: 'ws.open', id: 'ws-1', path: '/api/v1/ws' })}\n`);
      client.write(`${JSON.stringify({ type: 'ws.msg', id: 'ws-1', data: 'hi' })}\n`);
      const wsMsg = await nextLine();
      expect(wsMsg).toEqual({ type: 'ws.msg', id: 'ws-1', data: 'ack:hi' });
    } finally {
      client.destroy();
      await rpcServer.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('drops a cancelled response and keeps serving later requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-rpc-cancel-'));
    const app = Fastify();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    app.get('/held', async () => {
      started();
      await sleep(100);
      return { done: true };
    });
    app.get('/next', async () => ({ done: true }));
    const rpcServer = await startUnixRpcServer(join(dir, 'daemon.sock'), {
      app,
      wssV1: new WebSocketServer({ noServer: true }),
    });
    const client = createConnection(join(dir, 'daemon.sock'));
    try {
      await new Promise<void>((resolve) => client.once('connect', resolve));
      const frames: Array<Record<string, unknown>> = [];
      let buffer = '';
      client.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        frames.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
        buffer = buffer.slice(end + 1);
      });
      client.write(`${JSON.stringify({ type: 'http.req', id: 'cancel', method: 'GET', path: '/held', headers: {} })}\n`);
      await requestStarted;
      client.write(`${JSON.stringify({ type: 'http.cancel', id: 'cancel' })}\n`);
      client.write(`${JSON.stringify({ type: 'http.req', id: 'next', method: 'GET', path: '/next', headers: {} })}\n`);
      await vi.waitFor(() => expect(frames.some((frame) => frame['id'] === 'next')).toBe(true));
      await sleep(150);
      expect(frames.some((frame) => frame['id'] === 'cancel')).toBe(false);
    } finally {
      client.destroy();
      await rpcServer.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('stops reading an oversized response and returns 413', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-rpc-limit-'));
    const app = Fastify();
    app.get('/large', async () => Buffer.alloc(HOST_RPC_MAX_BODY_BYTES + 1));
    const rpcServer = await startUnixRpcServer(join(dir, 'daemon.sock'), {
      app,
      wssV1: new WebSocketServer({ noServer: true }),
    });
    const client = createConnection(join(dir, 'daemon.sock'));
    try {
      await new Promise<void>((resolve) => client.once('connect', resolve));
      const response = new Promise<Record<string, unknown>>((resolve) => {
        let buffer = '';
        client.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const end = buffer.indexOf('\n');
          if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
        });
      });
      client.write(`${JSON.stringify({ type: 'http.req', id: 'large', method: 'GET', path: '/large', headers: {} })}\n`);
      expect((await response)['status']).toBe(413);
    } finally {
      client.destroy();
      await rpcServer.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the stream backlog as the WebSocket buffered amount', async () => {
    const app = Fastify();
    const wssV1 = new WebSocketServer({ noServer: true });
    let connected!: NodeWebSocket;
    wssV1.on('connection', (ws) => { connected = ws; });
    let hold = false;
    let release: (() => void) | undefined;
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        if (hold) release = callback;
        else callback();
      },
    });
    attachRpcStream(stream, { app, wssV1 });
    try {
      stream.push(`${JSON.stringify({ type: 'ws.open', id: 'live', path: '/api/v1/ws' })}\n`);
      await vi.waitFor(() => expect(connected).toBeDefined());
      for (let message = 0; message < 100; message += 1) connected.send('x'.repeat(1024));
      expect(connected.bufferedAmount).toBe(0);
      hold = true;
      connected.send('held');
      expect(connected.bufferedAmount).toBeGreaterThan(0);
      release?.();
      expect(connected.bufferedAmount).toBe(0);
    } finally {
      stream.destroy();
      await app.close();
    }
  });

  it('closes the entire RPC stream after sustained backpressure', async () => {
    vi.useFakeTimers();
    try {
      const app = Fastify();
      const wssV1 = new WebSocketServer({ noServer: true });
      let connected!: NodeWebSocket;
      wssV1.on('connection', (ws) => { connected = ws; });
      let stream: Duplex;
      stream = new Duplex({
        highWaterMark: 1,
        read() {},
        write(chunk, encoding, callback) {
          Duplex.prototype.write.call(stream, chunk, encoding, callback);
        },
      });
      attachRpcStream(stream, { app, wssV1 });
      stream.push(`${JSON.stringify({ type: 'ws.open', id: 'slow', path: '/api/v1/ws' })}\n`);
      await vi.waitFor(() => expect(connected).toBeDefined());
      stream.emit('drain');
      connected.send('first');
      stream.emit('drain');
      connected.send('second');
      await vi.advanceTimersByTimeAsync(WS_BACKPRESSURE_TIMEOUT_MS - 1);
      expect(connected.readyState).toBe(connected.OPEN);
      stream.emit('drain');
      connected.send('third');
      await vi.advanceTimersByTimeAsync(WS_BACKPRESSURE_TIMEOUT_MS - 1);
      expect(connected.readyState).toBe(connected.OPEN);
      await vi.advanceTimersByTimeAsync(2);
      expect(stream.destroyed).toBe(true);
      expect(connected.readyState).toBe(3);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
