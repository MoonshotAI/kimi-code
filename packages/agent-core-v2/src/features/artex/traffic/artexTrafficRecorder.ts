import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import type { FileArtexTrafficStore } from '#/features/artex/store/fileArtexTrafficStore';
import { IArtexTrafficStoreProvider } from '#/features/artex/store/artexTrafficStoreProvider';

import { ArtexProxyCa } from './artexProxyCa';

export const ARTEX_RECORDING_STATUSES = ['off', 'recording', 'unavailable'] as const;
export type ArtexRecordingStatus = (typeof ARTEX_RECORDING_STATUSES)[number];

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;

export interface ArtexRecordingState {
  readonly status: ArtexRecordingStatus;
  readonly proxyUrl?: string;
  readonly caCertPath?: string;
  readonly reason?: string;
}

export interface IArtexTrafficRecorder {
  readonly _serviceBrand: undefined;
  readonly state: ArtexRecordingState;
  readonly isRecording: boolean;
  ensureStarted(): Promise<ArtexRecordingState>;
  stop(): Promise<void>;
  store(): FileArtexTrafficStore;
  /**
   * The env vars a worker subprocess sets to route through — and trust — the
   * recorder. Returns undefined when recording is not active, so a caller never
   * points a subprocess at a proxy that is not there.
   */
  proxyEnvOverlay(): Record<string, string> | undefined;
}

export const IArtexTrafficRecorder: ServiceIdentifier<IArtexTrafficRecorder> =
  createDecorator<IArtexTrafficRecorder>('artexTrafficRecorder');

/**
 * Session-scoped recording proxy. On start it stands up a loopback forward
 * HTTP(S) proxy backed by a locally-generated CA and records every exchange the
 * feature's worker subprocesses make through it. If the proxy or its certificate
 * trust cannot be established, the state is set to `unavailable` with a reason and
 * logged loudly — recording is never silently treated as succeeding.
 */
export class ArtexTrafficRecorder extends Disposable implements IArtexTrafficRecorder {
  declare readonly _serviceBrand: undefined;

  private current: ArtexRecordingState = { status: 'off' };
  private starting: Promise<ArtexRecordingState> | undefined;
  private server: http.Server | undefined;
  private mitm: http.Server | undefined;
  private ca: ArtexProxyCa | undefined;
  private readonly secureContexts = new Map<string, tls.SecureContext>();
  private readonly trafficStore: FileArtexTrafficStore;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexTrafficStoreProvider provider: IArtexTrafficStoreProvider,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.trafficStore = provider.open(this.session.workspaceRoot);
    this._register({ dispose: () => void this.stop() });
  }

  get state(): ArtexRecordingState {
    return this.current;
  }

  get isRecording(): boolean {
    return this.current.status === 'recording';
  }

  store(): FileArtexTrafficStore {
    return this.trafficStore;
  }

  ensureStarted(): Promise<ArtexRecordingState> {
    if (this.current.status === 'recording') return Promise.resolve(this.current);
    this.starting ??= this.start();
    return this.starting;
  }

  proxyEnvOverlay(): Record<string, string> | undefined {
    if (this.current.status !== 'recording' || this.current.proxyUrl === undefined) return undefined;
    return proxyEnv(this.current.proxyUrl, this.current.caCertPath);
  }

  private async start(): Promise<ArtexRecordingState> {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) {
      this.current = { status: 'off' };
      return this.current;
    }
    try {
      this.ca = await ArtexProxyCa.load(this.session.workspaceRoot);
      const mitm = this.buildMitmServer();
      const server = await this.listen(this.buildProxyServer());
      this.server = server;
      this.mitm = mitm;
      const address = server.address() as AddressInfo;
      this.current = {
        status: 'recording',
        proxyUrl: `http://127.0.0.1:${String(address.port)}`,
        caCertPath: this.ca.certPath,
      };
      return this.current;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.current = { status: 'unavailable', reason };
      this.log.warn(
        `[artex] traffic recording unavailable; worker HTTP will NOT be recorded: ${reason}`,
      );
      return this.current;
    }
  }

  async stop(): Promise<void> {
    this.starting = undefined;
    const close = (server: http.Server | undefined): Promise<void> =>
      server === undefined ? Promise.resolve() : new Promise((resolve) => server.close(() => resolve()));
    await Promise.all([close(this.server), close(this.mitm)]);
    this.server = undefined;
    this.mitm = undefined;
    this.secureContexts.clear();
    if (this.current.status === 'recording') this.current = { status: 'off' };
  }

  private listen(server: http.Server): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });
  }

  private buildProxyServer(): http.Server {
    const server = http.createServer((req, res) => void this.handleHttp(req, res));
    server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head));
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    server.on('clientError', (_err, socket) => socket.destroy());
    return server;
  }

  private buildMitmServer(): http.Server {
    const server = http.createServer((req, res) => void this.handleMitm(req, res));
    server.on('upgrade', (req, socket, head) => {
      this.handleMitmUpgrade(req, socket, head);
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    return server;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('bad proxy request');
      return;
    }
    const { body: reqBody, full: reqFull } = await readBody(req, MAX_CAPTURE_BYTES);
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upRes) => void this.relay(req, res, upRes, target, reqBody),
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.end(reqFull);
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const [host, portText] = (req.url ?? '').split(':');
    if (host === undefined || host === '') {
      clientSocket.destroy();
      return;
    }
    const port = Number(portText) || 443;
    clientSocket.on('error', () => clientSocket.destroy());
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let context: tls.SecureContext;
    try {
      context = this.secureContextFor(host);
    } catch {
      clientSocket.destroy();
      return;
    }
    const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext: context });
    tlsSocket.on('error', () => tlsSocket.destroy());
    Object.assign(tlsSocket, { artexHost: host, artexPort: port });
    if (head.length > 0) tlsSocket.unshift(head);
    this.mitm?.emit('connection', tlsSocket);
  }

  private async handleMitm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const socket = req.socket as net.Socket & { artexHost?: string; artexPort?: number };
    const host = socket.artexHost ?? req.headers.host?.split(':')[0] ?? '';
    const port = socket.artexPort ?? 443;
    const { body: reqBody, full: reqFull } = await readBody(req, MAX_CAPTURE_BYTES);
    const target = httpsTargetUrl(host, port, req.url ?? '/');
    const upstream = https.request(
      {
        hostname: host,
        port,
        method: req.method,
        path: req.url,
        headers: req.headers,
        servername: net.isIP(host) === 0 ? host : undefined,
        // The proxy is the trust boundary: the worker trusts the MITM CA, and the
        // proxy dials the real target without verifying its cert (mirrors the
        // reference's SslInsecure upstream) so recording never breaks TLS.
        rejectUnauthorized: false,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upRes) => void this.relay(req, res, upRes, target, reqBody),
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.end(reqFull);
  }

  private async relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    upRes: http.IncomingMessage,
    target: URL,
    reqBody: Buffer,
  ): Promise<void> {
    const respCapture = await streamThrough(upRes, res, MAX_CAPTURE_BYTES);
    const respBody = respCapture.body;
    try {
      await this.trafficStore.record({
        host: target.hostname,
        method: req.method ?? 'GET',
        url: target.toString(),
        status: upRes.statusCode ?? 0,
        contentType: headerValue(upRes.headers['content-type']),
        reqHead: requestHead(req, target),
        respHead: responseHead(upRes),
        reqBody,
        respBody,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.warn(`[artex] failed to record ${target.toString()}: ${reason}`);
    }
    if (!respCapture.headersSent) {
      res.writeHead(upRes.statusCode ?? 200, upRes.headers);
    }
    if (!res.writableEnded) res.end();
  }

  private handleUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const [host, portText] = (req.url ?? '').split(':');
    if (host === undefined || host === '') {
      clientSocket.destroy();
      return;
    }
    const port = Number(portText) || 443;
    const upstream = net.connect({ host, port, timeout: UPSTREAM_TIMEOUT_MS }, () => {
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('timeout', () => {
      upstream.destroy();
      clientSocket.destroy();
    });
  }

  private handleMitmUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const socket = req.socket as net.Socket & { artexHost?: string; artexPort?: number };
    const host = socket.artexHost ?? req.headers.host?.split(':')[0] ?? '';
    const port = socket.artexPort ?? 443;
    if (host === '') {
      clientSocket.destroy();
      return;
    }
    const upstream = tls.connect(
      { host, port, servername: net.isIP(host) === 0 ? host : undefined, rejectUnauthorized: false },
      () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  }

  private secureContextFor(host: string): tls.SecureContext {
    const cached = this.secureContexts.get(host);
    if (cached !== undefined) return cached;
    if (this.ca === undefined) throw new Error('certificate authority not initialized');
    const leaf = this.ca.leafFor(host);
    const context = tls.createSecureContext({ key: leaf.key, cert: leaf.cert });
    this.secureContexts.set(host, context);
    return context;
  }
}

/**
 * The Bash-subprocess env that routes child-command HTTP through the recording
 * proxy and makes the common toolchain trust its MITM CA (so tools need no manual
 * -x/--proxy/-k). Each ecosystem reads a different CA var: SSL_CERT_FILE for
 * curl/urllib/Go/openssl, REQUESTS_CA_BUNDLE for python requests, CURL_CA_BUNDLE
 * for curl, GIT_SSL_CAINFO for git, NODE_EXTRA_CA_CERTS for node; NODE_USE_ENV_PROXY
 * makes Node 24+ honor the proxy vars. ALL_PROXY covers a socks5 egress proxy.
 */
function proxyEnv(proxyUrl: string, caCertPath: string | undefined): Record<string, string> {
  const overlay: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NODE_USE_ENV_PROXY: '1',
  };
  if (caCertPath !== undefined) {
    overlay['SSL_CERT_FILE'] = caCertPath;
    overlay['CURL_CA_BUNDLE'] = caCertPath;
    overlay['REQUESTS_CA_BUNDLE'] = caCertPath;
    overlay['GIT_SSL_CAINFO'] = caCertPath;
    overlay['NODE_EXTRA_CA_CERTS'] = caCertPath;
  }
  return overlay;
}

async function readBody(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<{ readonly body: Buffer; readonly full: Buffer }> {
  return new Promise((resolve) => {
    const capture: Buffer[] = [];
    const full: Buffer[] = [];
    let captured = 0;
    const onData = (chunk: Buffer): void => {
      full.push(chunk);
      if (captured < cap) {
        const room = cap - captured;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        capture.push(slice);
        captured += slice.length;
      }
    };
    const finish = (): void => {
      stream.off('data', onData);
      resolve({ body: Buffer.concat(capture), full: Buffer.concat(full) });
    };
    stream.on('data', onData);
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
    stream.on('aborted', finish);
  });
}

async function streamThrough(
  upstream: http.IncomingMessage,
  downstream: http.ServerResponse,
  cap: number,
): Promise<{ readonly body: Buffer; readonly headersSent: boolean }> {
  downstream.writeHead(upstream.statusCode ?? 200, upstream.headers);
  const chunks: Buffer[] = [];
  let captured = 0;
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      downstream.write(chunk);
      if (captured < cap) {
        const room = cap - captured;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(slice);
        captured += slice.length;
      }
    };
    const finish = (): void => {
      upstream.off('data', onData);
      resolve();
    };
    upstream.on('data', onData);
    upstream.on('end', finish);
    upstream.on('close', finish);
    upstream.on('error', finish);
    upstream.on('aborted', finish);
  });
  return { body: Buffer.concat(chunks), headersSent: true };
}

function httpsTargetUrl(host: string, port: number, path: string): URL {
  if (net.isIP(host) === 6) {
    return new URL(`https://[${host}]:${String(port)}${path}`);
  }
  return new URL(`https://${host}:${String(port)}${path}`);
}

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function requestHead(req: http.IncomingMessage, target: URL): string {
  const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/${req.httpVersion}`];
  const headers = req.rawHeaders;
  for (let i = 0; i + 1 < headers.length; i += 2) {
    lines.push(`${headers[i]}: ${headers[i + 1]}`);
  }
  return `${lines.join('\n')}\n`;
}

function responseHead(res: http.IncomingMessage): string {
  const lines = [`HTTP ${String(res.statusCode ?? 0)}`];
  const headers = res.rawHeaders;
  for (let i = 0; i + 1 < headers.length; i += 2) {
    lines.push(`${headers[i]}: ${headers[i + 1]}`);
  }
  return `${lines.join('\n')}\n`;
}
