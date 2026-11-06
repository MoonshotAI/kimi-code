import { createServer, connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { stubLog } from '../../_base/log/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import type {
  EgressDecision,
  NetworkProxyRegistration,
} from '#/os/sandbox/networkProxy';
import { LoopbackNetworkProxyService } from '#/os/sandbox/networkProxyService';

function connectHttp(
  port: number,
  request: string,
): Promise<{ response: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(request);
    });
    socket.once('error', reject);
    let data = '';
    const onData = (chunk: Buffer): void => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve({ response: data, socket });
      }
    };
    socket.on('data', onData);
    socket.once('close', () => {
      resolve({ response: data, socket });
    });
    setTimeout(() => {
      resolve({ response: data, socket });
    }, 2000);
  });
}

describe('LoopbackNetworkProxyService', () => {
  let registration: NetworkProxyRegistration | undefined;

  afterEach(() => {
    registration?.dispose();
    registration = undefined;
  });

  async function acquireProxy(
    decide: (host: string) => EgressDecision,
  ): Promise<NetworkProxyRegistration> {
    const service = new LoopbackNetworkProxyService(stubLog(), recordingTelemetry([]));
    registration = await service.acquire(decide);
    if (registration === undefined) throw new Error('proxy did not start');
    return registration;
  }

  function authHeader(reg: NetworkProxyRegistration): string {
    return `Proxy-Authorization: Basic ${Buffer.from(`${reg.token}:x`).toString('base64')}`;
  }

  function echoServer(): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
      const server = createServer((socket) => socket.pipe(socket));
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as { port: number }).port,
          close: () => server.close(),
        });
      });
    });
  }

  it('tunnels an allowed CONNECT to the target', async () => {
    const echo = await echoServer();
    const reg = await acquireProxy(() => 'allow');
    const { response, socket } = await connectHttp(
      reg.httpPort,
      `CONNECT 127.0.0.1:${String(echo.port)} HTTP/1.1\r\n${authHeader(reg)}\r\n\r\n`,
    );
    expect(response).toContain('200');
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (c) => {
        resolve(c.toString());
      });
      socket.write('ping');
    });
    expect(echoed).toBe('ping');
    socket.destroy();
    echo.close();
  });

  it('rejects a denied CONNECT with 403', async () => {
    const reg = await acquireProxy(() => 'deny');
    const { response, socket } = await connectHttp(
      reg.httpPort,
      `CONNECT denied.example.com:443 HTTP/1.1\r\n${authHeader(reg)}\r\n\r\n`,
    );
    expect(response).toContain('403');
    socket.destroy();
  });

  it('rejects CONNECT without a registered token', async () => {
    const reg = await acquireProxy(() => 'allow');
    const { response, socket } = await connectHttp(
      reg.httpPort,
      'CONNECT 127.0.0.1:80 HTTP/1.1\r\n\r\n',
    );
    expect(response).toContain('403');
    socket.destroy();
  });

  it('forwards allowed absolute-URI HTTP requests with proxy headers stripped', async () => {
    let received = '';
    const upstream = createServer((socket) => {
      socket.on('data', (chunk) => {
        received += chunk.toString('latin1');
        if (received.includes('\r\n\r\n')) {
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
        }
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const reg = await acquireProxy(() => 'allow');
    const { response, socket } = await connectHttp(
      reg.httpPort,
      `GET http://127.0.0.1:${String(upstreamPort)}/path?q=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n${authHeader(reg)}\r\n\r\n`,
    );
    expect(response).toContain('200');
    expect(received).toContain('GET /path?q=1 HTTP/1.1');
    expect(received).not.toContain('Proxy-Authorization');
    socket.destroy();
    upstream.close();
  });

  it('answers the SOCKS5 handshake and connects allowed targets', async () => {
    const echo = await echoServer();
    const reg = await acquireProxy(() => 'allow');
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(reg.socksPort, '127.0.0.1', () => {
        socket.write(Buffer.from([0x05, 0x01, 0x02]));
      });
      socket.once('error', reject);
      let stage = 0;
      const onData = (chunk: Buffer): void => {
        if (stage === 0) {
          expect([...chunk.subarray(0, 2)]).toEqual([0x05, 0x02]);
          const user = Buffer.from(reg.token);
          const pass = Buffer.from('x');
          socket.write(
            Buffer.concat([
              Buffer.from([0x01, user.length]),
              user,
              Buffer.from([pass.length]),
              pass,
            ]),
          );
          stage = 1;
          return;
        }
        if (stage === 1) {
          expect([...chunk.subarray(0, 2)]).toEqual([0x01, 0x00]);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x01]),
            Buffer.from([127, 0, 0, 1]),
            Buffer.from([(echo.port >> 8) & 0xff, echo.port & 0xff]),
          ]);
          socket.write(req);
          stage = 2;
          return;
        }
        socket.off('data', onData);
        resolve(chunk);
      };
      socket.on('data', onData);
      setTimeout(() => {
        reject(new Error('socks handshake timeout'));
      }, 3000);
    });
    expect([...reply.subarray(0, 4)]).toEqual([0x05, 0x00, 0x00, 0x01]);
    echo.close();
  });

  it('returns a deny reply for denied SOCKS5 targets', async () => {
    const reg = await acquireProxy(() => 'deny');
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(reg.socksPort, '127.0.0.1', () => {
        socket.write(Buffer.from([0x05, 0x01, 0x02]));
      });
      socket.once('error', reject);
      let stage = 0;
      const onData = (chunk: Buffer): void => {
        if (stage === 0) {
          const user = Buffer.from(reg.token);
          socket.write(
            Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([1, 0x78])]),
          );
          stage = 1;
          return;
        }
        if (stage === 1) {
          const host = Buffer.from('denied.example.com');
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
              host,
              Buffer.from([0x01, 0xbb]),
            ]),
          );
          stage = 2;
          return;
        }
        socket.off('data', onData);
        resolve(chunk);
      };
      socket.on('data', onData);
      socket.on('close', () => {
        resolve(Buffer.alloc(0));
      });
      setTimeout(() => {
        reject(new Error('socks handshake timeout'));
      }, 3000);
    });
    expect(reply.length).toBeGreaterThan(0);
    expect(reply[1]).toBe(0x02);
  });

  it('produces proxy env with token userinfo and NO_PROXY for loopback', async () => {
    const reg = await acquireProxy(() => 'deny');
    expect(reg.env['HTTP_PROXY']).toContain(`${reg.token}:x@127.0.0.1`);
    expect(reg.env['HTTPS_PROXY']).toContain(`${reg.token}:x@127.0.0.1`);
    expect(reg.env['ALL_PROXY']).toContain(`socks5://${reg.token}:x@127.0.0.1`);
    expect(reg.env['NO_PROXY']).toContain('127.0.0.1');
  });
});
