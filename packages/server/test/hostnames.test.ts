/**
 * Host-header allowlist (ROADMAP M4.1).
 *
 * Pure unit cases for `stripPort` / `isAllowedHost` / the env parsers, plus a
 * minimal Fastify integration test that exercises the `onRequest` hook through
 * `app.inject` (which sends `Host: localhost:80` by default).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHostCheck,
  formatHostErrorMessage,
  isAllowedHost,
  isHostCheckDisabled,
  parseAllowedHosts,
  stripPort,
} from '#/middleware/hostnames';

describe('stripPort', () => {
  it('strips the port from a hostname', () => {
    expect(stripPort('localhost:80')).toBe('localhost');
  });

  it('strips the port from bracketed IPv6', () => {
    expect(stripPort('[::1]:80')).toBe('[::1]');
  });

  it('strips the port from an IPv4 literal', () => {
    expect(stripPort('1.2.3.4:5678')).toBe('1.2.3.4');
  });

  it('lowercases bare hosts', () => {
    expect(stripPort('LOCALHOST')).toBe('localhost');
  });
});

describe('formatHostErrorMessage', () => {
  it('includes the rejected host and allow guidance', () => {
    expect(formatHostErrorMessage('APP.Example.com:443')).toBe(
      "Invalid Host header: app.example.com; allow this host with KIMI_CODE_ALLOWED_HOSTS=app.example.com or 'kimi server run --allowed-host app.example.com'.",
    );
  });
});

describe('isAllowedHost (default allow set)', () => {
  const allow = ['localhost', 'localhost:80', 'foo.localhost', '127.0.0.1', '127.0.0.1:58627', '[::1]', '::1', '8.8.8.8'];

  for (const host of allow) {
    it(`allows ${host}`, () => {
      expect(isAllowedHost(host, {})).toBe(true);
    });
  }

  const deny = ['evil.com', 'evil.com:80', '127.0.0.1.evil.com'];

  for (const host of deny) {
    it(`denies ${host}`, () => {
      expect(isAllowedHost(host, {})).toBe(false);
    });
  }

  it('denies a missing Host header', () => {
    expect(isAllowedHost(undefined, {})).toBe(false);
  });
});

describe('isAllowedHost (boundHost)', () => {
  it('allows the bound host', () => {
    expect(isAllowedHost('myhost', { boundHost: 'myhost' })).toBe(true);
  });

  it('strips the port on both sides', () => {
    expect(isAllowedHost('myhost:1234', { boundHost: 'myhost:8080' })).toBe(true);
  });

  it('still denies unrelated hosts', () => {
    expect(isAllowedHost('otherhost', { boundHost: 'myhost' })).toBe(false);
  });
});

describe('isAllowedHost (extra)', () => {
  it('matches a subdomain wildcard', () => {
    expect(isAllowedHost('a.example.com', { extra: ['.example.com'] })).toBe(true);
  });

  it('matches the bare domain of a wildcard', () => {
    expect(isAllowedHost('example.com', { extra: ['.example.com'] })).toBe(true);
  });

  it('does not match a partial suffix', () => {
    expect(isAllowedHost('baddexample.com', { extra: ['.example.com'] })).toBe(false);
  });

  it('matches an exact entry', () => {
    expect(isAllowedHost('foo', { extra: ['foo'] })).toBe(true);
  });
});

describe('isAllowedHost (disable)', () => {
  it('allows everything when disabled', () => {
    expect(isAllowedHost('evil.com', { disable: true })).toBe(true);
  });
});

describe('parseAllowedHosts', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseAllowedHosts({ KIMI_CODE_ALLOWED_HOSTS: ' a, .b.com, ' })).toEqual(['a', '.b.com']);
  });

  it('returns [] when unset', () => {
    expect(parseAllowedHosts({})).toEqual([]);
  });
});

describe('isHostCheckDisabled', () => {
  it('is true when set to "1"', () => {
    expect(isHostCheckDisabled({ KIMI_CODE_DISABLE_HOST_CHECK: '1' })).toBe(true);
  });

  it('is false when unset', () => {
    expect(isHostCheckDisabled({})).toBe(false);
  });
});

describe('createHostCheck (onRequest hook)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.addHook('onRequest', createHostCheck({}).onRequest);
    app.get('/api/v1/probe', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a disallowed Host with the 40301 envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40301);
    expect(body['msg']).toBe(
      "Invalid Host header: evil.com; allow this host with KIMI_CODE_ALLOWED_HOSTS=evil.com or 'kimi server run --allowed-host evil.com'.",
    );
    expect(body['data']).toBeNull();
    expect(typeof body['request_id']).toBe('string');
  });

  it('allows the default app.inject Host (localhost:80)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/probe' });
    expect(res.statusCode).toBe(200);
  });
});
