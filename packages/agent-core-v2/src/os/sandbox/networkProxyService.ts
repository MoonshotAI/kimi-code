

import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket, connect } from 'node:net';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  INetworkProxyService,
  type EgressDecider,
  type EgressDecision,
  type NetworkProxyRegistration,
} from './networkProxy';

const MAX_HEADER_BYTES = 16 * 1024;

interface ProxyPorts {
  readonly httpPort: number;
  readonly socksPort: number;
}

function tokenFromProxyAuth(headers: string): string | undefined {
  const match = /(?:^|\r\n)proxy-authorization:\s*basic\s+(\S+)/i.exec(headers);
  if (match === null) return undefined;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon > 0 ? decoded.slice(0, colon) : undefined;
}

async function decideFor(
  deciders: ReadonlyMap<string, EgressDecider>,
  token: string | undefined,
  host: string,
  protocol: 'http' | 'connect' | 'socks5',
): Promise<EgressDecision> {
  const decide = token === undefined ? undefined : deciders.get(token);
  return decide === undefined ? 'deny' : decide(host, protocol);
}

function handleHttp(client: Socket, deciders: ReadonlyMap<string, EgressDecider>, report: (d: string, p: 'http' | 'connect') => void): void {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const headEnd = buffer.indexOf('\r\n\r\n');
    if (headEnd < 0) {
      if (buffer.length > MAX_HEADER_BYTES) client.destroy();
      return;
    }
    client.off('data', onData);
    void onHead(buffer.subarray(0, headEnd), buffer.subarray(headEnd + 4));
  };
  const onHead = async (headBuf: Buffer, rest: Buffer): Promise<void> => {
    const head = headBuf.toString('latin1');
    const requestLine = head.split('\r\n', 1)[0] ?? '';
    const method = requestLine.split(' ')[0]?.toUpperCase() ?? '';
    const target = requestLine.split(' ')[1] ?? '';
    const token = tokenFromProxyAuth(head);

    if (method === 'CONNECT') {
      const sep = target.lastIndexOf(':');
      const host = sep > 0 ? target.slice(0, sep) : '';
      const port = sep > 0 ? Number(target.slice(sep + 1)) : 0;
      const decision = await decideFor(deciders, token, host, 'connect');
      report(decision, 'connect');
      if (decision !== 'allow' || host === '' || !(port > 0 && port < 65536)) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = connect(port, host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      return;
    }

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const host = url.hostname;
    const port = url.port === '' ? 80 : Number(url.port);
    const decision = await decideFor(deciders, token, host, 'http');
    report(decision, 'http');
    if (decision !== 'allow') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const rewrittenHead = head
      .replace(requestLine, `${method} ${url.pathname}${url.search} ${requestLine.split(' ')[2] ?? 'HTTP/1.1'}`)
      .split('\r\n')
      .filter((line) => !/^proxy-(authorization|connection):/i.test(line))
      .join('\r\n');
    const upstream = connect(port, host, () => {
      upstream.write(`${rewrittenHead}\r\n\r\n`);
      if (rest.length > 0) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  };
  client.on('data', onData);
  client.on('error', () => {});
}

class SockReader {
  private bufs: Buffer[] = [];
  private ended = false;
  private waiter: { n: number; resolve: (b: Buffer | undefined) => void } | undefined;

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.bufs.push(chunk);
      this.flush();
    });
    const end = (): void => {
      this.ended = true;
      this.flush();
    };
    socket.once('end', end);
    socket.once('error', end);
  }

  private buffered(): number {
    return this.bufs.reduce((n, b) => n + b.length, 0);
  }

  private flush(): void {
    const waiter = this.waiter;
    if (waiter === undefined) return;
    if (this.buffered() >= waiter.n) {
      const all = Buffer.concat(this.bufs);
      this.bufs = [all.subarray(waiter.n)];
      this.waiter = undefined;
      waiter.resolve(all.subarray(0, waiter.n));
    } else if (this.ended) {
      this.waiter = undefined;
      waiter.resolve(undefined);
    }
  }

  read(n: number): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      this.waiter = { n, resolve };
      this.flush();
    });
  }
}

async function handleSocks(
  client: Socket,
  deciders: ReadonlyMap<string, EgressDecider>,
  report: (d: string, p: 'socks5') => void,
): Promise<void> {
  const reader = new SockReader(client);
  const greeting = await reader.read(2);
  if (greeting === undefined || greeting[0] !== 0x05 || greeting[1] === 0) {
    client.destroy();
    return;
  }
  const methods = await reader.read(greeting[1]!);
  if (methods === undefined) {
    client.destroy();
    return;
  }
  client.write(Buffer.from([0x05, 0x02]));
  const authHead = await reader.read(2);
  if (authHead === undefined || authHead[0] !== 0x01) {
    client.destroy();
    return;
  }
  const ulen = authHead[1]!;
  const user = await reader.read(ulen + 1);
  if (user === undefined || user.length < ulen + 1) {
    client.destroy();
    return;
  }
  const token = user.subarray(0, ulen).toString('utf8');
  const plen = user[ulen]!;
  if (plen > 0) {
    const password = await reader.read(plen);
    if (password === undefined) {
      client.destroy();
      return;
    }
  }
  client.write(Buffer.from([0x01, 0x00]));
  const request = await reader.read(4);
  if (request === undefined || request[0] !== 0x05 || request[1] !== 0x01) {
    client.destroy();
    return;
  }
  const atyp = request[3]!;
  let host = '';
  if (atyp === 0x01) {
    const addr = await reader.read(4);
    if (addr === undefined) {
      client.destroy();
      return;
    }
    host = [...addr].join('.');
  } else if (atyp === 0x03) {
    const lenBuf = await reader.read(1);
    if (lenBuf === undefined) {
      client.destroy();
      return;
    }
    const nameBuf = await reader.read(lenBuf[0]!);
    if (nameBuf === undefined) {
      client.destroy();
      return;
    }
    host = nameBuf.toString('utf8');
  } else if (atyp === 0x04) {
    const addr = await reader.read(16);
    if (addr === undefined) {
      client.destroy();
      return;
    }
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(addr.readUInt16BE(i).toString(16));
    host = parts.join(':');
  } else {
    client.destroy();
    return;
  }
  const portBuf = await reader.read(2);
  if (portBuf === undefined) {
    client.destroy();
    return;
  }
  const port = portBuf.readUInt16BE(0);
  const decision = await decideFor(deciders, token, host, 'socks5');
  report(decision, 'socks5');
  if (decision !== 'allow') {
    client.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    return;
  }
  const upstream = connect(port, host, () => {
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no loopback address'));
        return;
      }
      resolve(address.port);
    });
  });
}

export class LoopbackNetworkProxyService implements INetworkProxyService {
  declare readonly _serviceBrand: undefined;

  private readonly deciders = new Map<string, EgressDecider>();
  private servers: Promise<ProxyPorts | undefined> | undefined;
  private httpServer: Server | undefined;
  private socksServer: Server | undefined;

  constructor(
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async acquire(decide: EgressDecider): Promise<NetworkProxyRegistration | undefined> {
    const ports = await this.ensureStarted();
    if (ports === undefined) return undefined;
    const token = randomBytes(12).toString('hex');
    this.deciders.set(token, decide);
    const auth = `${token}:x@127.0.0.1`;
    return {
      token,
      httpPort: ports.httpPort,
      socksPort: ports.socksPort,
      env: {
        HTTP_PROXY: `http://${auth}:${ports.httpPort}`,
        HTTPS_PROXY: `http://${auth}:${ports.httpPort}`,
        ALL_PROXY: `socks5://${auth}:${ports.socksPort}`,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        http_proxy: `http://${auth}:${ports.httpPort}`,
        https_proxy: `http://${auth}:${ports.httpPort}`,
        all_proxy: `socks5://${auth}:${ports.socksPort}`,
        no_proxy: 'localhost,127.0.0.1,::1',
      },
      dispose: () => {
        this.release(token);
      },
    };
  }

  release(token: string): void {
    this.deciders.delete(token);
    if (this.deciders.size === 0) this.stopServers();
  }

  private ensureStarted(): Promise<ProxyPorts | undefined> {
    this.servers ??= this.startServers();
    return this.servers;
  }

  private async startServers(): Promise<ProxyPorts | undefined> {
    try {
      const report = (d: string, protocol: string): void => {
        this.telemetry.track2('network_egress_decision', {
          decision: d,
          protocol,
        });
      };
      this.httpServer = createServer((socket) => {
        handleHttp(socket, this.deciders, report);
      });
      this.socksServer = createServer((socket) => {
        void handleSocks(socket, this.deciders, report);
      });
      const [httpPort, socksPort] = await Promise.all([
        listen(this.httpServer),
        listen(this.socksServer),
      ]);
      this.telemetry.track2('network_proxy_started', {
        http_port: httpPort,
        socks_port: socksPort,
      });
      return { httpPort, socksPort };
    } catch (error) {
      this.log.warn(`network proxy failed to start: ${String(error)}`);
      this.servers = undefined;
      return undefined;
    }
  }

  private stopServers(): void {
    this.httpServer?.close();
    this.socksServer?.close();
    this.httpServer = undefined;
    this.socksServer = undefined;
    this.servers = undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  INetworkProxyService,
  LoopbackNetworkProxyService,
  ScopeActivation.OnDemand,
  'os/sandbox',
);
