import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ILogService } from '#/_base/log/log';
import type { IFlagService } from '#/app/flag/flag';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ArtexTrafficStoreProvider } from '#/features/artex/store/artexTrafficStoreProvider';

import { ArtexProxyCa } from './artexProxyCa';
import { ArtexTrafficRecorder } from './artexTrafficRecorder';

function stubFlags(enabled: boolean): IFlagService {
  return { enabled: (id: string) => id === ARTEX_FLAG_ID && enabled } as unknown as IFlagService;
}

function stubLog(): { log: ILogService; warnings: string[] } {
  const warnings: string[] = [];
  const log = {
    warn: (message: string) => warnings.push(message),
    error: () => {},
    info: () => {},
    debug: () => {},
    child: () => log,
  } as unknown as ILogService;
  return { log, warnings };
}

function sessionContext(workspaceRoot: string): IArtexSessionContext {
  let active: number | undefined;
  return {
    _serviceBrand: undefined,
    workspaceRoot,
    getActiveExplorationId: () => active,
    setActiveExplorationId: (id: number | undefined) => {
      active = id;
    },
  } as IArtexSessionContext;
}

async function startUpstream(handler: http.RequestListener, secure: boolean): Promise<http.Server | https.Server> {
  let server: http.Server | https.Server;
  if (secure) {
    const ca = await ArtexProxyCa.load(await mkdtemp(join(tmpdir(), 'artex-upstream-ca-')));
    const leaf = ca.leafFor('127.0.0.1');
    server = https.createServer({ key: leaf.key, cert: leaf.cert }, handler);
  } else {
    server = http.createServer(handler);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function proxyParts(proxyUrl: string): { host: string; port: number } {
  const url = new URL(proxyUrl);
  return { host: url.hostname, port: Number(url.port) };
}

function httpThroughProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const { host, port } = proxyParts(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: 'GET',
        path: targetUrl,
        headers: { Host: target.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function httpsThroughProxy(
  proxyUrl: string,
  caCertPath: string,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  const { host, port } = proxyParts(proxyUrl);
  const target = new URL(targetUrl);
  const ca = await readFile(caCertPath, 'utf8');
  const tunnel = await new Promise<net.Socket>((resolve, reject) => {
    const connectReq = http.request({ host, port, method: 'CONNECT', path: `${target.hostname}:${target.port}` });
    connectReq.on('connect', (_res, socket) => resolve(socket));
    connectReq.on('error', reject);
    connectReq.end();
  });
  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      { socket: tunnel, servername: target.hostname, ca, rejectUnauthorized: true },
      () => {
        secure.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      },
    );
    const chunks: Buffer[] = [];
    secure.on('data', (chunk: Buffer) => chunks.push(chunk));
    secure.on('error', reject);
    secure.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [headLine] = text.split('\r\n');
      const status = Number(headLine?.split(' ')[1] ?? 0);
      const body = text.slice(text.indexOf('\r\n\r\n') + 4);
      resolve({ status, body });
    });
  });
}

describe('ArtexTrafficRecorder', () => {
  let workspaceRoot: string;
  let provider: ArtexTrafficStoreProvider;
  const servers: Array<http.Server | https.Server> = [];
  let recorder: ArtexTrafficRecorder | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'artex-recorder-'));
    provider = new ArtexTrafficStoreProvider();
  });

  afterEach(async () => {
    await recorder?.stop();
    recorder = undefined;
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  function makeRecorder(flagEnabled = true): { warnings: string[] } {
    const { log, warnings } = stubLog();
    recorder = new ArtexTrafficRecorder(sessionContext(workspaceRoot), provider, stubFlags(flagEnabled), log);
    return { warnings };
  }

  it('records a plaintext HTTP exchange that passes through the forward proxy', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello-from-upstream');
    }, false);
    servers.push(upstream);
    const upPort = (upstream.address() as AddressInfo).port;

    makeRecorder();
    const state = await recorder!.ensureStarted();
    expect(state.status).toBe('recording');

    const result = await httpThroughProxy(state.proxyUrl!, `http://127.0.0.1:${String(upPort)}/probe?q=1`);
    expect(result.status).toBe(200);
    expect(result.body).toBe('hello-from-upstream');

    const store = recorder!.store();
    const found = await store.search({ host: '127.0.0.1', contains: 'probe' });
    expect(found.length).toBe(1);
    expect(found[0]!.status).toBe(200);
    const bodies = await store.rawBodies(found[0]!.id);
    expect(bodies?.response).toContain('hello-from-upstream');
  }, 30_000);

  it('records an HTTPS exchange via MITM that the worker trusts through the CA cert', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, true);
    servers.push(upstream);
    const upPort = (upstream.address() as AddressInfo).port;

    makeRecorder();
    const state = await recorder!.ensureStarted();
    expect(state.status).toBe('recording');
    expect(state.caCertPath).toBeDefined();

    const result = await httpsThroughProxy(
      state.proxyUrl!,
      state.caCertPath!,
      `https://127.0.0.1:${String(upPort)}/secure`,
    );
    expect(result.status).toBe(201);
    expect(result.body).toContain('{"ok":true}');

    const found = await recorder!.store().search({ host: '127.0.0.1', contains: 'secure' });
    expect(found.length).toBe(1);
    expect(found[0]!.status).toBe(201);
  }, 30_000);

  it('exposes proxy + CA env overlay only while recording', async () => {
    makeRecorder();
    expect(recorder!.proxyEnvOverlay()).toBeUndefined();
    const state = await recorder!.ensureStarted();
    const overlay = recorder!.proxyEnvOverlay();
    expect(overlay).toBeDefined();
    expect(overlay!['HTTP_PROXY']).toBe(state.proxyUrl);
    expect(overlay!['HTTPS_PROXY']).toBe(state.proxyUrl);
    expect(overlay!['NODE_EXTRA_CA_CERTS']).toBe(state.caCertPath);
    expect(overlay!['SSL_CERT_FILE']).toBe(state.caCertPath);
  }, 30_000);

  it('stays off and injects nothing when the flag is disabled', async () => {
    makeRecorder(false);
    const state = await recorder!.ensureStarted();
    expect(state.status).toBe('off');
    expect(recorder!.isRecording).toBe(false);
    expect(recorder!.proxyEnvOverlay()).toBeUndefined();
  });

  it('surfaces "recording unavailable" loudly instead of pretending to record', async () => {
    const { warnings } = makeRecorder();
    const failure = new Error('cert trust could not be established');
    vi.spyOn(ArtexProxyCa, 'load').mockRejectedValueOnce(failure);

    const state = await recorder!.ensureStarted();
    expect(state.status).toBe('unavailable');
    expect(state.reason).toContain('cert trust could not be established');
    expect(recorder!.isRecording).toBe(false);
    expect(recorder!.proxyEnvOverlay()).toBeUndefined();
    expect(warnings.some((line) => line.includes('recording unavailable'))).toBe(true);
  }, 30_000);
});
