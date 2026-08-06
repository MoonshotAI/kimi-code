/**
 * Scenario: custom agent identity resolution.
 *
 * Asserts the snapshot the identity service freezes once config first loads —
 * the filling `displayName` (config > host-declared > unset), the rewriting
 * `slug` (claimed only when the user declares one), and the finished
 * User-Agent products for the three outbound shapes — plus the freeze itself:
 * a `[identity]` edit after the freeze changes nothing until the next start,
 * and a synchronous read before the freeze fails loudly instead of serving a
 * pre-config value. Slug normalization guarantees a non-empty ASCII token for
 * any input, including the blank and CJK-only cases that would otherwise
 * reach the User-Agent builder.
 *
 * Runs the real `AgentIdentityService` over a stub config service and a stub
 * bootstrap; nothing else is wired. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentIdentity/agentIdentity.test.ts`.
 */

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

  // The User-Agent builder throws on a blank or non-ASCII product token, so a
  // name that folds away entirely must never reach it as an empty string.
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
      // eslint-disable-next-line no-control-regex
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
    // A host default is not a custom identity — protocol fields stay untouched.
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

  // A stray blank in config.toml must read as unset, exactly as a blank env
  // var does — otherwise it claims an identity and rewrites the User-Agent.
  it.each([{ name: '' }, { name: '   ' }, { slug: '' }, { name: '', slug: '  ' }])(
    'treats blank config values as unset: %j',
    async (section) => {
      const identity = await resolve(section, 'Embedding Host');
      expect(identity.slug).toBeUndefined();
      expect(identity.displayName).toBe('Embedding Host');
    },
  );

  // The host half of the same rule: a padded or blank `displayName` from an
  // embedding host must read as unset too, or the prompt renders "You are   ,".
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
  // The identity is announced outward (MCP initialize, OAuth registration,
  // provider logs) and cannot be re-announced, so the snapshot holds for the
  // life of the process: a `[identity]` edit after the freeze changes nothing.
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
    // The service arms the freeze on config readiness, which cannot have
    // delivered yet within the same synchronous frame.
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

  // The four (host User-Agent × slug) combinations of the always-defined
  // product: directories this process chooses to call always get a header.
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

  // The rewriting product respects a host that deliberately sends nothing.
  it('yields no third-party User-Agent when the host sends none', () => {
    const snapshot = buildAgentIdentitySnapshot({ slug: 'acme', hostRequestHeaders: {} });
    expect(snapshot.thirdPartyUserAgent).toBeUndefined();
    expect(snapshot.requestHeaders).toEqual({});
  });

  // HTTP header names are case-insensitive; a host that spells the header
  // `user-agent` (e.g. a WHATWG Headers object flattened with
  // Object.fromEntries) must get the same rewrite, under its own spelling.
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
