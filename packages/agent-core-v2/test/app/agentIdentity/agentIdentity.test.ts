import { afterEach, describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import {
  buildAgentIdentitySnapshot,
  DEFAULT_IDENTITY_SLUG,
  IAgentIdentity,
  normalizeIdentitySlug,
  type AgentIdentitySnapshot,
} from '#/app/agentIdentity/agentIdentity';
import { AgentIdentityService } from '#/app/agentIdentity/agentIdentityService';
import { IDENTITY_SECTION } from '#/app/agentIdentity/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService } from '#/_base/di/scope';

import { stubBootstrap } from '../bootstrap/stubs';
import { StubConfigService } from '../../kosong/stubs';

const hosts: Array<{ dispose(): void }> = [];

afterEach(() => {
  while (hosts.length > 0) hosts.pop()?.dispose();
});

function createIdentity(
  section: Record<string, unknown> | undefined,
  options: {
    hostDisplayName?: string;
    hostRequestHeaders?: Record<string, string>;
  } = {},
): { identity: IAgentIdentity; config: StubConfigService } {
  registerScopedService(LifecycleScope.App, IAgentIdentity, AgentIdentityService);
  const config = new StubConfigService(
    section === undefined ? {} : { [IDENTITY_SECTION]: section },
  );
  const host = createScopedTestHost([
    [IConfigService, config],
    [
      IBootstrapService,
      stubBootstrap('/home', {}, {
        displayName: options.hostDisplayName,
        requestHeaders: options.hostRequestHeaders ?? {},
      }),
    ],
  ]);
  hosts.push(host);
  return { identity: host.app.accessor.get(IAgentIdentity), config };
}

async function resolve(
  section: Record<string, unknown> | undefined,
  hostDisplayName?: string,
): Promise<AgentIdentitySnapshot> {
  return createIdentity(section, { hostDisplayName }).identity.resolved();
}

describe('normalizeIdentitySlug', () => {
  it('folds an ordinary name into a hyphenated token', () => {
    expect(normalizeIdentitySlug('Acme Dev Agent')).toBe('acme-dev-agent');
  });

  it.each([
    ['Acme 开发助手', 'acme'],
    ['ACME__Dev', 'acme-dev'],
    ['  spaced  out  ', 'spaced-out'],
    ['--leading-and-trailing--', 'leading-and-trailing'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeIdentitySlug(input)).toBe(expected);
  });

  it.each(['开发助手', '!!!', '   ', '', '「」', '🎉'])(
    'falls back to the default slug for %j',
    (input) => {
      expect(normalizeIdentitySlug(input)).toBe(DEFAULT_IDENTITY_SLUG);
    },
  );

  it('always yields a non-empty ASCII token', () => {
    for (const input of ['Acme', '开发', '~~~', '', 'a1', 'Ω']) {
      const slug = normalizeIdentitySlug(input);
      expect(slug.length).toBeGreaterThan(0);
      expect(/^[ -~]+$/.test(slug)).toBe(true);
    }
  });
});

describe('AgentIdentityService', () => {
  it('claims nothing when the section is unset', async () => {
    const identity = await resolve(undefined);
    expect(identity.slug).toBeUndefined();
    expect(identity.displayName).toBeUndefined();
  });

  it('falls back to the host-declared display name and claims no slug', async () => {
    const identity = await resolve(undefined, 'Embedding Host');
    expect(identity.displayName).toBe('Embedding Host');
    expect(identity.slug).toBeUndefined();
  });

  it('lets the config name override the host-declared display name', async () => {
    const identity = await resolve({ name: 'Acme Dev' }, 'Embedding Host');
    expect(identity.displayName).toBe('Acme Dev');
    expect(identity.slug).toBe('acme-dev');
  });

  it('derives the slug from the name when only a name is configured', async () => {
    const identity = await resolve({ name: 'Acme Dev Agent' });
    expect(identity.slug).toBe('acme-dev-agent');
  });

  it('prefers an explicit slug over the derived one', async () => {
    const identity = await resolve({ name: 'Acme Dev Agent', slug: 'acme' });
    expect(identity.displayName).toBe('Acme Dev Agent');
    expect(identity.slug).toBe('acme');
  });

  it('normalizes a user-written slug', async () => {
    expect((await resolve({ slug: 'Acme Dev!' })).slug).toBe('acme-dev');
  });

  it('applies a slug-only config partially, leaving the display name to fall through', async () => {
    const identity = await resolve({ slug: 'acme' }, 'Embedding Host');
    expect(identity.slug).toBe('acme');
    expect(identity.displayName).toBe('Embedding Host');
  });

  it.each([{ name: '' }, { name: '   ' }, { slug: '' }, { name: '', slug: '  ' }])(
    'treats blank config values as unset: %j',
    async (section) => {
      const identity = await resolve(section, 'Embedding Host');
      expect(identity.slug).toBeUndefined();
      expect(identity.displayName).toBe('Embedding Host');
    },
  );

  it.each(['', '   '])('treats a blank host display name as unset: %j', async (hostName) => {
    expect((await resolve(undefined, hostName)).displayName).toBeUndefined();
  });

  it('trims a padded host display name', async () => {
    expect((await resolve(undefined, '  Embedding Host  ')).displayName).toBe('Embedding Host');
  });

  it('trims a padded name and slug', async () => {
    const identity = await resolve({ name: '  Acme Dev  ' });
    expect(identity.displayName).toBe('Acme Dev');
    expect(identity.slug).toBe('acme-dev');
  });

  it('keeps a CJK-only name usable by falling the slug back to the default', async () => {
    const identity = await resolve({ name: '开发助手' });
    expect(identity.displayName).toBe('开发助手');
    expect(identity.slug).toBe(DEFAULT_IDENTITY_SLUG);
  });
});

describe('AgentIdentityService freeze', () => {
  it('ignores a config edit made after the freeze', async () => {
    const { identity, config } = createIdentity(
      { name: 'Acme' },
      { hostRequestHeaders: { 'User-Agent': 'kimi-code-cli/1.0' } },
    );
    const before = await identity.resolved();
    expect(before.displayName).toBe('Acme');
    expect(before.thirdPartyUserAgent).toBe('acme/1.0');

    await config.set(IDENTITY_SECTION, { name: 'Rebrand', slug: 'rebrand' });

    const after = await identity.resolved();
    expect(after).toBe(before);
    expect(identity.current().displayName).toBe('Acme');
    expect(identity.current().thirdPartyUserAgent).toBe('acme/1.0');
  });

  it('throws on a synchronous read before the freeze', () => {
    const { identity } = createIdentity({ name: 'Acme' });
    expect(() => identity.current()).toThrow(/before config load/);
  });

  it('serves the synchronous read once resolved', async () => {
    const { identity } = createIdentity({ name: 'Acme' });
    await identity.resolved();
    expect(identity.current().displayName).toBe('Acme');
  });
});

describe('buildAgentIdentitySnapshot products', () => {
  const HOST = { 'User-Agent': 'kimi-code-cli/1.2.3 (darwin)', 'X-Msh-Device-Id': 'device-1' };

  it('rewrites only the product token across every product when a slug is claimed', () => {
    const snapshot = buildAgentIdentitySnapshot({ slug: 'acme', hostRequestHeaders: HOST });
    expect(snapshot.thirdPartyUserAgent).toBe('acme/1.2.3 (darwin)');
    expect(snapshot.outboundUserAgent).toBe('acme/1.2.3 (darwin)');
    expect(snapshot.requestHeaders).toEqual({
      'User-Agent': 'acme/1.2.3 (darwin)',
      'X-Msh-Device-Id': 'device-1',
    });
  });

  it('passes the host products through untouched when no identity is claimed', () => {
    const snapshot = buildAgentIdentitySnapshot({ hostRequestHeaders: HOST });
    expect(snapshot.thirdPartyUserAgent).toBe(HOST['User-Agent']);
    expect(snapshot.outboundUserAgent).toBe(HOST['User-Agent']);
    expect(snapshot.requestHeaders).toEqual(HOST);
  });

  it.each([
    [HOST, 'acme', 'acme/1.2.3 (darwin)'],
    [HOST, undefined, HOST['User-Agent']],
    [{}, 'acme', 'acme'],
    [{}, undefined, DEFAULT_IDENTITY_SLUG],
  ])('outboundUserAgent for host %j and slug %j is %j', (headers, slug, expected) => {
    expect(
      buildAgentIdentitySnapshot({ slug, hostRequestHeaders: headers }).outboundUserAgent,
    ).toBe(expected);
  });

  it('yields no third-party User-Agent when the host sends none', () => {
    const snapshot = buildAgentIdentitySnapshot({ slug: 'acme', hostRequestHeaders: {} });
    expect(snapshot.thirdPartyUserAgent).toBeUndefined();
    expect(snapshot.requestHeaders).toEqual({});
  });

  it.each(['user-agent', 'USER-AGENT'])(
    'locates the %j spelling and rewrites it in place',
    (key) => {
      const snapshot = buildAgentIdentitySnapshot({
        slug: 'acme',
        hostRequestHeaders: { [key]: 'kimi-code-cli/1.2.3', 'X-Msh-Device-Id': 'device-1' },
      });
      expect(snapshot.thirdPartyUserAgent).toBe('acme/1.2.3');
      expect(snapshot.outboundUserAgent).toBe('acme/1.2.3');
      expect(snapshot.requestHeaders).toEqual({
        [key]: 'acme/1.2.3',
        'X-Msh-Device-Id': 'device-1',
      });
    },
  );

  it('passes a lowercase spelling through untouched when no identity is claimed', () => {
    const snapshot = buildAgentIdentitySnapshot({
      hostRequestHeaders: { 'user-agent': 'kimi-code-cli/1.2.3' },
    });
    expect(snapshot.thirdPartyUserAgent).toBe('kimi-code-cli/1.2.3');
    expect(snapshot.requestHeaders).toEqual({ 'user-agent': 'kimi-code-cli/1.2.3' });
  });
});
