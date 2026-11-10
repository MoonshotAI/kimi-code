import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { HOST_PROTOCOL_VERSION } from '../src/services/hosts/hostProtocol';
import { matchHostProxyPath, upstreamHeaders } from '../src/services/hosts/hostProxy';
import { hostsSectionSchema, isValidHostId } from '../src/services/hosts/hostsConfig';
import {
  HostConnectError,
  SshKapBridge,
  classifySshFailure,
  parseBootstrapOutput,
  parseProbeOutput,
  remoteBinCommand,
  remoteKimiCommand,
} from '../src/services/hosts/sshKapBridge';
import { startUnixRpcServer } from '../src/transport/stdioRpc';

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
    const stdout = `welcome\n1.0.0\n__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"pid":42,"version":"1.0.0"}\n`;
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

  it.each([
    ['version_mismatch_busy', 'remote_busy'],
    ['start_timeout', 'remote_start_failed'],
    ['lock_timeout', 'remote_start_failed'],
    ['something_new', 'unknown'],
  ] as const)('maps the ensure-daemon error %s to %s', (code, failure) => {
    const stdout = `__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"version":"2.0.0","error":"${code}","message":"m"}\n`;
    const error = thrown(() => parseBootstrapOutput(stdout));
    expect(error.failure).toBe(failure);
    expect(error.remoteVersion).toBe('2.0.0');
  });

  it('reads the protocol and version from a probe', () => {
    expect(parseProbeOutput(`__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"version":"2.0.0"}\n`)).toEqual({
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
      for (let attempt = 0; attempt < 50 && pid === 0; attempt += 1) {
        try {
          pid = Number.parseInt(readFileSync(pidfile, 'utf8'), 10);
        } catch {
          await sleep(20);
        }
      }
      expect(pid).toBeGreaterThan(0);
      bridge.dispose();
      await expect(pending).rejects.toBeInstanceOf(HostConnectError);
      expect(() => process.kill(pid, 0)).toThrow();
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
echo '__KIMI_ENSURE_DAEMON__{"protocol":${String(HOST_PROTOCOL_VERSION)},"pid":100,"version":"1.2.3"}'
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
            onClose: () => resolve(),
          });
        });
        expect(messages).toEqual(['hello']);
        await sleep(30);
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
      const lines: string[] = [];
      let onLine: (() => void) | undefined;
      client.setEncoding('utf8').on('data', (chunk: string) => {
        for (const part of chunk.split('\n')) {
          if (part.trim().length > 0) {
            lines.push(part.trim());
            onLine?.();
          }
        }
      });

      const nextLine = async (): Promise<Record<string, unknown>> => {
        while (lines.length === 0) {
          await new Promise<void>((resolve) => {
            onLine = resolve;
          });
        }
        return JSON.parse(lines.shift()!) as Record<string, unknown>;
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
});
