/**
 * Scenario: custom agent identity resolution.
 *
 * Asserts the two faces the identity exposes — the filling `displayName`
 * (config > host-declared > unset) and the rewriting `slug` (claimed only when
 * the user declares one) — plus the slug normalization that guarantees a
 * non-empty ASCII token for any input, including the blank and CJK-only cases
 * that would otherwise reach the User-Agent builder.
 *
 * Runs the real `AgentIdentityService` over a stub config service and a stub
 * bootstrap; nothing else is wired. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentIdentity/agentIdentity.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import {
  DEFAULT_IDENTITY_SLUG,
  IAgentIdentity,
  normalizeIdentitySlug,
} from '#/app/agentIdentity/agentIdentity';
import { AgentIdentityService } from '#/app/agentIdentity/agentIdentityService';
import { IDENTITY_SECTION } from '#/app/agentIdentity/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { stubBootstrap } from '../bootstrap/stubs';
import { StubConfigService } from '../../kosong/stubs';

const hosts: Array<{ dispose(): void }> = [];

afterEach(() => {
  while (hosts.length > 0) hosts.pop()?.dispose();
});

function resolve(
  section: Record<string, unknown> | undefined,
  hostDisplayName?: string,
): IAgentIdentity {
  registerScopedService(LifecycleScope.App, IAgentIdentity, AgentIdentityService);
  const host = createScopedTestHost([
    [
      IConfigService,
      new StubConfigService(section === undefined ? {} : { [IDENTITY_SECTION]: section }),
    ],
    [IBootstrapService, stubBootstrap('/home', {}, { displayName: hostDisplayName })],
  ]);
  hosts.push(host);
  return host.app.accessor.get(IAgentIdentity);
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
  it('claims nothing when the section is unset', () => {
    const identity = resolve(undefined);
    expect(identity.slug).toBeUndefined();
    expect(identity.displayName).toBeUndefined();
  });

  it('falls back to the host-declared display name and claims no slug', () => {
    const identity = resolve(undefined, 'Embedding Host');
    expect(identity.displayName).toBe('Embedding Host');
    // A host default is not a custom identity — protocol fields stay untouched.
    expect(identity.slug).toBeUndefined();
  });

  it('lets the config name override the host-declared display name', () => {
    const identity = resolve({ name: 'Acme Dev' }, 'Embedding Host');
    expect(identity.displayName).toBe('Acme Dev');
    expect(identity.slug).toBe('acme-dev');
  });

  it('derives the slug from the name when only a name is configured', () => {
    const identity = resolve({ name: 'Acme Dev Agent' });
    expect(identity.slug).toBe('acme-dev-agent');
  });

  it('prefers an explicit slug over the derived one', () => {
    const identity = resolve({ name: 'Acme Dev Agent', slug: 'acme' });
    expect(identity.displayName).toBe('Acme Dev Agent');
    expect(identity.slug).toBe('acme');
  });

  it('normalizes a user-written slug', () => {
    expect(resolve({ slug: 'Acme Dev!' }).slug).toBe('acme-dev');
  });

  it('applies a slug-only config partially, leaving the display name to fall through', () => {
    const identity = resolve({ slug: 'acme' }, 'Embedding Host');
    expect(identity.slug).toBe('acme');
    expect(identity.displayName).toBe('Embedding Host');
  });

  // A stray blank in config.toml must read as unset, exactly as a blank env
  // var does — otherwise it claims an identity and rewrites the User-Agent.
  it.each([{ name: '' }, { name: '   ' }, { slug: '' }, { name: '', slug: '  ' }])(
    'treats blank config values as unset: %j',
    (section) => {
      const identity = resolve(section, 'Embedding Host');
      expect(identity.slug).toBeUndefined();
      expect(identity.displayName).toBe('Embedding Host');
    },
  );

  it('trims a padded name and slug', () => {
    const identity = resolve({ name: '  Acme Dev  ' });
    expect(identity.displayName).toBe('Acme Dev');
    expect(identity.slug).toBe('acme-dev');
  });

  it('keeps a CJK-only name usable by falling the slug back to the default', () => {
    const identity = resolve({ name: '开发助手' });
    expect(identity.displayName).toBe('开发助手');
    expect(identity.slug).toBe(DEFAULT_IDENTITY_SLUG);
  });
});
