// apps/vis/server/test/host-guard.test.ts
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { isLoopbackHost } from '../src/config';
import { hostGuard, hostnameFromAuthority } from '../src/host-guard';

/** Minimal app exercising only the guard, so assertions don't depend on the
 *  session routes or KIMI_CODE_HOME. */
function guarded(options: { bindHost: string; allowedHosts?: string }): Hono {
  const app = new Hono();
  app.use('*', hostGuard(options));
  app.get('/api/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('hostnameFromAuthority', () => {
  it('parses host:port and bare hostnames', () => {
    expect(hostnameFromAuthority('example.com:3001')).toBe('example.com');
    expect(hostnameFromAuthority('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameFromAuthority('  Example.COM  ')).toBe('example.com');
    expect(hostnameFromAuthority('')).toBeNull();
    expect(hostnameFromAuthority(undefined)).toBeNull();
  });

  it('does not truncate bare IPv6 literals at the first colon', () => {
    expect(hostnameFromAuthority('2001:db8::10')).toBe('2001:db8::10');
    expect(hostnameFromAuthority('[2001:db8::10]:3001')).toBe('2001:db8::10');
    expect(hostnameFromAuthority('[::1]')).toBe('::1');
  });

  it('does not let trailing junk after a bracket masquerade as the host', () => {
    // `[::1]evil.com` must NOT normalize to the loopback `::1`.
    const parsed = hostnameFromAuthority('[::1]evil.com');
    expect(parsed).not.toBe('::1');
    expect(isLoopbackHost(parsed ?? '')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback names and the 127.0.0.0/8 range', () => {
    for (const h of ['localhost', 'tenant.localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('rejects hostnames that merely start with 127.', () => {
    for (const h of ['127.0.0.1.nip.io', '127.evil.com', '1270.0.0.1', '127.0.0.256']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe('hostGuard (DNS-rebinding defense)', () => {
  it('rejects a rebound non-loopback Host', async () => {
    const app = guarded({ bindHost: '127.0.0.1' });
    const res = await app.request('http://attacker.example/api/ping');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN_HOST' });
  });

  it('allows loopback and *.localhost Host values', async () => {
    const app = guarded({ bindHost: '127.0.0.1' });
    for (const origin of [
      'http://localhost/api/ping',
      'http://127.0.0.1/api/ping',
      'http://127.0.0.2/api/ping',
      'http://tenant.localhost/api/ping',
    ]) {
      expect((await app.request(origin)).status, origin).toBe(200);
    }
  });

  it('does not allow a domain that only starts with 127. (no prefix bypass)', async () => {
    const app = guarded({ bindHost: '127.0.0.1' });
    expect((await app.request('http://127.0.0.1.nip.io/api/ping')).status).toBe(403);
  });

  it('allows hosts listed in VIS_ALLOWED_HOSTS, still blocks others', async () => {
    const app = guarded({ bindHost: '127.0.0.1', allowedHosts: 'vis.internal,dev.box' });
    expect((await app.request('http://vis.internal/api/ping')).status).toBe(200);
    expect((await app.request('http://attacker.example/api/ping')).status).toBe(403);
  });
});

describe('createApp host-guard wiring', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('guards requests when no auth token is configured', async () => {
    const app = await createApp({ host: '127.0.0.1' });
    const res = await app.request('http://attacker.example/api/sessions');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN_HOST' });
  });

  it('does not host-guard in token mode, so wildcard LAN access keeps working', async () => {
    // Binding to a wildcard requires a token; the token (not the Host) is the
    // access control, so a concrete LAN client must not be rejected as a
    // forbidden host.
    const app = await createApp({ authToken: 'secret-token', host: '0.0.0.0' });
    const res = await app.request('http://192.168.1.10/api/sessions', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(res.status).not.toBe(403);
  });
});
