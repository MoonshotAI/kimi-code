/**
 * sandbox configSection tests for the v2 sandbox domain.
 *
 * Covers the `[sandbox]` TOML transforms (snake_case ↔ camelCase, including
 * the nested `[sandbox.filesystem]` / `[sandbox.network]` tables), the zod
 * schema, and `resolveSandboxConfig` (section read + the one-time
 * `allowed_domains` Phase 3 warning).
 */

import { describe, expect, it, vi } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import {
  SANDBOX_SECTION,
  SandboxConfigSchema,
  resolveSandboxConfig,
  sandboxFromToml,
  sandboxToToml,
} from '#/session/sandbox/configSection';
import type { SandboxConfig } from '#/session/sandbox/sandboxTypes';

const TOML_SECTION = {
  enabled: true,
  mode: 'read-only',
  require: true,
  auto_allow_sandboxed_bash: true,
  excluded_commands: ['docker', 'git push'],
  filesystem: {
    deny_read: ['~/.ssh/**'],
    allow_write: ['/data/out'],
    deny_write: ['**/.git/**'],
  },
  network: {
    enabled: false,
    allowed_domains: ['example.com'],
    allow_unix_sockets: ['/var/run/ssh-agent.sock'],
  },
};

const CAMEL_SECTION = {
  enabled: true,
  mode: 'read-only',
  require: true,
  autoAllowSandboxedBash: true,
  excludedCommands: ['docker', 'git push'],
  filesystem: {
    denyRead: ['~/.ssh/**'],
    allowWrite: ['/data/out'],
    denyWrite: ['**/.git/**'],
  },
  network: {
    enabled: false,
    allowedDomains: ['example.com'],
    allowUnixSockets: ['/var/run/ssh-agent.sock'],
  },
};

describe('sandbox config section', () => {
  it('fromToml converts snake_case to camelCase, including nested tables', () => {
    expect(sandboxFromToml(TOML_SECTION)).toEqual(CAMEL_SECTION);
  });

  it('fromToml passes non-objects through', () => {
    expect(sandboxFromToml('nope')).toBe('nope');
  });

  it('toToml converts back to snake_case and round-trips', () => {
    expect(sandboxToToml(CAMEL_SECTION, undefined)).toEqual(TOML_SECTION);
    expect(sandboxFromToml(sandboxToToml(CAMEL_SECTION, undefined))).toEqual(CAMEL_SECTION);
  });

  it('schema accepts an empty section and rejects bad values', () => {
    expect(SandboxConfigSchema.safeParse({}).success).toBe(true);
    expect(SandboxConfigSchema.safeParse(CAMEL_SECTION).success).toBe(true);
    expect(SandboxConfigSchema.safeParse({ mode: 'yolo' }).success).toBe(false);
    expect(SandboxConfigSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(SandboxConfigSchema.safeParse({ excludedCommands: 'docker' }).success).toBe(false);
  });
});

describe('resolveSandboxConfig', () => {
  function stubConfig(section: unknown): IConfigService {
    return {
      _serviceBrand: undefined,
      get: (domain: string) => (domain === SANDBOX_SECTION ? section : undefined),
    } as unknown as IConfigService;
  }

  it('returns the sandbox section and undefined when absent', () => {
    const section: SandboxConfig = { enabled: true };
    expect(resolveSandboxConfig(stubConfig(section))).toEqual(section);
    expect(resolveSandboxConfig(stubConfig(undefined))).toBeUndefined();
  });

  it('warns once when network.allowedDomains is set (Phase 3 not implemented)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withDomains = stubConfig({ enabled: true, network: { allowedDomains: ['a.com'] } });
      resolveSandboxConfig(withDomains);
      resolveSandboxConfig(withDomains);
      resolveSandboxConfig(stubConfig({ enabled: true }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('allowed_domains');
    } finally {
      warn.mockRestore();
    }
  });
});
