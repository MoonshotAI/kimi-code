import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import { createConnection } from 'node:net';
import { Duplex, duplexPair, PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import Fastify from 'fastify';
import { FileTokenStorage, KIMI_CODE_PROVIDER_NAME, KIMI_REGION_MARKER_FILENAME } from '@moonshot-ai/kimi-code-oauth';
import {
  IClientIdentity,
  IConfigService,
  IOAuthService,
  ISessionMetadata,
  getLiveSessionById,
  accountDeviceEntrySchema,
  deviceIdSchema,
  devicesSectionSchema,
  type DeviceEntry,
} from '@moonshot-ai/agent-core-v2';
import { RemoteControlLoginRequiredError, type RemoteControlDevice } from '@moonshot-ai/remote-control';
import { describe, expect, it, vi } from 'vitest';
import WebSocketClient, { WebSocketServer, type RawData, type WebSocket as NodeWebSocket } from 'ws';

import { AccountDeviceBridge } from '../src/services/devices/accountDeviceBridge';
import { DeviceConnectError, DeviceUpgradeInProgressError, type RemoteDeviceIdentity } from '../src/services/devices/deviceBridge';
import { DEVICE_API_LEVEL, DEVICE_PROTOCOL_VERSION } from '../src/services/devices/deviceProtocol';
import { matchDeviceProxyPath, proxyDeviceWebSocket, registerDeviceProxyRoutes, upstreamHeaders } from '../src/services/devices/deviceProxy';
import { DeviceManager, deviceSources, toDeviceSnapshot } from '../src/services/devices/deviceManager';
import { deviceWireSchema, sshDeviceWireSchema } from '../src/services/devices/devicesConfig';
import { DeviceRequestError, type DeviceHttpRequest, type DeviceHttpResponse, type DeviceSession } from '../src/services/devices/deviceSession';
import { SERVER_UPGRADED_CLOSE_CODE, type HostCommandResult } from '../src/services/devices/deviceUpgrade';
import { RelayDeviceSession, relayRequestHeaders } from '../src/services/devices/relayDeviceSession';
import { StdioDeviceSession } from '../src/services/devices/stdioDeviceSession';
import { JsonlRpcStream, RPC_BACKPRESSURE_TIMEOUT_MS } from '../src/transport/jsonlRpcStream';
import { startServer, type RunningServer, type ServerHostIdentity, type ServerStartOptions } from '../src/start';
import { CLIENT_IDENTITY_HEADER, encodeClientIdentityHeader } from '../src/protocol/clientIdentity';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import {
  SshDeviceBridge,
  classifySshFailure,
  checkBootstrapOutput,
  remoteBinCommand,
  remoteKimiCommand,
  remoteUpgradeCommand,
} from '../src/services/devices/sshDeviceBridge';
import {
  attachRpcStream,
  DEVICE_RPC_MAX_BODY_BYTES,
  startUnixRpcServer,
} from '../src/transport/stdioRpc';

const SSH_REMOTE_META = { server_version: '1.2.3', product: 'kimi-code-cli', device_id: 'ssh-remote', device_api_level: DEVICE_API_LEVEL };

const LOCAL_HOST_IDENTITY: ServerHostIdentity = {
  productName: 'local-desktop',
  version: '9.8.7',
  platform: 'local_desktop_platform',
  displayName: 'Local Desktop',
  replyStyleGuide: 'Replies render in the local desktop chat.',
};

const LOCAL_CLIENT_IDENTITY_HEADER = encodeClientIdentityHeader({
  ...LOCAL_HOST_IDENTITY,
  uiCapabilities: ['update_panel'],
});

function metaFrame(id: string, meta: Record<string, unknown> = SSH_REMOTE_META): string {
  const body = Buffer.from(JSON.stringify({ code: 0, msg: 'success', data: meta, request_id: 'meta' })).toString('base64');
  return JSON.stringify({ type: 'http.res', id, status: 200, headers: { 'content-type': 'application/json' }, body });
}

const ANSWER_META = `read line\necho '${metaFrame('1')}'`;

function thrown(run: () => unknown): DeviceConnectError {
  try {
    run();
  } catch (error) {
    if (error instanceof DeviceConnectError) return error;
    throw error;
  }
  throw new Error('expected a DeviceConnectError');
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

describe('device proxy path', () => {
  it('splits the device id from the upstream path and keeps the query', () => {
    expect(matchDeviceProxyPath('/api/v1/devices/dev/proxy/api/v1/sessions?limit=1')).toEqual({
      deviceId: 'dev',
      path: '/api/v1/sessions?limit=1',
    });
    expect(matchDeviceProxyPath('/api/v1/devices/dev/proxy')).toEqual({ deviceId: 'dev', path: '/' });
  });

  it('does not match control-plane routes', () => {
    expect(matchDeviceProxyPath('/api/v1/devices')).toBeUndefined();
    expect(matchDeviceProxyPath('/api/v1/devices/dev/projects')).toBeUndefined();
  });

  it('decodes the device id and rejects a malformed percent-encoding', () => {
    expect(matchDeviceProxyPath('/api/v1/devices/dev%2Dbox/proxy')).toEqual({ deviceId: 'dev-box', path: '/' });
    expect(matchDeviceProxyPath('/api/v1/devices/%E0%A4%A/proxy')).toBeUndefined();
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

describe('device configuration', () => {
  it('accepts an alias entry and rejects unknown fields or option-like hosts', () => {
    expect(devicesSectionSchema.safeParse({ dev: { host: 'dev-box', identityFile: '~/.ssh/key' } }).success).toBe(true);
    expect(devicesSectionSchema.safeParse({ dev: { host: 'dev-box', type: 'ssh' } }).success).toBe(false);
    expect(devicesSectionSchema.safeParse({ dev: { host: '-oProxyCommand=x' } }).success).toBe(false);
  });

  it('accepts account entries without SSH fields and keeps SSH as the default connection', () => {
    expect(devicesSectionSchema.safeParse({
      ssh: { connection: 'ssh', host: 'dev-box' },
      'a1b2c3d4-0000-4000-8000-000000000001': { connection: 'account', name: 'Laptop', enabled: false },
    }).success).toBe(true);
    expect(accountDeviceEntrySchema.safeParse({ connection: 'account', host: 'dev-box' }).success).toBe(false);
    expect(devicesSectionSchema.safeParse({ dev: { connection: 'account', remoteBin: 'kimi' } }).success).toBe(false);
    expect(devicesSectionSchema.safeParse({ dev: { connection: 'tunnel', host: 'dev-box' } }).success).toBe(false);
  });

  it('maps the wire entry to the config entry through one schema', () => {
    expect(deviceWireSchema.parse({ host: 'dev-box', identity_file: '~/.ssh/key', remote_bin: 'kimi' })).toEqual({
      host: 'dev-box',
      identityFile: '~/.ssh/key',
      remoteBin: 'kimi',
    });
    expect(deviceWireSchema.parse({ connection: 'account', name: 'Laptop' })).toEqual({ connection: 'account', name: 'Laptop' });
    expect(deviceWireSchema.safeParse({ connection: 'account', identity_file: '~/.ssh/key' }).success).toBe(false);
    expect(sshDeviceWireSchema.safeParse({ connection: 'account' }).success).toBe(false);
  });

  it('keeps device ids safe for URL path segments', () => {
    expect(deviceIdSchema.safeParse('dev_box-1.example').success).toBe(true);
    expect(deviceIdSchema.safeParse('a/b').success).toBe(false);
    expect(deviceIdSchema.safeParse('').success).toBe(false);
  });

  it('moves SSH hosts saved by earlier releases into devices and keeps an existing device on an id clash', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-legacy-hosts-'));
    const configPath = join(home, 'config.toml');
    writeFileSync(configPath, [
      'default_model = ""',
      '',
      '[hosts.gpu_box]',
      'host = "gpu.example.test"',
      'identity_file = "~/.ssh/id_gpu"',
      'enabled = false',
      '',
      '[hosts.shared]',
      'host = "old.example.test"',
      '',
      '[devices.shared]',
      'host = "new.example.test"',
      '',
    ].join('\n'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    try {
      await vi.waitFor(() => expect(readFileSync(configPath, 'utf8')).not.toContain('[hosts'));
      const devices = (await call(server, 'GET', '/api/v1/devices')).data['devices'] as Array<Record<string, unknown>>;
      expect(devices).toHaveLength(2);
      expect(devices).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'shared', host: 'new.example.test' }),
        expect.objectContaining({ id: 'gpu_box', host: 'gpu.example.test', identity_file: '~/.ssh/id_gpu', enabled: false }),
      ]));
      const text = readFileSync(configPath, 'utf8');
      expect(text).toContain('[devices.gpu_box]');
      expect(text).toContain('identity_file = "~/.ssh/id_gpu"');
      expect(text).not.toContain('old.example.test');
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ssh bootstrap', () => {
  it('quotes the remote binary while keeping home expansion', () => {
    expect(remoteBinCommand(undefined)).toBe(`"$HOME"/'.kimi-code/bin/kimi'`);
    expect(remoteBinCommand('kimi')).toBe('kimi');
    expect(remoteBinCommand('/opt/my kimi')).toBe(`'/opt/my kimi'`);
    expect(remoteKimiCommand('kimi', 'server ensure-daemon')).toBe('kimi --version; kimi server ensure-daemon');
    expect(remoteUpgradeCommand(undefined)).toBe(`"$HOME"/'.kimi-code/bin/kimi' upgrade --yes && "$HOME"/'.kimi-code/bin/kimi' --version`);
  });

  it('finds the marker line among shell startup noise', () => {
    const stdout = `welcome\n1.0.0\n__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.0.0"}\n`;
    expect(checkBootstrapOutput(stdout)).toBe(true);
    expect(checkBootstrapOutput('command output without a marker\n')).toBe(false);
  });

  it('reports a remote below the device protocol as outdated with its version', () => {
    const error = thrown(() =>
      checkBootstrapOutput('__KIMI_ENSURE_DAEMON__{"version":"0.40.0"}\n'),
    );
    expect(error.failure).toBe('outdated');
    expect(error.remoteVersion).toBe('0.40.0');
    expect(error.message).toContain('kimi upgrade');
    expect(thrown(() => checkBootstrapOutput('0.40.0\n__KIMI_ENSURE_DAEMON__{"protocol":0}\n')).remoteVersion).toBe('0.40.0');
  });

  it('reports a remote below the device API level as outdated and accepts a newer one', () => {
    const marker = (apiLevel: number | undefined): string =>
      `__KIMI_ENSURE_DAEMON__${JSON.stringify({ protocol: DEVICE_PROTOCOL_VERSION, api_level: apiLevel, version: '2.5.2' })}\n`;
    for (const apiLevel of [undefined, DEVICE_API_LEVEL - 1]) {
      const error = thrown(() => checkBootstrapOutput(marker(apiLevel)));
      expect(error.failure).toBe('outdated');
      expect(error.remoteVersion).toBe('2.5.2');
      expect(error.message).toContain('kimi upgrade');
    }
    expect(checkBootstrapOutput(marker(DEVICE_API_LEVEL + 1))).toBe(true);
  });

  it.each([
    ['version_mismatch_busy', 'remote_busy'],
    ['start_timeout', 'remote_start_failed'],
    ['lock_timeout', 'remote_start_failed'],
    ['something_new', 'unknown'],
  ] as const)('maps the ensure-daemon error %s to %s', (code, failure) => {
    const stdout = `__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"2.0.0","error":"${code}","message":"m"}\n`;
    const error = thrown(() => checkBootstrapOutput(stdout));
    expect(error.failure).toBe(failure);
    expect(error.remoteVersion).toBe('2.0.0');
  });

  it('accepts a probe with a supported protocol and API level', () => {
    expect(checkBootstrapOutput(`__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"2.0.0"}\n`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reports an older kimi without the probe as outdated with its version', () =>
    withFakeSsh("#!/bin/sh\necho 'motd line'\necho '0.40.0'\necho \"error: unknown option '--probe'\" >&2\nexit 1\n", async (ssh) => {
      const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
      const error = await bridge.probe().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(DeviceConnectError);
      expect((error as DeviceConnectError).failure).toBe('outdated');
      expect((error as DeviceConnectError).remoteVersion).toBe('0.40.0');
    }),
  );

  it.each([
    ['ssh: Could not resolve hostname dev: Name or service not known', 255, 'host_not_found'],
    ['ssh: connect to host dev port 22: Connection refused', 255, 'connection_refused'],
    ['ssh: connect to host dev port 22: Operation timed out', 255, 'connect_timeout'],
    ['user@dev: Permission denied (publickey).', 255, 'authentication_failed'],
    ['Host key verification failed.', 255, 'host_key_changed'],
    ['bash: kimi: command not found', 127, 'executor_not_found'],
    ["error: unknown command 'ensure-daemon'", 1, 'outdated'],
    ['`kimi server` has been deprecated and no longer works.', 1, 'outdated'],
    ["error: unknown command 'web'. See 'kimi --help'.", 1, 'outdated'],
    ["error: too many arguments for 'web'. Expected 0 arguments but got 1.", 1, 'outdated'],
    ["error: unknown option '--probe'", 1, 'outdated'],
    ['something else', 1, 'unknown'],
  ] as const)('classifies %s', (stderr, code, failure) => {
    expect(classifySshFailure(stderr, code)).toBe(failure);
  });

  it.skipIf(process.platform === 'win32')('connects to a device whose released server predates device identity and leaves its identity unknown', () =>
    withFakeSsh(
      `#!/bin/sh
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}'
read line
echo '${metaFrame('1', { server_version: '1.2.3' })}'
while IFS= read -r line; do :; done
`,
      async (ssh) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          await expect(bridge.connect()).resolves.toBeDefined();
          expect(bridge.status).toBe('ready');
          expect(bridge.failure).toBeUndefined();
          expect(bridge.remoteVersion).toBe('1.2.3');
          expect(bridge.identity).toBeUndefined();
          expect(toDeviceSnapshot({ id: 'dev', entry: { host: 'dev' }, bridge })).toMatchObject({ status: 'ready', device_id: undefined });
        } finally {
          bridge.dispose();
        }
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('kills a bootstrap ssh when disposed before it finishes', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh\necho $$ > '${join(dir, 'pid')}'\nexec sleep 30\n`,
      async (ssh, dir) => {
        const pidfile = join(dir, 'pid');
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
        const pending = bridge.connect();
        let pid = 0;
        await vi.waitFor(() => {
          pid = Number.parseInt(readFileSync(pidfile, 'utf8'), 10);
          expect(pid).toBeGreaterThan(0);
        });
        bridge.dispose();
        await expect(pending).rejects.toBeInstanceOf(DeviceConnectError);
        expect(() => process.kill(pid, 0)).toThrow();
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('continues after an unmatched frame in the same stdout chunk as the marker', () =>
    withFakeSsh(
      `#!/bin/sh
printf '__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}\\n{"type":"http.res","id":"early","status":200,"headers":{},"body":"e30="}\\n'
${ANSWER_META}
read line
printf '{"type":"http.res","id":"2","status":200,"headers":{},"body":"e30="}\\n'
`,
      async (ssh) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
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
const output = Buffer.from(${JSON.stringify(`__KIMI_ENSURE_DAEMON__${JSON.stringify({ protocol: DEVICE_PROTOCOL_VERSION, api_level: DEVICE_API_LEVEL, version: '版本1.2.3' })}\n`)});
const split = output.indexOf(Buffer.from('版本')) + 1;
process.stdout.write(output.subarray(0, split));
setImmediate(() => {
  process.stdout.write(output.subarray(split));
});
let requests = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
  requests += 1;
  process.stdout.write((requests === 1 ? ${JSON.stringify(metaFrame('1'))} : JSON.stringify(${JSON.stringify({ type: 'ws.msg', id: '2', data: '你好' })})) + '\\n');
});
`,
      async (ssh) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          const session = await bridge.connect();
          expect(session).toBeDefined();
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
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}'
${ANSWER_META}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed 's/.*"id":"\\([^"]*\\)".*/\\1/')
  case "$line" in
    *'"type":"http.req"'*)
      body=$(printf '{"ok":true}' | base64 | tr -d '\\n')
      echo "{\\"type\\":\\"http.res\\",\\"id\\":\\"$id\\",\\"status\\":200,\\"headers\\":{\\"content-type\\":\\"application/json\\"},\\"body\\":\\"$body\\"}"
      ;;
    *'"type":"ws.open"'*)
      echo "{\\"type\\":\\"ws.msg\\",\\"id\\":\\"$id\\",\\"data\\":\\"hello\\"}"
      exit 0
      ;;
  esac
done
`,
      async (ssh, dir) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          const session = await bridge.connect();
          expect(bridge.status).toBe('ready');
          expect(bridge.remoteVersion).toBe('1.2.3');
          expect(bridge.identity).toEqual({ deviceId: 'ssh-remote', productName: 'kimi-code-cli' } satisfies RemoteDeviceIdentity);
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
          expect(reconnected).toBeDefined();
          expect(readFileSync(join(dir, 'count'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
        } finally {
          bridge.dispose();
        }
      },
    ),
  );

  it.skipIf(process.platform === 'win32')('keeps retrying with backoff after an abnormal exit until the device is reachable again', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
echo x >> '${join(dir, 'count')}'
attempt=$(wc -l < '${join(dir, 'count')}' | tr -d ' ')
if [ "$attempt" = 2 ]; then
  echo 'ssh: connect to host dev port 22: Connection refused' >&2
  exit 255
fi
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}'
${ANSWER_META}
if [ "$attempt" = 1 ]; then exit 1; fi
while IFS= read -r line; do :; done
`,
      async (ssh, dir) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
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

  it.skipIf(process.platform === 'win32')('keeps retrying in the background after an initial or explicit connect fails', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
if [ -e '${join(dir, 'down')}' ]; then
  echo 'ssh: connect to host dev port 22: Connection refused' >&2
  exit 255
fi
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}'
${ANSWER_META}
while IFS= read -r line; do :; done
`,
      async (ssh, dir) => {
        const down = join(dir, 'down');
        writeFileSync(down, '');
        const states: { status: string; failure?: string; error?: string }[] = [];
        let refused: string | undefined;
        const bridge = new SshDeviceBridge({ host: 'dev' }, {
          sshProgram: ssh,
          onChange: () => {
            states.push({ status: bridge.status, failure: bridge.failure, error: bridge.error });
            if (bridge.failure === 'connection_refused') refused = bridge.error;
          },
        });
        try {
          bridge.start();
          await vi.waitFor(
            () => {
              expect(states).toContainEqual({ status: 'connecting', failure: 'connection_refused', error: refused });
            },
            { timeout: 3_000, interval: 20 },
          );
          await expect(bridge.connect()).rejects.toBeInstanceOf(DeviceConnectError);
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
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
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

function bootstrapLine(version: string, extra: Record<string, string> = {}): string {
  return `__KIMI_ENSURE_DAEMON__${JSON.stringify({ protocol: DEVICE_PROTOCOL_VERSION, api_level: DEVICE_API_LEVEL, version, ...extra })}`;
}

describe('ssh device upgrade', () => {
  it.skipIf(process.platform === 'win32')('upgrades an outdated device over ssh and reconnects once its background server runs the new version', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
for last; do :; done
printf '%s\\n' "$last" >> '${join(dir, 'commands')}'
case "$last" in
  *'upgrade --yes'*)
    printf '%s\\n' "$@" > '${join(dir, 'upgrade-args')}'
    touch '${join(dir, 'upgraded')}'
    echo 'Updated @moonshot-ai/kimi-code to 2.0.0. Restart the CLI to use the new version.'
    echo '2.0.0'
    exit 0
    ;;
esac
if [ ! -e '${join(dir, 'upgraded')}' ]; then
  echo '1.0.0'
  echo "error: unknown command 'ensure-daemon'" >&2
  exit 1
fi
if [ ! -e '${join(dir, 'busy')}' ]; then
  touch '${join(dir, 'busy')}'
  echo '${bootstrapLine('2.0.0', { error: 'version_mismatch_busy', message: 'a kimi server of version 1.0.0 is still running work on this device' })}'
  exit 1
fi
echo '${bootstrapLine('2.0.0')}'
read line
echo '${metaFrame('1', { ...SSH_REMOTE_META, server_version: '2.0.0' })}'
while IFS= read -r line; do :; done
`,
      async (ssh, dir) => {
        const busyUpgradeStates: Array<string | undefined> = [];
        const bridge: SshDeviceBridge = new SshDeviceBridge(
          { host: 'dev', identityFile: '/keys/dev' },
          {
            sshProgram: ssh,
            onChange: () => {
              if (bridge.failure === 'remote_busy') busyUpgradeStates.push(bridge.upgradeState?.status);
            },
          },
        );
        try {
          await expect(bridge.connect()).rejects.toMatchObject({ failure: 'outdated', remoteVersion: '1.0.0' });
          await expect(bridge.upgrade()).resolves.toEqual({ status: 'started' });
          expect(bridge.upgradeState).toEqual({ status: 'installing' });
          await expect(bridge.upgrade()).rejects.toBeInstanceOf(DeviceUpgradeInProgressError);
          await vi.waitFor(
            () => {
              expect(bridge.status).toBe('ready');
              expect(bridge.upgradeState).toBeUndefined();
            },
            { timeout: 10_000, interval: 50 },
          );
          expect(bridge.remoteVersion).toBe('2.0.0');
          expect(bridge.session).toBeDefined();
          expect(busyUpgradeStates).toContain('restarting');
          expect(readFileSync(join(dir, 'upgrade-args'), 'utf8').trimEnd().split('\n')).toEqual([
            '-T',
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=10',
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-i', '/keys/dev',
            '-o', 'IdentitiesOnly=yes',
            'dev',
            remoteUpgradeCommand(undefined),
          ]);
          const bootstrap = remoteKimiCommand(undefined, 'server ensure-daemon');
          expect(readFileSync(join(dir, 'commands'), 'utf8').trimEnd().split('\n')).toEqual([
            bootstrap,
            remoteUpgradeCommand(undefined),
            bootstrap,
            bootstrap,
          ]);
        } finally {
          bridge.dispose();
        }
      },
    ),
  15_000);

  it.skipIf(process.platform === 'win32')('reports a failed or already-current upgrade without dropping the connection, until the device comes back on another version', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
for last; do :; done
case "$last" in
  *'upgrade --yes'*)
    if [ ! -e '${join(dir, 'failed-once')}' ]; then
      touch '${join(dir, 'failed-once')}'
      echo 'Checking for updates'
      echo 'error: failed to check for updates: fetch failed' >&2
      exit 1
    fi
    echo 'Kimi Code is already up to date (v1.2.3).'
    echo '1.2.3'
    exit 0
    ;;
esac
echo x >> '${join(dir, 'bootstraps')}'
if [ -e '${join(dir, 'newer')}' ]; then
  echo '${bootstrapLine('1.3.0')}'
  read line
  echo '${metaFrame('1', { ...SSH_REMOTE_META, server_version: '1.3.0' })}'
  while IFS= read -r line; do :; done
  exit 0
fi
echo '${bootstrapLine('1.2.3')}'
${ANSWER_META}
while [ ! -e '${join(dir, 'newer')}' ]; do sleep 0.05; done
exit 1
`,
      async (ssh, dir) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          const session = await bridge.connect();
          await expect(bridge.upgrade()).resolves.toEqual({ status: 'started' });
          await vi.waitFor(() => {
            expect(bridge.upgradeState).toEqual({ status: 'failed', error: 'error: failed to check for updates: fetch failed' });
          });
          await expect(bridge.upgrade()).resolves.toEqual({ status: 'started' });
          await vi.waitFor(() => {
            expect(bridge.upgradeState).toEqual({ status: 'failed', error: 'Kimi Code is already up to date (v1.2.3).' });
          });
          expect(bridge.status).toBe('ready');
          expect(bridge.session).toBe(session);
          expect(readFileSync(join(dir, 'bootstraps'), 'utf8').trim().split('\n')).toHaveLength(1);

          writeFileSync(join(dir, 'newer'), '');
          await vi.waitFor(
            () => {
              expect(bridge.status).toBe('ready');
              expect(bridge.remoteVersion).toBe('1.3.0');
              expect(bridge.upgradeState).toBeUndefined();
            },
            { timeout: 10_000, interval: 50 },
          );
        } finally {
          bridge.dispose();
        }
      },
    ),
  15_000);

  it.skipIf(process.platform === 'win32')('gives up after the upgrade timeout while the old server stays busy, and clears the failure once the device comes back upgraded', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
for last; do :; done
case "$last" in
  *'upgrade --yes'*)
    touch '${join(dir, 'upgraded')}'
    echo '2.0.0'
    exit 0
    ;;
esac
if [ ! -e '${join(dir, 'upgraded')}' ]; then
  echo '1.2.3'
  echo "error: unknown command 'ensure-daemon'" >&2
  exit 1
fi
if [ ! -e '${join(dir, 'free')}' ]; then
  echo '${bootstrapLine('2.0.0', { error: 'version_mismatch_busy', message: 'a kimi server of version 1.2.3 is still running work on this device' })}'
  exit 1
fi
echo '${bootstrapLine('2.0.0')}'
read line
echo '${metaFrame('1', { ...SSH_REMOTE_META, server_version: '2.0.0' })}'
while IFS= read -r line; do :; done
`,
      async (ssh, dir) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh, upgradeTimeoutMs: 500 });
        try {
          await expect(bridge.connect()).rejects.toMatchObject({ failure: 'outdated', remoteVersion: '1.2.3' });
          await expect(bridge.upgrade()).resolves.toEqual({ status: 'started' });
          await vi.waitFor(
            () => {
              expect(bridge.upgradeState).toEqual({
                status: 'failed',
                error: 'the device did not come back on a new Kimi Code version within 1 second; check Kimi Code on that device',
              });
            },
            { timeout: 5_000, interval: 50 },
          );
          expect(bridge.failure).toBe('remote_busy');

          writeFileSync(join(dir, 'free'), '');
          await vi.waitFor(
            () => {
              expect(bridge.status).toBe('ready');
              expect(bridge.remoteVersion).toBe('2.0.0');
              expect(bridge.upgradeState).toBeUndefined();
            },
            { timeout: 10_000, interval: 50 },
          );
        } finally {
          bridge.dispose();
        }
      },
    ),
  15_000);

  it.skipIf(process.platform === 'win32')('starts an upgrade through POST /api/v1/devices:upgrade, rejects a concurrent one, and reports progress in the device list', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
for last; do :; done
case "$last" in
  *'upgrade --yes'*)
    while [ ! -e '${join(dir, 'release')}' ]; do sleep 0.05; done
    touch '${join(dir, 'upgraded')}'
    echo '2.0.0'
    exit 0
    ;;
esac
if [ -e '${join(dir, 'upgraded')}' ]; then
  echo '${bootstrapLine('2.0.0')}'
  read line
  echo '${metaFrame('1', { ...SSH_REMOTE_META, server_version: '2.0.0' })}'
else
  echo '${bootstrapLine('1.2.3')}'
  read line
  echo '${metaFrame('1')}'
fi
while IFS= read -r line; do :; done
`,
      async (_ssh, dir) => {
        vi.stubEnv('PATH', `${dir}${delimiter}${process.env['PATH'] ?? ''}`);
        const home = await mkdtemp(join(tmpdir(), 'kimi-device-upgrade-'));
        const server = await startServer({
          hostIdentity: TEST_HOST_IDENTITY,
          host: '127.0.0.1',
          port: 0,
          homeDir: home,
          logLevel: 'silent',
          env: { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' },
        });
        const devices = async () => (await call(server, 'GET', '/api/v1/devices')).data['devices'] as Array<Record<string, unknown>>;
        try {
          expect(await call(server, 'PUT', '/api/v1/devices/dev', { host: 'dev.example.test' })).toMatchObject({ code: 0 });
          expect(await call(server, 'POST', '/api/v1/devices:connect', { id: 'dev' })).toMatchObject({
            data: { status: 'ready', remote_version: '1.2.3', install: 'cli', remote_upgrade: true },
          });
          expect(await call(server, 'POST', '/api/v1/devices:upgrade', { id: 'dev' })).toMatchObject({ code: 0, data: { status: 'started' } });
          expect(await call(server, 'POST', '/api/v1/devices:upgrade', { id: 'dev' })).toMatchObject({
            code: 40960,
            msg: 'device "dev" is already being upgraded',
          });
          expect(await call(server, 'POST', '/api/v1/devices:upgrade', { id: 'missing' })).toMatchObject({ code: 40420 });
          expect(await devices()).toMatchObject([{ id: 'dev', upgrade_status: 'installing' }]);
          writeFileSync(join(dir, 'release'), '');
          await vi.waitFor(
            async () => {
              const [device] = await devices();
              expect(device).toMatchObject({ status: 'ready', remote_version: '2.0.0' });
              expect(device).not.toHaveProperty('upgrade_status');
            },
            { timeout: 10_000, interval: 100 },
          );
        } finally {
          await server.close();
          await rm(home, { recursive: true, force: true });
          vi.unstubAllEnvs();
        }
      },
    ),
  20_000);
});

describe('device auto-connect', () => {
  function managerWith(section: Record<string, DeviceEntry>) {
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
    const manager = new DeviceManager(core as never, {
      relay: { relayAccess: vi.fn(), listDevices: vi.fn() },
      localDeviceId: 'local-device',
    });
    return { manager, changeDevices: () => listener?.({ domain: 'devices' }) };
  }

  it('connects enabled devices once a client has connected, including devices added later', async () => {
    const started: string[] = [];
    const start = vi.spyOn(SshDeviceBridge.prototype, 'start').mockImplementation(function (this: SshDeviceBridge) {
      started.push((this as unknown as { entry: { host: string } }).entry.host);
    });
    const section: Record<string, { host: string; enabled?: boolean }> = {
      dev: { host: 'dev-box' },
      off: { host: 'off-box', enabled: false },
    };
    const { manager, changeDevices } = managerWith(section);
    try {
      changeDevices();
      expect(started).toEqual([]);
      manager.activate();
      manager.activate();
      await vi.waitFor(() => {
        expect(started).toEqual(['dev-box']);
      });
      section['added'] = { host: 'added-box' };
      changeDevices();
      expect(started).toEqual(['dev-box', 'added-box']);
      section['off'] = { host: 'off-box' };
      changeDevices();
      expect(started).toEqual(['dev-box', 'added-box', 'off-box']);
    } finally {
      start.mockRestore();
      manager.close();
    }
  });

  it('reports this computer as self and never starts or proxies it', async () => {
    const sshStart = vi.spyOn(SshDeviceBridge.prototype, 'start').mockImplementation(() => {});
    const accountStart = vi.spyOn(AccountDeviceBridge.prototype, 'start').mockImplementation(() => {});
    const { manager } = managerWith({ 'local-device': { connection: 'account', name: 'Here' }, dev: { host: 'dev-box' } });
    try {
      manager.activate();
      await vi.waitFor(() => expect(sshStart).toHaveBeenCalledOnce());
      expect(accountStart).not.toHaveBeenCalled();
      expect(manager.list().map((info) => toDeviceSnapshot(info))).toEqual([
        {
          id: 'local-device',
          connection: 'account',
          name: 'Here',
          status: 'disconnected',
          connect_error: 'device "local-device" is this computer',
          connect_failure: 'self',
          device_id: 'local-device',
        },
        { id: 'dev', connection: 'ssh', host: 'dev-box', status: 'pending', install: 'cli', remote_upgrade: true },
      ]);
      expect(manager.session('local-device')).toBeUndefined();
      await expect(manager.connect('local-device')).rejects.toMatchObject({ failure: 'self' });
      expect(deviceSources(manager).sources().map((source) => source.id)).toEqual(['dev']);
    } finally {
      vi.restoreAllMocks();
      manager.close();
    }
  });
});

describe('device HTTP session', () => {
  it('rejects a pending request when the transport closes', async () => {
    let stream: Duplex;
    stream = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        Duplex.prototype.write.call(stream, chunk, encoding, callback);
      },
    });
    const session = new StdioDeviceSession(stream);
    const pending = session.request({ method: 'GET', path: '/held', headers: {} });
    stream.destroy();
    await expect(pending).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('cancels a timed out request and ignores its late response', () =>
    withFakeSsh(
      (dir) => `#!/bin/sh
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}'
${ANSWER_META}
while IFS= read -r line; do
  case "$line" in
    *'"type":"http.cancel"'*)
      echo "$line" > '${join(dir, 'cancel')}'
      echo '{"type":"http.res","id":"2","status":200,"headers":{}}'
      ;;
  esac
done
`,
      async (ssh, dir) => {
        const bridge = new SshDeviceBridge({ host: 'dev' }, { sshProgram: ssh });
        try {
          const session = await bridge.connect();
          const request = session.request({
            method: 'GET', path: '/held', headers: {}, timeoutMs: 10,
          });
          await expect(request).rejects.toThrow('device request timed out');
          await vi.waitFor(() => expect(readFileSync(join(dir, 'cancel'), 'utf8')).toContain('"type":"http.cancel"'));
        } finally {
          bridge.dispose();
        }
      },
    ),
  );
});

describe('device WebSocket backpressure', () => {

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
      void proxyDeviceWebSocket({ session: () => session } as never, { deviceId: 'dev', path: '/api/v1/ws' }, req, upgradeSocket, head);
    });
    const ws = new WebSocketClient(`ws://127.0.0.1:${address.port}/api/v1/devices/dev/proxy/api/v1/ws`);
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
    const body = Buffer.alloc(DEVICE_RPC_MAX_BODY_BYTES).toString('base64');
    rpc.write({ type: 'http.res', body });
    expect(stream.destroyed).toBe(false);
    for (let frame = 0; frame < 3; frame += 1) rpc.write({ type: 'http.res', body });
    expect(stream.destroyed).toBe(true);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ name: 'RpcBackpressureError' })));
  });
});

describe('device management routes', () => {
  it('tests, creates, updates and removes devices through the real HTTP API', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-devices-routes-'));
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const probe = vi.spyOn(SshDeviceBridge.prototype, 'probe').mockResolvedValue(undefined);
    const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${server.authTokenService.getToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      const tested = await request('POST', '/api/v1/devices:test', { host: 'dev@example.test' });
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({ code: 0, data: { connected: true } });
      const accountTest = await request('POST', '/api/v1/devices:test', { connection: 'account' });
      expect(await accountTest.json()).toMatchObject({ code: 40001 });
      expect(probe).toHaveBeenCalledOnce();
      const created = await request('PUT', '/api/v1/devices/dev', { host: 'dev@example.test', name: 'Dev' });
      expect(created.status).toBe(200);
      await request('PUT', '/api/v1/devices/other', { host: 'other.example.test' });
      const updated = await request('PUT', '/api/v1/devices/dev', { host: 'new.example.test', enabled: false });
      expect(updated.status).toBe(200);
      const connected = await request('POST', '/api/v1/devices:connect', { id: 'dev' });
      expect(await connected.json()).toMatchObject({ data: { id: 'dev', enabled: false, status: 'disconnected' } });
      const listed = await request('GET', '/api/v1/devices');
      expect(await listed.json()).toMatchObject({ data: { devices: [
        { id: 'dev', host: 'new.example.test', enabled: false, status: 'disconnected' },
        { id: 'other', host: 'other.example.test' },
      ] } });
      expect((await request('DELETE', '/api/v1/devices/dev')).status).toBe(200);
      const remaining = await request('GET', '/api/v1/devices');
      expect(await remaining.json()).toEqual({
        code: 0,
        msg: 'success',
        data: { devices: [{ id: 'other', connection: 'ssh', host: 'other.example.test', status: 'pending', install: 'cli', remote_upgrade: true }] },
        request_id: expect.any(String),
      });
    } finally {
      vi.restoreAllMocks();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('device aggregation after idle exit', () => {
  it.skipIf(process.platform === 'win32').each([false, true])(
    'uses one on-demand SSH connection for concurrent listings (slow startup: %s)',
    (slow) => withFakeSsh(
      (dir) => `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const count = ${JSON.stringify(join(dir, 'count'))};
const waking = existsSync(count);
appendFileSync(count, 'x');
const meta = ${JSON.stringify(Buffer.from(JSON.stringify({ code: 0, msg: 'success', data: SSH_REMOTE_META })).toString('base64'))};
async function serve() {
  while (waking && existsSync(${JSON.stringify(join(dir, 'hold'))})) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.log('__KIMI_ENSURE_DAEMON__{"protocol":${String(DEVICE_PROTOCOL_VERSION)},"api_level":${String(DEVICE_API_LEVEL)},"version":"1.2.3"}');
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (frame.path === '/api/v1/meta') {
      console.log(JSON.stringify({ type: 'http.res', id: frame.id, status: 200, headers: {}, body: meta }));
      continue;
    }
    if (!waking) process.exit(0);
    const items = frame.path === '/api/v1/workspaces' ? [{
      id: 'wm_00000000-0000-4000-8000-000000000001', kind: 'managed', root: '/srv/example',
      name: 'example', additional_dirs: [], created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z', session_count: 0,
    }] : [];
    const body = Buffer.from(JSON.stringify({ code: 0, data: { items, total: items.length, has_more: false } })).toString('base64');
    console.log(JSON.stringify({ type: 'http.res', id: frame.id, status: 200, headers: {}, body }));
  }
}
void serve();
`,
      async (ssh, dir) => {
        const entry = { host: 'example.test' };
        const bridge = new SshDeviceBridge(entry, { sshProgram: ssh });
        const hold = join(dir, 'hold');
        if (slow) writeFileSync(hold, '');
        const server = await startServer({
          hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: dir, logLevel: 'silent',
        });
        const list = vi.spyOn(server.deviceManager, 'list').mockReturnValue([{ id: 'example', entry, bridge }]);
        const get = async (path: string): Promise<unknown> => {
          const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
            headers: { authorization: `Bearer ${server.authTokenService.getToken()}` },
            signal: AbortSignal.timeout(5000),
          });
          return response.json();
        };
        try {
          const session = await bridge.connect();
          await expect(session.request({ method: 'GET', path: '/api/v1/healthz', headers: {} })).rejects.toBeInstanceOf(DeviceRequestError);
          await vi.waitFor(() => expect(bridge.session).toBeUndefined());
          const listWorkspaces = () => get('/api/v1/workspaces?devices=include');
          const listSessions = () => get('/api/v1/sessions?devices=include');
          const first = await Promise.all([listWorkspaces(), listSessions()]);
          const connected = bridge.session !== undefined;
          if (slow) rmSync(hold);
          const recovered = slow
            ? await Promise.all([listWorkspaces(), listSessions()])
            : first;
          const available = [
            { code: 0, data: { items: [{ name: 'example', device_id: 'example' }] } },
            { code: 0, data: { unavailable_devices: [] } },
          ];
          expect(connected).toBe(!slow);
          expect(first).toMatchObject(slow ? [
            { code: 0, data: { items: [] } },
            { code: 0, data: { unavailable_devices: ['example'] } },
          ] : available);
          expect(recovered).toMatchObject(available);
          expect(readFileSync(join(dir, 'count'), 'utf8')).toBe('xx');
        } finally {
          list.mockRestore();
          bridge.dispose();
          await server.close();
        }
      },
    ),
  );
});

describe('device HTTP proxy', () => {
  it.each([
    ['POST', '/feedback/42/attachments/session', 360_000, 200],
    ['POST', '/feedback/42/attachments?kind=media', 360_000, 200],
    ['GET', '/feedback/42/attachments/session', 30_001, 504],
    ['POST', '/feedback/42/attachments/session/other', 30_001, 504],
    ['POST', '/feedback', 30_001, 504],
    ['GET', '/sessions/example/export', 30_001, 200],
    ['GET', '/sessions/example/export', 300_001, 504],
  ] as const)('applies the deadline for %s %s after %i ms', async (method, path, elapsedMs, expectedStatus) => {
    const stream = new PassThrough();
    const session = new StdioDeviceSession(stream);
    const app = Fastify();
    registerDeviceProxyRoutes(app, { session: () => session, connect: async () => session }, LOCAL_CLIENT_IDENTITY_HEADER);
    await app.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sent = once(stream, 'data');
      const response = app.inject({ method, url: `/api/v1/devices/example/proxy/api/v1${path}` }).then(res => res.statusCode);
      const [frame] = await sent;
      const { id } = JSON.parse(String(frame)) as { id: string };
      await vi.advanceTimersByTimeAsync(elapsedMs);
      stream.write(`${JSON.stringify({ type: 'http.res', id, status: 200, headers: {} })}\n`);
      await expect(response).resolves.toBe(expectedStatus);
    } finally {
      vi.useRealTimers();
      session.close();
      stream.destroy();
      await app.close();
    }
  });

  it('enforces request limits and maps timeouts to gateway responses', async () => {
    const app = Fastify();
    registerDeviceProxyRoutes(app, {
      session: () => ({
        request: async () => { throw new DeviceRequestError('timeout', 'device request timed out'); },
        openWebSocket: () => { throw new Error('unexpected websocket'); },
      }),
    } as never, LOCAL_CLIENT_IDENTITY_HEADER);
    await app.ready();
    const timeout = await app.inject({ method: 'GET', url: '/api/v1/devices/dev/proxy/api/v1/healthz' });
    expect(timeout.statusCode).toBe(504);
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/dev/proxy/api/v1/files',
      headers: { 'content-length': String(DEVICE_RPC_MAX_BODY_BYTES + 1) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().code).toBe(41301);
    await app.close();
  });

  it.each(['/sessions/s1/messages', '/feedback/42/attachments/session', '/feedback/42/attachments?kind=media'])('cancels the remote %s request when the client disconnects', async (path) => {
    const app = Fastify();
    const stream = new PassThrough();
    const session = new StdioDeviceSession(stream);
    registerDeviceProxyRoutes(app, { session: () => session, connect: async () => session }, LOCAL_CLIENT_IDENTITY_HEADER);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server address');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    try {
      await once(socket, 'connect');
      const sent = once(stream, 'data');
      socket.write(`POST /api/v1/devices/dev/proxy/api/v1${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx`);
      const [frame] = await sent;
      const { id } = JSON.parse(String(frame)) as { id: string };
      const cancelled = once(stream, 'data');
      socket.destroy();
      const [cancel] = await cancelled;
      expect(JSON.parse(String(cancel))).toEqual({ type: 'http.cancel', id });
    } finally {
      socket.destroy();
      session.close();
      stream.destroy();
      await app.close();
    }
  });

  it('stamps only session creation with the local client identity, replacing a client-supplied one', async () => {
    const app = Fastify();
    const forwarded: DeviceHttpRequest[] = [];
    registerDeviceProxyRoutes(app, {
      session: () => ({
        request: async (input: DeviceHttpRequest) => {
          forwarded.push(input);
          return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') };
        },
        openWebSocket: () => { throw new Error('unexpected websocket'); },
      }),
    } as never, LOCAL_CLIENT_IDENTITY_HEADER);
    await app.ready();
    const clientSupplied = { [CLIENT_IDENTITY_HEADER]: 'Y2xpZW50' };
    const json = { 'content-type': 'application/json' };
    await app.inject({ method: 'POST', url: '/api/v1/devices/dev/proxy/api/v1/sessions', headers: { ...json, ...clientSupplied }, payload: '{}' });
    await app.inject({ method: 'POST', url: '/api/v1/devices/dev/proxy/api/v1/sessions?trace=1', headers: json, payload: '{}' });
    await app.inject({ method: 'GET', url: '/api/v1/devices/dev/proxy/api/v1/sessions', headers: clientSupplied });
    await app.inject({ method: 'POST', url: '/api/v1/devices/dev/proxy/api/v1/sessions/s1:fork', headers: { ...json, ...clientSupplied }, payload: '{}' });
    await app.inject({ method: 'POST', url: '/api/v1/devices/dev/proxy/api/v1/sessions/s1/prompts', headers: json, payload: '{}' });
    expect(forwarded.map((request) => [request.method, request.path, request.headers[CLIENT_IDENTITY_HEADER]])).toEqual([
      ['POST', '/api/v1/sessions', LOCAL_CLIENT_IDENTITY_HEADER],
      ['POST', '/api/v1/sessions?trace=1', LOCAL_CLIENT_IDENTITY_HEADER],
      ['GET', '/api/v1/sessions', 'Y2xpZW50'],
      ['POST', '/api/v1/sessions/s1:fork', 'Y2xpZW50'],
      ['POST', '/api/v1/sessions/s1/prompts', undefined],
    ]);
    await app.close();
  });

  it.skipIf(process.platform === 'win32')('runs a session created through an SSH device with the local client identity', async () => {
    const loopbackFetch = globalThis.fetch;
    await withManagedDevicePair(
      (input, init) => loopbackFetch(input as Parameters<typeof fetch>[0], init),
      async ({ local, remote, remoteHome, requests }) => {
        const project = join(remoteHome, 'project');
        mkdirSync(project);
        const created = await call(local, 'POST', '/api/v1/devices/dev/proxy/api/v1/sessions', { cwd: project });
        expect(created).toMatchObject({ code: 0 });
        const sessionId = String(created.data['id']);
        expect(await call(local, 'GET', `/api/v1/devices/dev/proxy/api/v1/sessions/${sessionId}`)).toMatchObject({ code: 0 });

        const remoteSession = getLiveSessionById(remote.core.accessor, sessionId);
        expect((await remoteSession?.accessor.get(ISessionMetadata).read())?.clientIdentity).toEqual({
          ...LOCAL_HOST_IDENTITY,
          uiCapabilities: ['update_panel'],
        });
        expect(remoteSession?.accessor.get(IClientIdentity).requestHeaders).toMatchObject({
          'User-Agent': 'local-desktop/9.8.7',
          'X-Msh-Platform': 'local_desktop_platform',
          'X-Msh-Version': '9.8.7',
        });
        expect(remote.core.accessor.get(IClientIdentity).requestHeaders['User-Agent']).toBe('test-host/0.0.0-test');
        expect(requests.map((request) => [request.method, request.headers[CLIENT_IDENTITY_HEADER]])).toEqual([
          ['POST', LOCAL_CLIENT_IDENTITY_HEADER],
          ['GET', undefined],
        ]);
      },
      LOCAL_HOST_IDENTITY,
    );
  }, 30_000);
});

interface ManagedDevicePair {
  readonly local: Awaited<ReturnType<typeof startServer>>;
  readonly remote: Awaited<ReturnType<typeof startServer>>;
  readonly localHome: string;
  readonly remoteHome: string;
  readonly session: DeviceSession;
  readonly paths: string[];
  readonly requests: DeviceHttpRequest[];
}

async function withManagedDevicePair(
  fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>,
  run: (pair: ManagedDevicePair) => Promise<void>,
  localIdentity: ServerHostIdentity = TEST_HOST_IDENTITY,
): Promise<void> {
  const localHome = await mkdtemp(join(tmpdir(), 'kimi-device-local-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'kimi-device-remote-'));
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  writeFileSync(join(localHome, 'config.toml'), '[devices.dev]\nhost = "dev"\n');
  const env = { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' };
  const local = await startServer({ hostIdentity: localIdentity, host: '127.0.0.1', port: 0, homeDir: localHome, logLevel: 'silent', env });
  const remote = await startServer({
    hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: remoteHome, logLevel: 'silent',
    socketPath: join(remoteHome, 'daemon.sock'), managedBy: 'ensure-daemon', env,
  });
  const client = createConnection(join(remoteHome, 'daemon.sock'));
  const pending = new Map<string, (response: DeviceHttpResponse) => void>();
  createInterface({ input: client, crlfDelay: Infinity }).on('line', (line) => {
    const frame = JSON.parse(line) as { id?: string; status?: number; headers?: OutgoingHttpHeaders; body?: string };
    if (frame.id === undefined) return;
    pending.get(frame.id)?.({ status: frame.status ?? 500, headers: frame.headers ?? {}, body: Buffer.from(frame.body ?? '', 'base64') });
    pending.delete(frame.id);
  });
  const paths: string[] = [];
  const requests: DeviceHttpRequest[] = [];
  let requestId = 0;
  const session: DeviceSession = {
    request: (input: DeviceHttpRequest) => new Promise<DeviceHttpResponse>((resolve) => {
      const id = `req-${String(++requestId)}`;
      paths.push(input.path);
      requests.push(input);
      pending.set(id, resolve);
      client.write(`${JSON.stringify({ type: 'http.req', id, method: input.method, path: input.path, headers: input.headers, body: input.body?.toString('base64') })}\n`);
    }),
    openWebSocket: () => { throw new Error('not used'); },
  };
  vi.spyOn(SshDeviceBridge.prototype, 'connect').mockResolvedValue(session);
  vi.spyOn(SshDeviceBridge.prototype, 'session', 'get').mockReturnValue(session);
  try {
    await run({ local, remote, localHome, remoteHome, session, paths, requests });
  } finally {
    client.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    local.deviceManager.close();
    await local.close();
    await remote.close();
    await rm(localHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(remoteHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('device account', () => {
  it.skipIf(process.platform === 'win32')('lets a managed device sign in and renew with its own Kimi login', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refreshRequests: string[] = [];
    await withManagedDevicePair(
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
        writeFileSync(join(remoteHome, KIMI_REGION_MARKER_FILENAME), 'mainland-cn');
        await localStorage.save('kimi-code', {
          accessToken: 'local-access', refreshToken: 'local-refresh', expiresAt: now + 3600, expiresIn: 3600, scope: '', tokenType: 'Bearer',
        });
        await remoteStorage.save('kimi-code', {
          accessToken: 'remote-access', refreshToken: 'remote-refresh', expiresAt: now + 10, expiresIn: 3600, scope: '', tokenType: 'Bearer',
        });
        const manager = local.deviceManager;
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

describe('device model providers', () => {
  it.skipIf(process.platform === 'win32')('copies portable providers with their models and replaces same-name ones whole', async () => {
    await withManagedDevicePair(
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
        const manager = local.deviceManager;

        const result = await manager.copyProviders('dev');
        expect(result).toEqual({ providers: ['gateway', 'taken'] });
        const providers = remoteConfig.inspect<Record<string, Record<string, unknown>>>('providers').userValue ?? {};
        expect(providers['gateway']).toMatchObject({ apiKey: 'sk-gateway', customHeaders: { 'x-team': 'core' } });
        expect(providers['taken']).toEqual({ type: 'openai', baseUrl: 'https://taken.example.test/v1', apiKey: 'sk-local' });
        expect(providers['kept']).toMatchObject({ apiKey: 'sk-kept' });
        expect(providers).not.toHaveProperty('fromEnv');
        expect(providers).not.toHaveProperty('ollama');
        expect(providers).not.toHaveProperty('signedIn');
        const models = remoteConfig.inspect<Record<string, Record<string, unknown>>>('models').userValue ?? {};
        expect(models['gateway/large']).toMatchObject({ provider: 'gateway', maxOutputSize: 8_000, adaptiveThinking: true });
        expect(models['taken/small']).toMatchObject({ provider: 'taken', maxContextSize: 32_000 });
        expect(models).not.toHaveProperty('taken/remote-only');
        expect(models).not.toHaveProperty('ollama/local');

        await expect(manager.copyProviders('dev')).resolves.toEqual({ providers: ['gateway', 'taken'] });
        await expect(manager.copyProviders('missing')).rejects.toThrow(/not configured/);
      },
    );
  }, 30_000);
});

const REMOTE_DEVICE_ID = '7d3f2a10-5b6c-4e8f-9a01-23456789abcd';
const RELAY_ACCESS = { relayOrigin: 'http://relay.example.test', cookie: 'rc_session=one' };

function registration(deviceId: string, status: 'online' | 'offline'): RemoteControlDevice {
  return {
    device_id: deviceId,
    alias: 'Laptop',
    status,
    platform: 'darwin',
    client_version: 'test-host/0.0.0-test',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_remote_access_at: '2026-01-01T00:00:00.000Z',
  };
}

async function listenOn(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing test server address');
  return `http://127.0.0.1:${String(address.port)}`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('error', reject);
    req.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

function wsText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
}

describe('relay device session', () => {
  it('drops hop-by-hop, local credential and fetch-managed request headers', () => {
    expect(relayRequestHeaders({
      authorization: 'Bearer local',
      cookie: 'local=1',
      origin: 'http://example.test',
      referer: 'http://example.test/app',
      host: '127.0.0.1',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'content-length': '2',
      'accept-encoding': 'zstd',
      expect: '100-continue',
      'x-kimi-client-id': 'client',
      'x-multi': ['a', 'b'],
    }, 'rc_session=one')).toEqual({
      'x-kimi-client-id': 'client',
      'x-multi': 'a, b',
      cookie: 'rc_session=one',
    });
  });

  it('sends requests under the relay device path and drops the headers fetch already applied to the body', async () => {
    let seenUrl = '';
    let seenHeaders: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      seenUrl = req.url ?? '';
      seenHeaders = req.headers;
      const body = gzipSync(JSON.stringify({ ok: true }));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
        'set-cookie': 'relay_session=rotated; Path=/',
        'x-device-header': 'kept',
      });
      res.end(body);
    });
    const origin = await listenOn(server);
    const session = new RelayDeviceSession('dev/one', {
      relayAccess: vi.fn(async () => ({ relayOrigin: `${origin}/coding-relay/`, cookie: 'rc_session=one' })),
    });
    try {
      const response = await session.request({
        method: 'GET',
        path: '/api/v1/sessions?page_size=1',
        headers: { authorization: 'Bearer local', origin: 'http://example.test', host: '127.0.0.1', 'x-kimi-client-id': 'client' },
      });
      expect(seenUrl).toBe('/coding-relay/devices/dev%2Fone/api/v1/sessions?page_size=1');
      expect(seenHeaders).toMatchObject({ cookie: 'rc_session=one', 'x-kimi-client-id': 'client', host: origin.slice('http://'.length) });
      expect(seenHeaders).not.toHaveProperty('authorization');
      expect(seenHeaders).not.toHaveProperty('origin');
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body.toString('utf8'))).toEqual({ ok: true });
      expect(response.headers).toMatchObject({ 'content-type': 'application/json', 'x-device-header': 'kept' });
      for (const header of ['content-encoding', 'content-length', 'set-cookie']) expect(response.headers).not.toHaveProperty(header);
    } finally {
      session.close();
      await closeServer(server);
    }
  });

  it('renews the relay session once on 401, follows the client sign-in, and reports relay failures to its owner', async () => {
    let acceptedCookie = 'rc_session=two';
    let status = 200;
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/held') === true) return;
      if (req.headers.cookie !== acceptedCookie) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"code":0}');
    });
    const origin = await listenOn(server);
    let cookie = 'rc_session=one';
    const relayAccess = vi.fn(async (refresh?: boolean) => {
      if (refresh === true) cookie = 'rc_session=two';
      return { relayOrigin: origin, cookie };
    });
    const renewals = () => relayAccess.mock.calls.filter(([refresh]) => refresh === true).length;
    const failures: string[] = [];
    const session = new RelayDeviceSession('dev', { relayAccess }, (error) => {
      failures.push(error.message);
    });
    const get = (path = '/api/v1/meta', extra: Partial<DeviceHttpRequest> = {}) => session.request({ method: 'GET', path, headers: {}, ...extra });
    try {
      expect((await get()).status).toBe(200);
      expect((await get()).status).toBe(200);
      expect(renewals()).toBe(1);

      await expect(get('/held', { timeoutMs: 50 })).rejects.toMatchObject({ failure: 'timeout' });
      const cancellation = new AbortController();
      const cancelled = get('/held', { signal: cancellation.signal });
      cancellation.abort();
      await expect(cancelled).rejects.toMatchObject({ failure: 'cancelled' });
      expect(failures).toEqual([]);

      status = 502;
      await expect(get()).rejects.toMatchObject({ failure: 'unavailable' });
      acceptedCookie = 'rc_session=three';
      await expect(get()).rejects.toMatchObject({ failure: 'unavailable', message: 'Remote Control relay responded with HTTP 401' });
      expect(renewals()).toBe(2);
      relayAccess.mockRejectedValueOnce(new RemoteControlLoginRequiredError());
      await expect(get()).rejects.toMatchObject({ failure: 'unavailable' });
      await closeServer(server);
      await expect(get()).rejects.toMatchObject({ failure: 'unavailable' });
      expect(failures).toEqual([
        'Remote Control relay responded with HTTP 502',
        'Remote Control relay responded with HTTP 401',
        'Remote Control relay request failed: Remote Control requires a Kimi login.',
        expect.stringContaining('Remote Control relay request failed'),
      ]);

      session.close();
      await expect(get()).rejects.toMatchObject({ failure: 'unavailable', message: 'device session is closed' });
      expect(failures).toHaveLength(4);
    } finally {
      session.close();
      await closeServer(server);
    }
  });

  it('queues WebSocket sends until open, retries the upgrade once with a renewed cookie, and applies backpressure', async () => {
    const wss = new WebSocketServer({ noServer: true });
    const upgrades: string[] = [];
    const received: string[] = [];
    let upstream: Duplex | undefined;
    const server = createServer();
    server.on('upgrade', (req, socket, head) => {
      upgrades.push(String(req.headers.cookie));
      if (req.headers.cookie !== 'rc_session=two') {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      upstream = socket;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send('welcome');
        ws.on('message', (data) => received.push(wsText(data)));
      });
    });
    const origin = await listenOn(server);
    let cookie = 'rc_session=one';
    const session = new RelayDeviceSession('dev', {
      relayAccess: vi.fn(async (refresh?: boolean) => {
        if (refresh === true) cookie = 'rc_session=two';
        return { relayOrigin: origin, cookie };
      }),
    });
    const messages: string[] = [];
    const backpressure: boolean[] = [];
    const closes: Array<number | undefined> = [];
    try {
      const channel = session.openWebSocket('/api/v1/ws', {
        onMessage: (data) => messages.push(data),
        onClose: (code) => closes.push(code),
        onBackpressure: (blocked) => backpressure.push(blocked),
      });
      channel.send('queued');
      await vi.waitFor(() => {
        expect(received).toEqual(['queued']);
        expect(messages).toEqual(['welcome']);
      });
      expect(upgrades).toEqual(['rc_session=one', 'rc_session=two']);

      upstream!.pause();
      const chunk = 'x'.repeat(256 * 1024);
      for (let index = 0; index < 128; index += 1) channel.send(chunk);
      await vi.waitFor(() => expect(backpressure).toEqual([true]), { timeout: 5_000 });
      upstream!.resume();
      await vi.waitFor(() => {
        expect(received).toHaveLength(129);
        expect(backpressure).toEqual([true, false]);
      }, { timeout: 10_000 });

      session.close();
      expect(closes).toEqual([1001]);
    } finally {
      session.close();
      wss.close();
      await closeServer(server);
    }
  }, 20_000);
});

describe('account device bridge', () => {
  it('backs off while offline, polls an outdated device every minute, and leaves a signed-out device alone until reconnected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const devices = [registration('dev-id', 'offline')];
    const relay = {
      relayAccess: vi.fn(async () => RELAY_ACCESS),
      listDevices: vi.fn(async () => ({ devices })),
    };
    let meta: Record<string, unknown> = { server_version: '0.9.0' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 0, msg: 'success', data: meta })));
    const bridge = new AccountDeviceBridge('dev-id', relay);
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
      bridge.start();
      await settle();
      expect(bridge.status).toBe('disconnected');
      expect(bridge.failure).toBe('offline');
      expect(relay.listDevices).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(relay.listDevices).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(relay.listDevices).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(relay.listDevices).toHaveBeenCalledTimes(3);

      devices[0] = registration('dev-id', 'online');
      await vi.advanceTimersByTimeAsync(4_000);
      expect(bridge.failure).toBe('outdated');
      expect(bridge.remoteVersion).toBe('0.9.0');
      expect(bridge.registration?.alias).toBe('Laptop');
      const outdatedChecks = relay.listDevices.mock.calls.length;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(relay.listDevices).toHaveBeenCalledTimes(outdatedChecks);
      await vi.advanceTimersByTimeAsync(1);
      expect(relay.listDevices).toHaveBeenCalledTimes(outdatedChecks + 1);

      relay.relayAccess.mockRejectedValue(new RemoteControlLoginRequiredError());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.failure).toBe('signed_out');
      const signedOutAttempts = relay.relayAccess.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(relay.relayAccess).toHaveBeenCalledTimes(signedOutAttempts);

      relay.relayAccess.mockResolvedValue(RELAY_ACCESS);
      meta = { server_version: '2.0.0', product: 'kimi-code-desktop', device_id: 'dev-id', device_api_level: DEVICE_API_LEVEL };
      await bridge.connect();
      expect(bridge.status).toBe('ready');
      expect(bridge.failure).toBeUndefined();
      expect(bridge.remoteVersion).toBe('2.0.0');
      expect(bridge.identity).toEqual({ deviceId: 'dev-id', productName: 'kimi-code-desktop' });
    } finally {
      bridge.dispose();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

interface FakeRelay {
  origin: string;
  target: RunningServer;
  readonly devices: RemoteControlDevice[];
  legacyMeta: boolean;
  exchanges: number;
  rejected: number;
  expireSession(): void;
  close(): Promise<void>;
}

const RELAY_UNFORWARDED_HEADERS = new Set(['host', 'cookie', 'connection', 'content-length', 'authorization', 'accept-encoding']);

async function startFakeRelay(target: RunningServer): Promise<FakeRelay> {
  let session: string | undefined;
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  const relay: FakeRelay = {
    origin: '',
    target,
    devices: [],
    legacyMeta: false,
    exchanges: 0,
    rejected: 0,
    expireSession: () => {
      session = undefined;
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await closeServer(server);
    },
  };
  const authorized = (req: IncomingMessage): boolean => {
    if (session !== undefined && req.headers.cookie === session) return true;
    relay.rejected += 1;
    return false;
  };
  const devicePath = (url: string): string | undefined => {
    const match = /^\/devices\/([^/]+)(\/.*)$/.exec(url);
    if (match === null) return undefined;
    const deviceId = decodeURIComponent(match[1]!);
    return relay.devices.some((device) => device.device_id === deviceId && device.status === 'online') ? match[2] : undefined;
  };
  const upstreamHeaders = (req: IncomingMessage): Record<string, string> => {
    const headers: Record<string, string> = { authorization: `Bearer ${relay.target.authTokenService.getToken()}` };
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !RELAY_UNFORWARDED_HEADERS.has(name)) headers[name] = value;
    }
    return headers;
  };
  server.on('request', (req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (req.method === 'POST' && req.url === '/auth/exchange') {
        relay.exchanges += 1;
        session = `rc_session=s${String(relay.exchanges)}`;
        res.writeHead(204, { 'set-cookie': `${session}; Path=/; HttpOnly` });
        res.end();
        return;
      }
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'session expired' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/remote/devices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ devices: relay.devices }));
        return;
      }
      const path = devicePath(req.url ?? '');
      if (path === undefined) {
        res.writeHead(502);
        res.end();
        return;
      }
      const upstream = await fetch(`http://127.0.0.1:${String(relay.target.port)}${path}`, {
        method: req.method,
        headers: upstreamHeaders(req),
        body: body.length > 0 ? body : undefined,
      });
      let payload = Buffer.from(await upstream.arrayBuffer());
      if (relay.legacyMeta && path === '/api/v1/meta') {
        const envelope = JSON.parse(payload.toString('utf8')) as { data: Record<string, unknown> };
        delete envelope.data['device_id'];
        delete envelope.data['device_api_level'];
        payload = Buffer.from(JSON.stringify(envelope));
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(payload);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const path = devicePath(req.url ?? '');
    if (path === undefined) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = new WebSocketClient(`ws://127.0.0.1:${String(relay.target.port)}${path}`, {
      headers: { authorization: `Bearer ${relay.target.authTokenService.getToken()}` },
    });
    upstream.once('error', () => socket.destroy());
    upstream.once('open', () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data, isBinary) => upstream.send(wsText(data), { binary: isBinary }));
        upstream.on('message', (data, isBinary) => client.send(wsText(data), { binary: isBinary }));
        client.once('close', () => upstream.close());
        upstream.once('close', () => client.close());
      });
    });
  });
  relay.origin = await listenOn(server);
  return relay;
}

function directSession(server: RunningServer): DeviceSession {
  return {
    request: async (req) => {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}${req.path}`, {
        method: req.method,
        headers: { accept: 'application/json', authorization: `Bearer ${server.authTokenService.getToken()}` },
        body: req.body,
      });
      return { status: response.status, headers: {}, body: Buffer.from(await response.arrayBuffer()) };
    },
    openWebSocket: () => {
      throw new Error('not used');
    },
  };
}

interface Envelope {
  readonly code: number;
  readonly msg: string;
  readonly data: Record<string, unknown>;
}

function request(server: RunningServer, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.authTokenService.getToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(server: RunningServer, method: string, path: string, body?: unknown): Promise<Envelope> {
  return (await (await request(server, method, path, body)).json()) as Envelope;
}

interface AccountDevicePair {
  readonly local: RunningServer;
  readonly remote: RunningServer;
  readonly relay: FakeRelay;
  readonly remoteProject: string;
  restartRemote(serverVersion: string): Promise<RunningServer>;
}

async function withAccountDevicePair(
  run: (pair: AccountDevicePair) => Promise<void>,
  options: {
    readonly localIdentity?: ServerHostIdentity;
    readonly remoteOptions?: Partial<ServerStartOptions>;
    readonly localOptions?: Partial<ServerStartOptions>;
  } = {},
): Promise<void> {
  const localIdentity = options.localIdentity ?? TEST_HOST_IDENTITY;
  const remoteOptions = options.remoteOptions ?? {};
  const localOptions = options.localOptions ?? {};
  const localHome = await mkdtemp(join(tmpdir(), 'kimi-account-local-'));
  const remoteHome = await mkdtemp(join(tmpdir(), 'kimi-account-remote-'));
  const remoteProject = join(remoteHome, 'project');
  mkdirSync(remoteProject);
  writeFileSync(join(remoteHome, 'device_id'), REMOTE_DEVICE_ID);
  const now = Math.floor(Date.now() / 1000);
  await new FileTokenStorage(join(localHome, 'credentials')).save('kimi-code', {
    accessToken: 'local-access', refreshToken: 'local-refresh', expiresAt: now + 3600, expiresIn: 3600, scope: '', tokenType: 'Bearer',
  });
  const loopbackFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith('http://127.0.0.1:') ? loopbackFetch(input, init) : Promise.reject(new Error(`unexpected request ${url}`));
  }));
  const env = { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' };
  const startRemote = (serverVersion?: string) => startServer({
    hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: remoteHome, logLevel: 'silent', env, serverVersion, ...remoteOptions,
  });
  const remote = await startRemote();
  const relay = await startFakeRelay(remote);
  relay.devices.push(registration(REMOTE_DEVICE_ID, 'online'));
  vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', relay.origin);
  const local = await startServer({
    hostIdentity: localIdentity, host: '127.0.0.1', port: 0, homeDir: localHome, logLevel: 'silent', env, ...localOptions,
  });
  const restartRemote = async (serverVersion: string): Promise<RunningServer> => {
    await relay.target.close();
    relay.target = await startRemote(serverVersion);
    return relay.target;
  };
  try {
    await run({ local, remote, relay, remoteProject, restartRemote });
  } finally {
    vi.restoreAllMocks();
    await local.close();
    await relay.close();
    await remote.close();
    await relay.target.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(localHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(remoteHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('account devices', () => {
  it('adds a device signed in to the same Kimi account and serves its projects, sessions, HTTP and WebSocket through the relay', async () => {
    await withAccountDevicePair(async ({ local, remote, relay, remoteProject }) => {
      const workspace = (await call(remote, 'POST', '/api/v1/workspaces', { root: remoteProject })).data;
      const remoteSession = (await call(remote, 'POST', '/api/v1/sessions', { workspace_id: workspace['id'] })).data;
      const remoteMeta = (await call(remote, 'GET', '/api/v1/meta')).data;
      expect(remoteMeta).toMatchObject({ device_id: REMOTE_DEVICE_ID, device_api_level: DEVICE_API_LEVEL, product: TEST_HOST_IDENTITY.productName });

      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account', name: 'Work laptop' })).toMatchObject({ code: 0 });
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({
        code: 0,
        data: {
          id: REMOTE_DEVICE_ID,
          connection: 'account',
          name: 'Work laptop',
          status: 'ready',
          device_id: REMOTE_DEVICE_ID,
          product_name: TEST_HOST_IDENTITY.productName,
          platform: 'darwin',
          alias: 'Laptop',
          remote_version: remoteMeta['server_version'],
          install: 'cli',
          remote_upgrade: false,
        },
      });
      const listed = (await call(local, 'GET', '/api/v1/devices')).data['devices'] as Array<Record<string, unknown>>;
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty('host');
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({
        code: 0,
        data: {
          status: 'unsupported',
          message: `Kimi Code ${String(remoteMeta['server_version'])} on this device cannot be upgraded remotely; run \`kimi upgrade\` on the device`,
        },
      });

      const projects = await call(local, 'GET', '/api/v1/workspaces?devices=include');
      expect(projects.data['items']).toContainEqual(expect.objectContaining({ id: workspace['id'], device_id: REMOTE_DEVICE_ID }));
      const sessions = await call(local, 'GET', '/api/v1/sessions?devices=include');
      expect(sessions.data['items']).toContainEqual(expect.objectContaining({ id: remoteSession['id'], device_id: REMOTE_DEVICE_ID }));
      expect(sessions.data['unavailable_devices']).toEqual([]);

      const proxied = await request(local, 'GET', `/api/v1/devices/${REMOTE_DEVICE_ID}/proxy/api/v1/sessions/${String(remoteSession['id'])}`);
      expect(proxied.status).toBe(200);
      expect(await proxied.json()).toMatchObject({ code: 0, data: { id: remoteSession['id'] } });

      const { exchanges, rejected } = relay;
      relay.expireSession();
      const renewed = await request(local, 'GET', `/api/v1/devices/${REMOTE_DEVICE_ID}/proxy/api/v1/meta`);
      expect(renewed.status).toBe(200);
      expect(await renewed.json()).toMatchObject({ code: 0, data: { device_id: REMOTE_DEVICE_ID } });
      expect(relay.rejected).toBe(rejected + 1);
      expect(relay.exchanges).toBe(exchanges + 1);

      const ws = new WebSocketClient(`ws://127.0.0.1:${String(local.port)}/api/v1/devices/${REMOTE_DEVICE_ID}/proxy/api/v1/ws`, {
        headers: { authorization: `Bearer ${local.authTokenService.getToken()}` },
      });
      try {
        const response = new Promise<Record<string, unknown>>((resolve) => {
          ws.on('message', (data) => {
            const frame = JSON.parse(wsText(data)) as Record<string, unknown>;
            if (frame['type'] === 'response') resolve(frame);
          });
        });
        ws.once('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', request_id: 'subscribe-1', session_id: remoteSession['id'] }));
        });
        expect(await response).toMatchObject({ request_id: 'subscribe-1', code: 0 });
      } finally {
        ws.terminate();
      }

      expect(await call(local, 'POST', '/api/v1/oauth/logout', {})).toMatchObject({ code: 0 });
      expect((await request(local, 'GET', `/api/v1/devices/${REMOTE_DEVICE_ID}/proxy/api/v1/meta`)).status).toBe(502);
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({
        data: { status: 'disconnected', connect_failure: 'signed_out' },
      });
    });
  }, 30_000);

  it('runs a session created through an account device with the local client identity', async () => {
    await withAccountDevicePair(async ({ local, remote, remoteProject }) => {
      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
      const created = await call(local, 'POST', `/api/v1/devices/${REMOTE_DEVICE_ID}/proxy/api/v1/sessions`, { cwd: remoteProject });
      expect(created).toMatchObject({ code: 0 });
      const sessionId = String(created.data['id']);

      const remoteSession = getLiveSessionById(remote.core.accessor, sessionId);
      expect((await remoteSession?.accessor.get(ISessionMetadata).read())?.clientIdentity).toEqual({
        ...LOCAL_HOST_IDENTITY,
        uiCapabilities: ['update_panel'],
      });
      expect(remoteSession?.accessor.get(IClientIdentity).requestHeaders['User-Agent']).toBe('local-desktop/9.8.7');

      const direct = await call(remote, 'POST', '/api/v1/sessions', { cwd: remoteProject });
      const directSession = getLiveSessionById(remote.core.accessor, String(direct.data['id']));
      expect((await directSession?.accessor.get(ISessionMetadata).read())?.clientIdentity).toBeUndefined();
    }, { localIdentity: LOCAL_HOST_IDENTITY });
  }, 30_000);

  it('reports offline and outdated devices and refuses to add this computer', async () => {
    await withAccountDevicePair(async ({ local, remote, relay }) => {
      relay.devices[0] = registration(REMOTE_DEVICE_ID, 'offline');
      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
      await local.core.accessor.get(IConfigService).reload();
      expect(local.deviceManager.section()).toEqual({ [REMOTE_DEVICE_ID]: { connection: 'account' } });
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({
        data: { status: 'disconnected', connect_failure: 'offline', alias: 'Laptop', install: 'cli' },
      });
      expect((await request(local, 'GET', `/api/v1/devices/${REMOTE_DEVICE_ID}/proxy/api/v1/meta`)).status).toBe(502);
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({
        code: 40926,
        msg: '"Laptop" is offline',
      });

      relay.devices[0] = registration(REMOTE_DEVICE_ID, 'online');
      relay.legacyMeta = true;
      const remoteMeta = (await call(remote, 'GET', '/api/v1/meta')).data;
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({
        data: { status: 'disconnected', connect_failure: 'outdated', remote_version: remoteMeta['server_version'], remote_upgrade: false },
      });
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({
        code: 0,
        data: { status: 'unsupported', message: expect.stringContaining('run `kimi upgrade` on the device') },
      });

      relay.legacyMeta = false;
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'ready' } });

      const localDeviceId = String((await call(local, 'GET', '/api/v1/meta')).data['device_id']);
      expect(await call(local, 'PUT', `/api/v1/devices/${localDeviceId}`, { connection: 'account' })).toMatchObject({
        code: 40001,
        msg: 'this device cannot be added to itself',
      });
      expect(Object.keys(local.deviceManager.section())).toEqual([REMOTE_DEVICE_ID]);
      await expect(local.deviceManager.copyProviders(REMOTE_DEVICE_ID)).rejects.toThrow(/only available for SSH devices/);
    });
  }, 30_000);

  it.each(['ready', 'outdated'] as const)('upgrades a CLI device (%s) through its background server and follows it until it is back on the new version', async (initial) => {
    const commands: string[][] = [];
    const runHostCommand = async (args: readonly string[]): Promise<HostCommandResult> => {
      commands.push([...args]);
      return args[0] === 'upgrade'
        ? { code: 0, output: 'Updated @moonshot-ai/kimi-code to 9.9.9. Restart the CLI to use the new version.\n' }
        : { code: 0, output: '9.9.9\n' };
    };
    await withAccountDevicePair(async ({ local, remote, relay, restartRemote }) => {
      relay.legacyMeta = initial === 'outdated';
      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
      const connected = await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID });
      expect(connected).toMatchObject({
        data: initial === 'outdated'
          ? { status: 'disconnected', connect_failure: 'outdated', install: 'cli', remote_upgrade: true }
          : { status: 'ready', install: 'cli', remote_upgrade: true },
      });
      expect(connected.data['remote_version']).not.toBe('9.9.9');

      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({ code: 0, data: { status: 'started' } });
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({ code: 40960 });
      await vi.waitFor(() => expect(remote.app.server.listening).toBe(false), { timeout: 10_000 });
      expect(commands).toEqual([['upgrade', '--yes'], ['--version']]);
      const [upgrading] = (await call(local, 'GET', '/api/v1/devices')).data['devices'] as Array<Record<string, unknown>>;
      expect(['installing', 'restarting']).toContain(upgrading?.['upgrade_status']);

      await restartRemote('9.9.9');
      relay.legacyMeta = false;
      await vi.waitFor(
        async () => {
          const [device] = (await call(local, 'GET', '/api/v1/devices')).data['devices'] as Array<Record<string, unknown>>;
          expect(device).toMatchObject({ status: 'ready', remote_version: '9.9.9' });
          expect(device).not.toHaveProperty('upgrade_status');
        },
        { timeout: 20_000, interval: 200 },
      );
    }, { remoteOptions: { managedBy: 'ensure-daemon', runHostCommand } });
  }, 40_000);

  it('reports an upgrade that failed on the device and accepts another attempt', async () => {
    const runHostCommand = async (): Promise<HostCommandResult> => ({ code: 1, output: 'error: failed to check for updates: fetch failed\n' });
    await withAccountDevicePair(async ({ local }) => {
      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'ready' } });
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'started' } });
      await vi.waitFor(
        async () => {
          expect((await call(local, 'GET', '/api/v1/devices')).data['devices']).toMatchObject([
            { status: 'ready', upgrade_status: 'failed', upgrade_error: 'error: failed to check for updates: fetch failed' },
          ]);
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'started' } });
    }, { remoteOptions: { managedBy: 'ensure-daemon', runHostCommand } });
  }, 30_000);

  it('stops waiting for a device that does not come back within the upgrade timeout, and clears the failure when it later returns upgraded', async () => {
    const runHostCommand = (): Promise<HostCommandResult> => new Promise(() => {});
    await withAccountDevicePair(
      async ({ local, restartRemote }) => {
        const devices = async () => (await call(local, 'GET', '/api/v1/devices')).data['devices'] as Array<Record<string, unknown>>;
        expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
        expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'ready' } });
        expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'started' } });
        await vi.waitFor(
          async () => {
            expect(await devices()).toMatchObject([
              {
                upgrade_status: 'failed',
                upgrade_error: 'the device did not come back on a new Kimi Code version within 2 seconds; check Kimi Code on that device',
              },
            ]);
          },
          { timeout: 10_000, interval: 100 },
        );

        await restartRemote('9.9.9');
        await vi.waitFor(
          async () => {
            const [device] = await devices();
            expect(device).toMatchObject({ status: 'ready', remote_version: '9.9.9' });
            expect(device).not.toHaveProperty('upgrade_status');
          },
          { timeout: 20_000, interval: 200 },
        );
      },
      { remoteOptions: { managedBy: 'ensure-daemon', runHostCommand }, localOptions: { deviceUpgradeTimeoutMs: 1_500 } },
    );
  }, 40_000);

  it('tells the user to update the desktop app on that computer, even while it is offline', async () => {
    await withAccountDevicePair(async ({ local, relay }) => {
      const desktop = (status: 'online' | 'offline') => ({ ...registration(REMOTE_DEVICE_ID, status), client_version: 'kimi-code-desktop/1.4.0' });
      const updateOnDevice = {
        code: 0,
        data: { status: 'update_on_device', message: 'this device runs the Kimi Code desktop app; update it on that computer' },
      };
      relay.devices[0] = desktop('offline');
      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject(updateOnDevice);

      relay.devices[0] = desktop('online');
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({
        data: { status: 'ready', product_name: 'kimi-code-desktop', install: 'desktop', remote_upgrade: false },
      });
      expect(await call(local, 'POST', '/api/v1/devices:upgrade', { id: REMOTE_DEVICE_ID })).toMatchObject(updateOnDevice);
    }, { remoteOptions: { hostIdentity: { ...TEST_HOST_IDENTITY, productName: 'kimi-code-desktop' } } });
  }, 30_000);

  it('keeps one entry per computer when an SSH device and an account device reach the same machine', async () => {
    await withAccountDevicePair(async ({ local, remote, remoteProject }) => {
      const workspace = (await call(remote, 'POST', '/api/v1/workspaces', { root: remoteProject })).data;
      const ssh = directSession(remote);
      vi.spyOn(SshDeviceBridge.prototype, 'connect').mockResolvedValue(ssh);
      vi.spyOn(SshDeviceBridge.prototype, 'session', 'get').mockReturnValue(ssh);
      vi.spyOn(SshDeviceBridge.prototype, 'status', 'get').mockReturnValue('ready');
      vi.spyOn(SshDeviceBridge.prototype, 'identity', 'get').mockReturnValue({ deviceId: REMOTE_DEVICE_ID });
      const remoteProjects = async () => {
        const items = (await call(local, 'GET', '/api/v1/workspaces?devices=include')).data['items'] as Array<{ id: string; device_id?: string }>;
        return items.filter((item) => item.id === workspace['id']).map((item) => item.device_id);
      };

      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({ code: 0 });
      expect(await call(local, 'PUT', '/api/v1/devices/dev', { host: 'dev.example.test' })).toMatchObject({ code: 0 });
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: REMOTE_DEVICE_ID })).toMatchObject({ data: { status: 'ready' } });
      expect(await call(local, 'POST', '/api/v1/devices:connect', { id: 'dev' })).toMatchObject({
        data: { id: 'dev', status: 'disconnected', connect_failure: 'duplicate', duplicate_of: REMOTE_DEVICE_ID, device_id: REMOTE_DEVICE_ID },
      });
      expect(await remoteProjects()).toEqual([REMOTE_DEVICE_ID]);
      expect((await request(local, 'GET', '/api/v1/devices/dev/proxy/api/v1/meta')).status).toBe(502);

      expect(await call(local, 'DELETE', `/api/v1/devices/${REMOTE_DEVICE_ID}`)).toMatchObject({ code: 0 });
      expect(await remoteProjects()).toEqual(['dev']);
      expect(await call(local, 'PUT', `/api/v1/devices/${REMOTE_DEVICE_ID}`, { connection: 'account' })).toMatchObject({
        code: 40001,
        msg: 'this device is already added as device "dev"',
      });
    });
  }, 30_000);
});

function rpcClient(connection: string | Duplex) {
  const socket = typeof connection === 'string' ? createConnection(connection) : connection;
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

function socketRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          });
        });
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

async function openSocketWebSocket(socketPath: string, path: string): Promise<NodeWebSocket> {
  const ws = new WebSocketClient(`ws://localhost${path}`, {
    createConnection: () => createConnection(socketPath),
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

describe('stdio rpc transport', () => {
  it('skips a cancelled HTTP request while the server is starting', async () => {
    const app = Fastify();
    const [caller, stream] = duplexPair();
    const client = rpcClient(caller);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.fn(() => ({ done: true }));
    void app.register(async (scope) => {
      await ready;
      scope.post('/upload', upload);
      scope.get('/next', async () => ({ done: true }));
    });
    attachRpcStream(stream, { app, wssV1: new WebSocketServer({ noServer: true }) });
    try {
      client.send({ type: 'http.req', id: 'upload', method: 'POST', path: '/upload', headers: {} });
      client.send({ type: 'http.cancel', id: 'upload' });
      client.send({ type: 'http.req', id: 'next', method: 'GET', path: '/next', headers: {} });
      release();
      expect(await client.next()).toMatchObject({ id: 'next', status: 200 });
      expect(upload).not.toHaveBeenCalled();
    } finally {
      caller.destroy();
      stream.destroy();
      await app.close();
    }
  });

  it('closes a streamed response after its headers without sending a late RPC reply', async () => {
    const app = Fastify();
    const [caller, stream] = duplexPair();
    const client = rpcClient(caller);
    const body = new PassThrough();
    const reading = once(body, 'resume');
    const closed = vi.fn();
    body.once('close', closed);
    app.get('/stream', (_req, reply) => reply.send(body));
    app.get('/ping', async () => ({ ok: true }));
    attachRpcStream(stream, { app, wssV1: new WebSocketServer({ noServer: true }) });
    try {
      client.send({ type: 'http.req', id: 'stream', method: 'GET', path: '/stream', headers: {} });
      await reading;
      body.write('first chunk');
      client.send({ type: 'http.req', id: 'ping', method: 'GET', path: '/ping', headers: {} });
      expect(await client.next()).toMatchObject({ id: 'ping', status: 200 });
      client.send({ type: 'http.cancel', id: 'stream' });
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
      client.send({ type: 'http.req', id: 'next', method: 'GET', path: '/ping', headers: {} });
      expect(await client.next()).toMatchObject({ id: 'next', status: 200 });
      expect(client.frames).toHaveLength(0);
    } finally {
      body.destroy();
      caller.destroy();
      stream.destroy();
      await app.close();
    }
  });

  it.each(['cancel frame', 'transport disconnect'])('closes a pending HTTP response on %s', async (action) => {
    const app = Fastify();
    const stream = new PassThrough();
    const closed = vi.fn();
    let started!: () => void;
    let release!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    app.post('/held', async (_req, reply) => {
      reply.raw.once('close', closed);
      started();
      await held;
      return { done: true };
    });
    attachRpcStream(stream, { app, wssV1: new WebSocketServer({ noServer: true }) });
    try {
      stream.write(`${JSON.stringify({
        type: 'http.req', id: 'held', method: 'POST', path: '/held',
        headers: { 'content-type': 'application/json' }, body: Buffer.from('{}').toString('base64'),
      })}\n`);
      await requestStarted;
      if (action === 'cancel frame') stream.write(`${JSON.stringify({ type: 'http.cancel', id: 'held' })}\n`);
      else stream.destroy();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    } finally {
      release();
      stream.destroy();
      await app.close();
    }
  });

  it.skipIf(process.platform === 'win32')('serves HTTP requests and WebSocket upgrades on the same unix domain socket as the RPC stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-rpc-http-'));
    const socketPath = join(dir, 'daemon.sock');
    const app = Fastify();
    app.post('/api/v1/echo', async (req) => ({ body: req.body, host: req.headers.host }));
    const wssV1 = new WebSocketServer({ noServer: true });
    wssV1.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        ws.send(isBinary ? data : `ack:${Buffer.isBuffer(data) ? data.toString('utf8') : ''}`, { binary: isBinary });
      });
    });
    app.server.on('upgrade', (req, socket, head) => {
      wssV1.handleUpgrade(req, socket, head, (ws) => wssV1.emit('connection', ws, req));
    });
    await app.ready();

    const rpcServer = await startUnixRpcServer(socketPath, { app, wssV1 });
    const rpc = rpcClient(socketPath);
    let ws: NodeWebSocket | undefined;
    try {
      await expect(socketRequest(socketPath, 'POST', '/api/v1/echo', { ping: 1 })).resolves.toEqual({
        status: 200,
        body: { body: { ping: 1 }, host: 'localhost' },
      });

      ws = await openSocketWebSocket(socketPath, '/api/v1/ws');
      const text = new Promise<string>((resolve) => ws!.once('message', (data: Buffer) => resolve(data.toString('utf8'))));
      ws.send('hi');
      await expect(text).resolves.toBe('ack:hi');
      const binary = new Promise<number>((resolve) => ws!.once('message', (data: Buffer) => resolve(data.length)));
      ws.send(Buffer.alloc(70_000, 1), { binary: true });
      await expect(binary).resolves.toBe(70_000);

      rpc.send({
        type: 'http.req',
        id: 'rpc-1',
        method: 'POST',
        path: '/api/v1/echo',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ ping: 2 })).toString('base64'),
      });
      const rpcRes = await rpc.next();
      expect(rpcRes['status']).toBe(200);
      expect(JSON.parse(Buffer.from(rpcRes['body'] as string, 'base64').toString('utf8'))).toEqual({
        body: { ping: 2 },
        host: '127.0.0.1',
      });
    } finally {
      ws?.terminate();
      rpc.socket.destroy();
      await rpcServer.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    app.get('/large', async () => Buffer.alloc(DEVICE_RPC_MAX_BODY_BYTES + 1));
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
      await vi.advanceTimersByTimeAsync(RPC_BACKPRESSURE_TIMEOUT_MS - 1);
      expect(connected.readyState).toBe(connected.OPEN);
      stream.emit('drain');
      connected.send('third');
      await vi.advanceTimersByTimeAsync(RPC_BACKPRESSURE_TIMEOUT_MS - 1);
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

describe('managed daemon socket', () => {
  it.skipIf(process.platform === 'win32')('serves HTTP without a bearer token and stays busy while a front end holds a WebSocket lease', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-daemon-'));
    const socketPath = join(homeDir, 'daemon.sock');
    const daemon = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir,
      logLevel: 'silent',
      socketPath,
      managedBy: 'ensure-daemon',
      env: { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' },
    });
    const lease = rpcClient(socketPath);
    let ws: NodeWebSocket | undefined;
    try {
      await expect(socketRequest(socketPath, 'GET', '/api/v1/meta')).resolves.toMatchObject({
        status: 200,
        body: { data: { server_version: expect.any(String) } },
      });
      ws = await openSocketWebSocket(socketPath, '/api/v1/ws');
      await vi.waitFor(() => expect(daemon.connectionRegistry.size()).toBe(1));
      ws.close();
      await vi.waitFor(() => expect(daemon.connectionRegistry.size()).toBe(0));

      lease.send({ type: 'ws.open', id: 'lease', path: '/api/v1/ws' });
      await vi.waitFor(() => expect(daemon.connectionRegistry.size()).toBe(1));
      await expect(socketRequest(socketPath, 'POST', '/api/v1/shutdown?if_idle=true')).resolves.toMatchObject({
        status: 200,
        body: { data: { ok: false } },
      });
      lease.socket.destroy();
      await vi.waitFor(() => expect(daemon.connectionRegistry.size()).toBe(0));
    } finally {
      ws?.terminate();
      lease.socket.destroy();
      await daemon.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('upgrades through POST /api/v1/system:upgrade and exits once idle after a newer version is installed, even with a front end attached', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-daemon-upgrade-'));
    const socketPath = join(homeDir, 'daemon.sock');
    const upgrades: Array<(result: HostCommandResult) => void> = [];
    let installedVersion = '1.0.0';
    const runHostCommand = vi.fn((args: readonly string[]) =>
      args[0] === 'upgrade'
        ? new Promise<HostCommandResult>((resolve) => {
            upgrades.push(resolve);
          })
        : Promise.resolve({ code: 0, output: `${installedVersion}\n` }),
    );
    const daemon = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir,
      logLevel: 'silent',
      socketPath,
      managedBy: 'ensure-daemon',
      serverVersion: '1.0.0',
      runHostCommand,
      env: { KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' },
    });
    const lease = rpcClient(socketPath);
    const leaseClosed = new Promise<void>((resolve) => {
      lease.socket.once('close', () => resolve());
    });
    const startUpgrade = () => socketRequest(socketPath, 'POST', '/api/v1/system:upgrade');
    const upgradeState = async () => ((await socketRequest(socketPath, 'GET', '/api/v1/system:upgrade')).body as { data: Record<string, unknown> }).data;
    try {
      await expect(socketRequest(socketPath, 'GET', '/api/v1/meta')).resolves.toMatchObject({
        body: { data: { capabilities: { system_upgrade: true } } },
      });
      await expect(upgradeState()).resolves.toEqual({ state: 'idle' });

      await expect(startUpgrade()).resolves.toMatchObject({ status: 200, body: { data: { started: true } } });
      await expect(startUpgrade()).resolves.toMatchObject({ body: { data: { started: true } } });
      await expect(upgradeState()).resolves.toEqual({ state: 'installing' });
      expect(runHostCommand).toHaveBeenCalledTimes(1);
      upgrades[0]!({ code: 1, output: 'error: failed to check for updates: fetch failed\n' });
      await vi.waitFor(async () => {
        expect(await upgradeState()).toEqual({ state: 'failed', message: 'error: failed to check for updates: fetch failed' });
      });

      await startUpgrade();
      upgrades[1]!({ code: 0, output: 'Kimi Code is already up to date (v1.0.0).\n' });
      await vi.waitFor(async () => {
        expect(await upgradeState()).toEqual({ state: 'failed', message: 'Kimi Code is already up to date (v1.0.0).' });
      });

      lease.send({ type: 'ws.open', id: 'lease', path: '/api/v1/ws' });
      await vi.waitFor(() => expect(daemon.connectionRegistry.size()).toBe(1));
      installedVersion = '2.0.0';
      await startUpgrade();
      upgrades[2]!({ code: 0, output: 'Updated @moonshot-ai/kimi-code to 2.0.0. Restart the CLI to use the new version.\n' });
      await leaseClosed;
      expect(lease.frames).toContainEqual({
        type: 'ws.close',
        id: 'lease',
        code: SERVER_UPGRADED_CLOSE_CODE,
        reason: 'Kimi Code 2.0.0 is installed; this server is restarting',
      });
      await daemon.close();
      expect(existsSync(socketPath)).toBe(false);
      expect(runHostCommand.mock.calls.map(([args]) => args)).toEqual([
        ['upgrade', '--yes'],
        ['upgrade', '--yes'],
        ['--version'],
        ['upgrade', '--yes'],
        ['--version'],
      ]);
    } finally {
      lease.socket.destroy();
      await daemon.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30_000);
});
