import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import {
  detectSandboxBackend,
  isLikelySandboxDenial,
} from '#/os/sandbox/backend';
import { BwrapBackend } from '#/os/sandbox/backends/bwrap';
import { SeatbeltBackend } from '#/os/sandbox/backends/seatbelt';
import {
  SANDBOX_SECTION,
  SandboxConfigSchema,
  resolveSandboxConfig,
} from '#/os/sandbox/configSection';
import { SandboxProfileResolver } from '#/os/sandbox/sandboxProfileResolver';
import type { SandboxSpawnRequest } from '#/os/sandbox/types';

const testEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

function stubConfig(values: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (section: string) => values[section],
  } as unknown as IConfigService;
}

function resolver(configValues: Record<string, unknown> = {}): SandboxProfileResolver {
  return new SandboxProfileResolver(stubConfig(configValues), testEnv);
}

function request(overrides: Partial<SandboxSpawnRequest> = {}): SandboxSpawnRequest {
  return {
    cwd: '/home/test/project',
    workspaceRoots: ['/home/test/project'],
    command: 'echo hi',
    ...overrides,
  };
}

describe('SandboxProfileResolver', () => {
  it('defaults to workspace-write with workspace and tmp writable', () => {
    const profile = resolver().resolve(request());
    expect(profile).toBeDefined();
    expect(profile!.mode).toBe('workspace-write');
    expect(profile!.writableRoots).toContain('/home/test/project');
    expect(profile!.writableRoots.some((root) => root.includes('tmp'))).toBe(true);
  });

  it('returns undefined when mode is off', () => {
    const r = resolver({ [SANDBOX_SECTION]: { mode: 'off' } });
    expect(r.resolve(request())).toBeUndefined();
  });

  it('returns undefined for excluded commands', () => {
    const r = resolver({ [SANDBOX_SECTION]: { excludedCommands: ['docker *'] } });
    expect(r.resolve(request({ command: 'docker ps' }))).toBeUndefined();
    expect(r.resolve(request({ command: 'echo ok' }))).toBeDefined();
  });

  it('returns undefined when request.disabled is set', () => {
    expect(resolver().resolve(request({ disabled: true }))).toBeUndefined();
  });

  it('read-only mode keeps only tmp writable', () => {
    const profile = resolver({ [SANDBOX_SECTION]: { mode: 'read-only' } }).resolve(request());
    expect(profile!.mode).toBe('read-only');
    expect(profile!.writableRoots).not.toContain('/home/test/project');
    expect(profile!.writableRoots.some((root) => root.includes('tmp'))).toBe(true);
  });

  it('stamps proxyPorts from the spawn request proxy', () => {
    const profile = resolver({
      [SANDBOX_SECTION]: { network: { mode: 'allowlist' } },
    }).resolve(
      request({
        proxy: {
          env: { HTTP_PROXY: 'http://t:x@127.0.0.1:8080' },
          httpPort: 8080,
          socksPort: 8081,
          token: 't',
        },
      }),
    );
    expect(profile!.network.mode).toBe('allowlist');
    expect(profile!.network.proxyPorts).toEqual({ http: 8080, socks: 8081 });
  });

  it('leaves proxyPorts unset without a request proxy', () => {
    const profile = resolver({
      [SANDBOX_SECTION]: { network: { mode: 'allowlist' } },
    }).resolve(request());
    expect(profile!.network.proxyPorts).toBeUndefined();
  });

  it('marks workspace metadata dirs deny-write', () => {
    const profile = resolver().resolve(request());
    expect(profile!.denyWritePaths).toContain('/home/test/project/.git');
    expect(profile!.denyWritePaths).toContain('/home/test/project/.kimi-code');
    expect(profile!.denyWritePaths).toContain('/home/test/project/.agents');
  });

  it('deny-read covers sensitive home dirs', () => {
    const profile = resolver().resolve(request());
    expect(profile!.denyReadPaths).toContain('/home/test/.ssh');
    expect(profile!.denyReadPaths).toContain('/home/test/.aws');
    expect(profile!.denyReadPaths).toContain('/home/test/.kimi-code');
  });

  it('danger-full-access yields an unconstrained profile', () => {
    const profile = resolver({
      [SANDBOX_SECTION]: { mode: 'danger-full-access' },
    }).resolve(request());
    expect(profile!.mode).toBe('danger-full-access');
    expect(profile!.writableRoots).toContain('/');
    expect(profile!.denyReadPaths).toHaveLength(0);
    expect(profile!.network.mode).toBe('all');
  });

  it('expands ~ in config paths against homeDir', () => {
    const profile = resolver({
      [SANDBOX_SECTION]: { denyRead: ['~/secrets'] },
    }).resolve(request());
    expect(profile!.denyReadPaths).toContain('/home/test/secrets');
  });

  it('reads network policy fields from config', () => {
    const profile = resolver({
      [SANDBOX_SECTION]: {
        network: { mode: 'allowlist', allowedDomains: ['example.com'], allowLocalBinding: false },
      },
    }).resolve(request());
    expect(profile!.network.mode).toBe('allowlist');
    expect(profile!.network.allowedDomains).toEqual(['example.com']);
    expect(profile!.network.allowLocalBinding).toBe(false);
  });

  it('reports allowUnsandboxedCommands', () => {
    expect(resolver().allowsUnsandboxedFallback()).toBe(false);
    expect(
      resolver({ [SANDBOX_SECTION]: { allowUnsandboxedCommands: true } }).allowsUnsandboxedFallback(),
    ).toBe(true);
  });
});

describe('SeatbeltBackend', () => {
  const backend = new SeatbeltBackend();
  const profile = resolver().resolve(request())!;

  it('wraps argv as sandbox-exec -D … -p <profile> <cmd>', () => {
    const plan = backend.wrap('/bin/bash', ['-c', 'echo hi'], profile);
    expect(plan.command).toBe('/usr/bin/sandbox-exec');
    expect(plan.args).toContain('-p');
    expect(plan.args.filter((a) => a === '-D')).not.toHaveLength(0);
    expect(plan.args.slice(-3)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('profile contains writable-root allows and metadata denies', () => {
    const plan = backend.wrap('echo', ['hi'], profile);
    const sbpl = plan.args[plan.args.indexOf('-p') + 1]!;
    expect(sbpl).toContain('(deny default)');
    expect(sbpl).toContain('file-write*');
    expect(sbpl).toContain('DENY_READ_0');
    expect(sbpl).toContain('require-not');
  });

  it('read-only profile has no writable workspace root', () => {
    const ro = resolver({ [SANDBOX_SECTION]: { mode: 'read-only' } }).resolve(request())!;
    const plan = backend.wrap('echo', ['hi'], ro);
    const sbpl = plan.args[plan.args.indexOf('-p') + 1]!;
    expect(sbpl).not.toContain('project/.git');
  });

  it('network mode all adds network allowance', () => {
    const plan = backend.wrap('echo', ['hi'], profile);
    const sbpl = plan.args[plan.args.indexOf('-p') + 1]!;
    expect(sbpl).toContain('(allow network*)');
  });

  it('allowlist mode with proxyPorts permits only the loopback proxy ports', () => {
    const proxied = {
      ...profile,
      network: {
        ...profile.network,
        mode: 'allowlist' as const,
        proxyPorts: { http: 8080, socks: 8081 },
      },
    };
    const plan = backend.wrap('echo', ['hi'], proxied);
    const sbpl = plan.args[plan.args.indexOf('-p') + 1]!;
    expect(sbpl).not.toContain('(allow network*)');
    expect(sbpl).toContain('(allow network-outbound (remote tcp "127.0.0.1:8080"))');
    expect(sbpl).toContain('(allow network-outbound (remote tcp "127.0.0.1:8081"))');
  });

  it('allowlist mode without proxyPorts denies all network', () => {
    const noProxy = {
      ...profile,
      network: { ...profile.network, mode: 'allowlist' as const, proxyPorts: undefined },
    };
    const plan = backend.wrap('echo', ['hi'], noProxy);
    const sbpl = plan.args[plan.args.indexOf('-p') + 1]!;
    expect(sbpl).not.toContain('(allow network*)');
    expect(sbpl).not.toContain('network-outbound (remote tcp');
  });
});

describe('BwrapBackend', () => {
  const backend = new BwrapBackend();
  const profile = resolver().resolve(request())!;

  it('builds the bwrap argv with binds and unshare flags', () => {
    const plan = backend.wrap('/bin/bash', ['-c', 'echo hi'], profile);
    expect(plan.command).toBe('bwrap');
    const argv = plan.args;
    expect(argv).toContain('--ro-bind');
    expect(argv).toContain('--bind-try');
    expect(argv).toContain('--unshare-user');
    expect(argv).toContain('--cap-drop');
    const dashDash = argv.indexOf('--');
    expect(argv.slice(dashDash + 1)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('masks deny-read paths', () => {
    const plan = backend.wrap('echo', ['hi'], profile);
    const tmpfsIndex = plan.args.findIndex((a) => a === '--tmpfs');
    expect(tmpfsIndex).toBeGreaterThanOrEqual(0);
  });

  it('unshares the network unless mode is all', () => {
    const plan = backend.wrap('echo', ['hi'], profile);

    expect(plan.args).not.toContain('--unshare-net');
    const noNet = {
      ...profile,
      network: { ...profile.network, mode: 'off' as const },
    };
    expect(backend.wrap('echo', ['hi'], noNet).args).toContain('--unshare-net');
  });

  it('keeps the network namespace open for an allowlist proxy (advisory)', () => {
    const proxied = {
      ...profile,
      network: {
        ...profile.network,
        mode: 'allowlist' as const,
        proxyPorts: { http: 8080, socks: undefined },
      },
    };
    expect(backend.wrap('echo', ['hi'], proxied).args).not.toContain('--unshare-net');
    const allowlistNoProxy = {
      ...profile,
      network: { ...profile.network, mode: 'allowlist' as const, proxyPorts: undefined },
    };
    expect(backend.wrap('echo', ['hi'], allowlistNoProxy).args).toContain('--unshare-net');
  });
});

describe('isLikelySandboxDenial', () => {
  it('rejects success and quick-reject exit codes', () => {
    expect(isLikelySandboxDenial(0, 'operation not permitted')).toBe(false);
    expect(isLikelySandboxDenial(2, 'permission denied')).toBe(false);
    expect(isLikelySandboxDenial(126, 'sandbox:')).toBe(false);
    expect(isLikelySandboxDenial(127, 'permission denied')).toBe(false);
    expect(isLikelySandboxDenial(null, 'permission denied')).toBe(false);
  });

  it('detects fingerprint keywords on failure exits', () => {
    expect(isLikelySandboxDenial(1, 'cat: ~/.ssh/id_rsa: Operation not permitted')).toBe(true);
    expect(isLikelySandboxDenial(1, 'mkdir: cannot create directory: Permission denied')).toBe(true);
    expect(isLikelySandboxDenial(1, 'write failed: read-only file system')).toBe(true);
    expect(isLikelySandboxDenial(134, 'bwrap: Can\'t bind mount')).toBe(true);
  });

  it('detects SIGSYS (seccomp) exits', () => {
    expect(isLikelySandboxDenial(128 + 31, '')).toBe(true);
  });

  it('passes on ordinary failures', () => {
    expect(isLikelySandboxDenial(1, 'file not found')).toBe(false);
    expect(isLikelySandboxDenial(3, 'syntax error near unexpected token')).toBe(false);
  });
});

describe('detectSandboxBackend', () => {
  it('returns a backend descriptor matching the platform', () => {
    const detected = detectSandboxBackend();
    if (process.platform === 'darwin') {
      expect(detected.name).toBe('seatbelt');
      expect(detected.supported).toBe(true);
    } else if (process.platform === 'linux') {
      expect(detected.name).toBe('bwrap');
    } else {
      expect(detected.name).toBe('unsupported');
      expect(detected.supported).toBe(false);
    }
  });
});

describe('sandbox config section', () => {
  it('validates the schema', () => {
    expect(
      SandboxConfigSchema.safeParse({
        mode: 'workspace-write',
        autoApproveSandboxed: true,
        network: { mode: 'allowlist', allowedDomains: ['example.com'] },
      }).success,
    ).toBe(true);
    expect(SandboxConfigSchema.safeParse({ mode: 'bogus' }).success).toBe(false);
  });

  it('resolveSandboxConfig returns the parsed section', () => {
    const config = stubConfig({ [SANDBOX_SECTION]: { mode: 'read-only' } });
    expect(resolveSandboxConfig(config)?.mode).toBe('read-only');
  });
});
