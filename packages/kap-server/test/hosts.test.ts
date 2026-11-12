import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { IConfigService, IOAuthService } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';
import WebSocketClient, { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';

import { HOST_API_LEVEL, HOST_PROTOCOL_VERSION } from '../src/services/hosts/hostProtocol';
import { matchHostProxyPath, proxyHostWebSocket, registerHostProxyRoutes, upstreamHeaders } from '../src/services/hosts/hostProxy';
import { HostBridgeManager } from '../src/services/hosts/hostBridgeManager';
import { collectSharedProviders } from '../src/services/hosts/hostProviders';
import { hostsSectionSchema, hostWireSchema, isValidHostId } from '../src/services/hosts/hostsConfig';
import { HostRequestError, type HostHttpRequest, type HostHttpResponse, type HostSession } from '../src/services/hosts/hostSession';
import { StdioHostSession } from '../src/services/hosts/stdioHostSession';
import { JsonlRpcStream } from '../src/transport/jsonlRpcStream';
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

async function withFakeSsh(
  script: string | ((dir: string) => string),
  run: (ssh: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-fake-ssh-'));
  try {
    const ssh = join(dir, 'ssh');
    writeFileSync(ssh, typeof script === 'function' ? script(dir) : script);
    chmodSync(ssh, 0o755);
    await run(ssh, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it.skipIf(process.platform === 'win32')('reports an older kimi without the probe as outdated with its version', () =>
    withFakeSsh("#!/bin/sh\necho 'motd line'\necho '0.40.0'\necho \"error: unknown option '--probe'\" >&2\nexit 1\n", async (ssh) => {
      const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
      const error = await bridge.probe().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HostConnectError);
      expect((error as HostConnectError).failure).toBe('executor_outdated');
      expect((error as HostConnectError).remoteVersion).toBe('0.40.0');
    }),
  );

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

  it.skipIf(process.platform === 'win32')('kills a bootstrap ssh when disposed before it finishes', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh\necho $$ > '${join(dir, 'pid')}'\nexec sleep 30\n`,
      async (ssh, dir) => {
        const pidfile = join(dir, 'pid');
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
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('continues after an unmatched frame in the same stdout chunk as the marker', () =>
    withFakeSsh(
      `#!/bin/sh
printf '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"version":"1.2.3"}\\n{"type":"http.res","id":"early","status":200,"headers":{},"body":"e30="}\\n'
read line
printf '{"type":"http.res","id":"1","status":200,"headers":{},"body":"e30="}\\n'
`,
      async (ssh) => {
        const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          const session = await bridge.connect();
          const response = await session.request({ method: 'GET', path: '/healthz', headers: {} });
          expect(response.status).toBe(200);
        } finally {
          bridge.dispose();
        }
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('preserves UTF-8 bytes when the handshake splits a character', () =>
    withFakeSsh(
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
      async (ssh) => {
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
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('multiplexes HTTP and WebSocket frames over ssh stdio and re-establishes after a clean idle exit', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
echo x >> '${join(dir, 'count')}'
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
      async (ssh, dir) => {
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
          expect(readFileSync(join(dir, 'count'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
        } finally {
          bridge.dispose();
        }
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('keeps retrying with backoff after an abnormal exit until the host is reachable again', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
echo x >> '${join(dir, 'count')}'
attempt=$(wc -l < '${join(dir, 'count')}' | tr -d ' ')
if [ "$attempt" = 2 ]; then
  echo 'ssh: connect to host dev port 22: Connection refused' >&2
  exit 255
fi
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"pid":100,"version":"1.2.3"}'
if [ "$attempt" = 1 ]; then exit 1; fi
while IFS= read -r line; do :; done
`,
      async (ssh, dir) => {
        const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          await bridge.connect();
          await vi.waitFor(
            () => {
              expect(readFileSync(join(dir, 'count'), 'utf8').trim().split('\n')).toHaveLength(3);
              expect(bridge.session).toBeDefined();
              expect(bridge.status).toBe('ready');
            },
            { timeout: 10_000, interval: 50 },
          );
        } finally {
          bridge.dispose();
        }
      },
    ),
  15_000);

  it.skipIf(process.platform === 'win32')('retries a first connection that failed for a retryable reason', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
echo x >> '${join(dir, 'count')}'
attempt=$(wc -l < '${join(dir, 'count')}' | tr -d ' ')
if [ "$attempt" = 1 ]; then
  echo 'ssh: connect to host dev port 22: Connection refused' >&2
  exit 255
fi
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"pid":100,"version":"1.2.3"}'
while IFS= read -r line; do :; done
`,
      async (ssh) => {
        const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          bridge.start();
          await vi.waitFor(() => {
            expect(bridge.status).toBe('disconnected');
            expect(bridge.failure).toBe('connection_refused');
          });
          await vi.waitFor(
            () => {
              expect(bridge.status).toBe('ready');
              expect(bridge.session).toBeDefined();
            },
            { timeout: 5_000, interval: 50 },
          );
        } finally {
          bridge.dispose();
        }
      },
    ),
  10_000);

  it.skipIf(process.platform === 'win32')('keeps retrying in the background after an explicit connect fails', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
if [ -e '${join(dir, 'down')}' ]; then
  echo 'ssh: connect to host dev port 22: Connection refused' >&2
  exit 255
fi
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"pid":100,"version":"1.2.3"}'
while IFS= read -r line; do :; done
`,
      async (ssh, dir) => {
        const down = join(dir, 'down');
        writeFileSync(down, '');
        const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          bridge.start();
          await vi.waitFor(() => {
            expect(bridge.failure).toBe('connection_refused');
          });
          await expect(bridge.connect()).rejects.toBeInstanceOf(HostConnectError);
          rmSync(down);
          await vi.waitFor(
            () => {
              expect(bridge.status).toBe('ready');
              expect(bridge.session).toBeDefined();
            },
            { timeout: 5_000, interval: 50 },
          );
        } finally {
          bridge.dispose();
        }
      },
    ),
  10_000);

  it.skipIf(process.platform === 'win32')('does not retry a first connection that failed authentication', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh\necho x >> '${join(dir, 'count')}'\necho 'dev: Permission denied (publickey).' >&2\nexit 255\n`,
      async (ssh, dir) => {
        const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          bridge.start();
          await vi.waitFor(() => {
            expect(bridge.failure).toBe('authentication_failed');
          });
          await sleep(1_500);
          expect(readFileSync(join(dir, 'count'), 'utf8').trim().split('\n')).toHaveLength(1);
        } finally {
          bridge.dispose();
        }
      },
    ),
  10_000);
});

describe('host auto-connect', () => {
  function managerWith(section: Record<string, { host: string; enabled?: boolean }>) {
    let listener: ((event: { domain: string }) => void) | undefined;
    const config = {
      ready: Promise.resolve(),
      get: <T,>() => section as T,
      replace: vi.fn(async () => {}),
      onDidSectionChange: (next: typeof listener) => {
        listener = next;
        return { dispose() {} };
      },
    };
    const core = {
      accessor: {
        get: (service: unknown) => {
          if (service === IConfigService) return config;
          throw new Error(`unexpected service ${String(service)}`);
        },
      },
    };
    const manager = new HostBridgeManager(core as never, { warn() {} });
    return { manager, changeHosts: () => listener?.({ domain: 'hosts' }) };
  }

  it('connects enabled hosts once a client has connected, including hosts added later', async () => {
    const started: string[] = [];
    const start = vi.spyOn(SshKapBridge.prototype, 'start').mockImplementation(function (this: SshKapBridge) {
      started.push((this as unknown as { entry: { host: string } }).entry.host);
    });
    const section: Record<string, { host: string; enabled?: boolean }> = {
      dev: { host: 'dev-box' },
      off: { host: 'off-box', enabled: false },
    };
    const { manager, changeHosts } = managerWith(section);
    try {
      changeHosts();
      expect(started).toEqual([]);
      manager.activate();
      manager.activate();
      await vi.waitFor(() => {
        expect(started).toEqual(['dev-box']);
      });
      section['added'] = { host: 'added-box' };
      changeHosts();
      expect(started).toEqual(['dev-box', 'added-box']);
      section['off'] = { host: 'off-box' };
      changeHosts();
      expect(started).toEqual(['dev-box', 'added-box', 'off-box']);
    } finally {
      start.mockRestore();
      manager.close();
    }
  });
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

  it('cancels a timed out request and ignores its late response', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"api_level":${String(HOST_API_LEVEL)},"version":"1.2.3"}'
while IFS= read -r line; do
  case "$line" in
    *'"type":"http.cancel"'*)
      echo "$line" > '${join(dir, 'cancel')}'
      echo '{"type":"http.res","id":"1","status":200,"headers":{}}'
      ;;
  esac
done
`,
      async (ssh, dir) => {
        const bridge = new SshKapBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          const session = await bridge.connect();
          const request = session.request({
            method: 'GET', path: '/held', headers: {}, timeoutMs: 10,
          });
          await expect(request).rejects.toThrow('host request timed out');
          await vi.waitFor(() => expect(readFileSync(join(dir, 'cancel'), 'utf8')).toContain('"type":"http.cancel"'));
        } finally {
          bridge.dispose();
        }
      },
    ),
  );
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
});

describe('host management routes', () => {
  it('tests, creates, updates and removes hosts through the real HTTP API without an experimental flag', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-hosts-routes-'));
    const previousFlag = process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'];
    process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'] = '0';
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
      const connected = await request('POST', '/api/v1/hosts:connect', { id: 'dev' });
      expect(await connected.json()).toMatchObject({ data: { id: 'dev', enabled: false, status: 'disconnected' } });
      const listed = await request('GET', '/api/v1/hosts');
      expect(await listed.json()).toMatchObject({ data: { hosts: [
        { id: 'dev', host: 'new.example.test', enabled: false, status: 'disconnected' },
        { id: 'other', host: 'other.example.test' },
      ] } });
      expect((await request('DELETE', '/api/v1/hosts/dev')).status).toBe(200);
      const remaining = await request('GET', '/api/v1/hosts');
      expect(await remaining.json()).toEqual({ code: 0, msg: 'success', data: { hosts: [{ id: 'other', host: 'other.example.test', connected: false, status: 'pending' }] }, request_id: expect.any(String) });
    } finally {
      if (previousFlag === undefined) delete process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'];
      else process.env['KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE'] = previousFlag;
      vi.restoreAllMocks();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
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

interface ManagedHostPair {
  readonly local: Awaited<ReturnType<typeof startServer>>;
  readonly remote: Awaited<ReturnType<typeof startServer>>;
  readonly localHome: string;
  readonly remoteHome: string;
  readonly session: HostSession;
  readonly paths: string[];
}

async function withManagedHostPair(
  fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>,
  run: (pair: ManagedHostPair) => Promise<void>,
): Promise<void> {
  const localHome = await mkdtemp(join(tmpdir(), 'kimi-host-local-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'kimi-host-remote-'));
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
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
  const paths: string[] = [];
  let requestId = 0;
  const session: HostSession = {
    version: 'test',
    request: (input: HostHttpRequest) => new Promise<HostHttpResponse>((resolve) => {
      const id = `req-${String(++requestId)}`;
      paths.push(input.path);
      pending.set(id, resolve);
      client.write(`${JSON.stringify({ type: 'http.req', id, method: input.method, path: input.path, headers: input.headers, body: input.body?.toString('base64') })}\n`);
    }),
    openWebSocket: () => { throw new Error('not used'); },
  };
  vi.spyOn(SshKapBridge.prototype, 'connect').mockResolvedValue(session);
  vi.spyOn(SshKapBridge.prototype, 'session', 'get').mockReturnValue(session);
  try {
    await run({ local, remote, localHome, remoteHome, session, paths });
  } finally {
    client.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    local.hostBridges.close();
    await local.close();
    await remote.close();
    await rm(localHome, { recursive: true, force: true });
    await rm(remoteHome, { recursive: true, force: true });
  }
}

describe('host account', () => {
  it.skipIf(process.platform === 'win32')('lets a managed host sign in and renew with its own Kimi login', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refreshRequests: string[] = [];
    await withManagedHostPair(
      async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/oauth/device_authorization')) {
          return Response.json({
            user_code: 'ABCD-1234',
            device_code: 'device-code',
            verification_uri: 'https://auth.example.test/device',
            verification_uri_complete: 'https://auth.example.test/device?user_code=ABCD-1234',
            expires_in: 600,
            interval: 600,
          });
        }
        if (url.endsWith('/api/oauth/token')) {
          if (typeof init?.body !== 'string') throw new TypeError('expected form body');
          const form = new URLSearchParams(init.body);
          if (form.get('grant_type') !== 'refresh_token') return Response.json({ error: 'authorization_pending' }, { status: 400 });
          refreshRequests.push(form.get('refresh_token') ?? '');
          return Response.json({ access_token: 'remote-access-2', refresh_token: 'remote-refresh-next', expires_in: 3600, token_type: 'Bearer', scope: '' });
        }
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test-model', limit: { context: 100_000 } }] });
        throw new Error(`unexpected request ${url}`);
      },
      async ({ local, remote, localHome, remoteHome, session, paths }) => {
        const localStorage = new FileTokenStorage(join(localHome, 'credentials'));
        const remoteStorage = new FileTokenStorage(join(remoteHome, 'credentials'));
        await localStorage.save('kimi-code', {
          accessToken: 'local-access', refreshToken: 'local-refresh', expiresAt: now + 3600, expiresIn: 3600, scope: '', tokenType: 'Bearer',
        });
        await remoteStorage.save('kimi-code', {
          accessToken: 'remote-access', refreshToken: 'remote-refresh', expiresAt: now + 10, expiresIn: 3600, scope: '', tokenType: 'Bearer',
        });
        const manager = local.hostBridges;
        const remoteJson = async (method: string, path: string, body?: unknown) => {
          const response = await session.request({
            method,
            path,
            headers: body === undefined ? {} : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
          });
          return { status: response.status, body: JSON.parse(response.body.toString('utf8')) as { code: number; data?: Record<string, unknown> } };
        };

        await manager.connect('dev');
        expect(paths).toEqual([]);

        await expect(
          remote.core.accessor.get(IOAuthService).resolveTokenProvider(KIMI_CODE_PROVIDER_NAME)!.getAccessToken({ force: true }),
        ).resolves.toBe('remote-access-2');
        expect(refreshRequests).toEqual(['remote-refresh']);
        await expect(remoteStorage.load('kimi-code')).resolves.toMatchObject({ refreshToken: 'remote-refresh-next' });
        await expect(localStorage.load('kimi-code')).resolves.toMatchObject({ accessToken: 'local-access', refreshToken: 'local-refresh' });

        await expect(remoteJson('POST', '/api/v1/oauth/login', {})).resolves.toMatchObject({ status: 200, body: { data: { status: 'authenticated' } } });
        await expect(remoteJson('POST', '/api/v1/oauth/logout', {})).resolves.toMatchObject({ status: 200, body: { code: 0 } });
        await expect(remoteStorage.load('kimi-code')).resolves.toBeUndefined();
        await expect(localStorage.load('kimi-code')).resolves.toMatchObject({ refreshToken: 'local-refresh' });
        const started = await remoteJson('POST', '/api/v1/oauth/login', {});
        expect(started).toMatchObject({ status: 200, body: { code: 0 } });
        expect(JSON.stringify(started.body.data)).toContain('ABCD-1234');
        await expect(remoteJson('DELETE', '/api/v1/oauth/login')).resolves.toMatchObject({ status: 200 });
      },
    );
  }, 30_000);
});

describe('host model providers', () => {
  it.skipIf(process.platform === 'win32')('copies portable providers with their models, replaces same-name ones whole and reports which ones match', async () => {
    await withManagedHostPair(
      async () => new Response(null, { status: 404 }),
      async ({ local, remote }) => {
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
        await remoteConfig.replace('providers', {
          taken: { type: 'openai', baseUrl: 'https://taken.example.test/v1', apiKeyEnv: 'TAKEN_KEY', oauth: { storage: 'file', key: 'taken' } },
          kept: { type: 'openai', baseUrl: 'https://kept.example.test/v1', apiKey: 'sk-kept' },
        });
        await remoteConfig.replace('models', { 'taken/remote-only': { provider: 'taken', model: 'remote-only', maxContextSize: 16_000 } });
        const manager = local.hostBridges;
        const statusOf = async () => manager.providerStatus('dev', (await collectSharedProviders(local.core)).shared);

        await expect(statusOf()).resolves.toEqual({ gateway: 'missing', taken: 'outdated' });

        const result = await manager.copyProviders('dev');
        expect(result.copied).toEqual(['gateway']);
        expect(result.updated).toEqual(['taken']);
        expect(result.skipped).toEqual(expect.arrayContaining([
          { id: 'fromEnv', reason: 'env_key' },
          { id: 'ollama', reason: 'loopback' },
          { id: 'signedIn', reason: 'oauth' },
        ]));
        expect(result.skipped).toHaveLength(3);
        const providers = remoteConfig.inspect<Record<string, Record<string, unknown>>>('providers').userValue ?? {};
        expect(providers['gateway']).toMatchObject({ apiKey: 'sk-gateway', customHeaders: { 'x-team': 'core' } });
        expect(providers['taken']).toEqual({ type: 'openai', baseUrl: 'https://taken.example.test/v1', apiKey: 'sk-local' });
        expect(providers['kept']).toMatchObject({ apiKey: 'sk-kept' });
        expect(providers).not.toHaveProperty('ollama');
        const models = remoteConfig.inspect<Record<string, Record<string, unknown>>>('models').userValue ?? {};
        expect(models['gateway/large']).toMatchObject({ provider: 'gateway', maxOutputSize: 8_000, adaptiveThinking: true });
        expect(models['taken/small']).toMatchObject({ provider: 'taken', maxContextSize: 32_000 });
        expect(models).not.toHaveProperty('taken/remote-only');
        expect(models).not.toHaveProperty('ollama/local');
        await expect(statusOf()).resolves.toEqual({ gateway: 'synced', taken: 'synced' });

        await localConfig.replace('providers', {
          ...localConfig.inspect<Record<string, unknown>>('providers').userValue,
          gateway: { type: 'openai', baseUrl: 'https://gateway.example.test/v1', apiKey: 'sk-rotated', customHeaders: { 'x-team': 'core' } },
        });
        await expect(statusOf()).resolves.toEqual({ gateway: 'outdated', taken: 'synced' });

        await expect(manager.copyProviders('dev')).resolves.toMatchObject({ copied: [], updated: ['gateway', 'taken'] });
        await expect(manager.copyProviders('missing')).rejects.toThrow(/not configured/);

        await remoteConfig.replace('providers', {});
        await remoteConfig.replace('models', {});
        await expect(manager.copyProviders('dev', ['taken', 'ollama'])).resolves.toEqual({
          copied: ['taken'],
          updated: [],
          skipped: [{ id: 'ollama', reason: 'loopback' }],
        });
        const selected = remoteConfig.inspect<Record<string, Record<string, unknown>>>('providers').userValue ?? {};
        expect(Object.keys(selected)).toEqual(['taken']);
        expect(Object.keys(remoteConfig.inspect<Record<string, unknown>>('models').userValue ?? {})).toEqual(['taken/small']);
      },
    );
  }, 30_000);
});

function rpcClient(socketPath: string) {
  const socket = createConnection(socketPath);
  const frames: Array<Record<string, unknown>> = [];
  createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim().length > 0) frames.push(JSON.parse(line.trim()) as Record<string, unknown>);
  });
  return {
    socket,
    frames,
    send(frame: Record<string, unknown>) {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
    async next(): Promise<Record<string, unknown>> {
      await vi.waitFor(() => {
        expect(frames.length).toBeGreaterThan(0);
      });
      return frames.shift()!;
    },
  };
}

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
    const client = rpcClient(socketPath);
    try {
      client.send({
        type: 'http.req',
        id: 'req-1',
        method: 'POST',
        path: '/api/v1/echo',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ ping: 1 })).toString('base64'),
      });
      const httpRes = await client.next();
      expect(httpRes['type']).toBe('http.res');
      expect(httpRes['status']).toBe(200);
      expect(JSON.parse(Buffer.from(httpRes['body'] as string, 'base64').toString('utf8'))).toEqual({
        body: { ping: 1 },
        host: '127.0.0.1',
      });

      client.send({ type: 'ws.open', id: 'ws-1', path: '/api/v1/ws' });
      client.send({ type: 'ws.msg', id: 'ws-1', data: 'hi' });
      expect(await client.next()).toEqual({ type: 'ws.msg', id: 'ws-1', data: 'ack:hi' });
    } finally {
      client.socket.destroy();
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
    const client = rpcClient(join(dir, 'daemon.sock'));
    try {
      client.send({ type: 'http.req', id: 'cancel', method: 'GET', path: '/held', headers: {} });
      await requestStarted;
      client.send({ type: 'http.cancel', id: 'cancel' });
      client.send({ type: 'http.req', id: 'next', method: 'GET', path: '/next', headers: {} });
      await vi.waitFor(() => expect(client.frames.some((frame) => frame['id'] === 'next')).toBe(true));
      await sleep(150);
      expect(client.frames.some((frame) => frame['id'] === 'cancel')).toBe(false);
    } finally {
      client.socket.destroy();
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
    const client = rpcClient(join(dir, 'daemon.sock'));
    try {
      client.send({ type: 'http.req', id: 'large', method: 'GET', path: '/large', headers: {} });
      expect((await client.next())['status']).toBe(413);
    } finally {
      client.socket.destroy();
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
