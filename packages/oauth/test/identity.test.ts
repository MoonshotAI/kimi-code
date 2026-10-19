import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKimiDefaultHeaders,
  createKimiDeviceHeaders,
  createKimiDeviceId,
  createKimiUserAgent,
  KIMI_CODE_PLATFORM,
  readKimiDeviceId,
} from '../src/identity';

const tmpRoots: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-oauth-identity-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Kimi identity factories', () => {
  it('creates and reuses a device id in the explicit homeDir', () => {
    const homeDir = tempHome();
    const first = createKimiDeviceId(homeDir);
    const second = createKimiDeviceId(homeDir);

    expect(first).toMatch(/^[0-9a-f-]+$/);
    expect(second).toBe(first);
  });

  it('creates different device ids for different homeDir values', () => {
    const first = createKimiDeviceId(tempHome());
    const second = createKimiDeviceId(tempHome());

    expect(second).not.toBe(first);
  });

  it('reads an existing device id without creating one when missing', () => {
    const homeDir = tempHome();

    expect(readKimiDeviceId(homeDir)).toBeNull();
    expect(readKimiDeviceId(homeDir)).toBeNull();

    const first = createKimiDeviceId(homeDir);
    expect(readKimiDeviceId(homeDir)).toBe(first);
  });

  it('treats an empty device id file as missing', () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, 'device_id'), '  \n', 'utf-8');

    expect(readKimiDeviceId(homeDir)).toBeNull();
  });

  it('creates complete X-Msh device headers from host version and platform', () => {
    const headers = createKimiDeviceHeaders({
      homeDir: tempHome(),
      version: '1.2.3-test',
      platform: KIMI_CODE_PLATFORM,
    });

    expect(headers['X-Msh-Platform']).toBe(KIMI_CODE_PLATFORM);
    expect(headers['X-Msh-Version']).toBe('1.2.3-test');
    expect(headers['X-Msh-Device-Name']).toBeTruthy();
    expect(headers['X-Msh-Device-Model']).toBeTruthy();
    expect(headers['X-Msh-Os-Version']).toBeTruthy();
    expect(headers['X-Msh-Device-Id']).toMatch(/^[0-9a-f-]+$/);
  });

  it('creates kimi-code-cli User-Agent and appends suffix only to UA', () => {
    expect(
      createKimiUserAgent({
        productName: 'kimi-code-cli',
        version: '1.2.3',
      }),
    ).toBe('kimi-code-cli/1.2.3');
    expect(
      createKimiUserAgent({
        productName: 'kimi-code-cli',
        version: '1.2.3',
        userAgentSuffix: 'wire 4.5.6',
      }),
    ).toBe('kimi-code-cli/1.2.3 (wire 4.5.6)');
  });

  it('honors an explicit X-Msh-Platform value', () => {
    const headers = createKimiDeviceHeaders({
      homeDir: tempHome(),
      version: '1.2.3-test',
      platform: 'kimi_code_desktop',
    });

    expect(headers['X-Msh-Platform']).toBe('kimi_code_desktop');
  });

  it('rejects an empty, whitespace, or all-non-ASCII platform instead of emitting a bad header', () => {
    for (const platform of ['', '   ', '桌面']) {
      expect(
        () => createKimiDeviceHeaders({ homeDir: tempHome(), version: '1.2.3', platform }),
        JSON.stringify(platform),
      ).toThrow('Kimi identity platform');
    }
  });

  it('sanitizes header-unsafe characters out of the platform value', () => {
    const headers = createKimiDeviceHeaders({
      homeDir: tempHome(),
      version: '1.2.3',
      platform: 'kimi_code_桌面\n',
    });
    expect(headers['X-Msh-Platform']).toBe('kimi_code_');
  });

  it('merges User-Agent and device headers into default headers', () => {
    const headers = createKimiDefaultHeaders({
      homeDir: tempHome(),
      productName: 'kimi-code-cli',
      version: '1.2.3',
      platform: 'kimi_code_cli',
    });

    expect(headers['User-Agent']).toBe('kimi-code-cli/1.2.3');
    expect(headers['X-Msh-Platform']).toBe('kimi_code_cli');
    expect(headers['X-Msh-Version']).toBe('1.2.3');
    expect(headers['X-Msh-Device-Id']).toMatch(/^[0-9a-f-]+$/);
  });

  it('threads the identity platform into default headers', () => {
    const headers = createKimiDefaultHeaders({
      homeDir: tempHome(),
      productName: 'kimi-code-desktop',
      version: '0.0.13',
      platform: 'kimi_code_desktop',
    });

    expect(headers['User-Agent']).toBe('kimi-code-desktop/0.0.13');
    expect(headers['X-Msh-Platform']).toBe('kimi_code_desktop');
  });
});

// HTTP header values must be plain ASCII without leading/trailing whitespace.
// The public factories surface the sanitizer used for User-Agent and X-Msh-*.
describe('ascii header value sanitization', () => {
  it('strips a trailing newline from a header value', () => {
    const ua = createKimiUserAgent({ productName: 'kimi-code-cli', version: '6.8.0-101\n' });
    expect(ua).toBe('kimi-code-cli/6.8.0-101');
  });

  it('drops non-ASCII codepoints while keeping the ASCII remainder', () => {
    const ua = createKimiUserAgent({ productName: 'kimi-code-cli', version: 'héllo' });
    expect(ua).toBe('kimi-code-cli/hllo');
  });

  it('uses the unknown fallback when every hostname codepoint is non-ASCII', async () => {
    vi.resetModules();
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        hostname: () => '你好',
        release: () => '1.0.0',
        type: () => 'Linux',
        arch: () => 'x64',
      };
    });

    try {
      const { createKimiDeviceHeaders: createHeaders } = await import('../src/identity');
      const headers = createHeaders({ homeDir: tempHome(), version: '1.0.0', platform: 'test' });
      expect(headers['X-Msh-Device-Name']).toBe('unknown');
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
    }
  });

  it('keeps every device-header value free of leading or trailing whitespace', async () => {
    vi.resetModules();
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        hostname: () => '  myhost  ',
        release: () => '#101-Ubuntu SMP\n',
        type: () => 'Linux',
        arch: () => 'x64',
      };
    });

    try {
      const { createKimiDeviceHeaders: createHeaders } = await import('../src/identity');
      const headers = createHeaders({ homeDir: tempHome(), version: '1.0.0', platform: 'test' });
      for (const [key, value] of Object.entries(headers)) {
        expect(value, `header ${key} has untrimmed whitespace: ${JSON.stringify(value)}`).toBe(
          value.trim(),
        );
      }
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
    }
  });

  const MACOS_SYSTEM_VERSION_PLIST = '/System/Library/CoreServices/SystemVersion.plist';

  function mockDarwinHost(systemVersionPlist: string | Error): void {
    vi.resetModules();
    vi.doMock('node:os', async () => ({
      ...(await vi.importActual<typeof import('node:os')>('node:os')),
      hostname: () => 'my-mac',
      release: () => '25.5.0',
      type: () => 'Darwin',
      arch: () => 'arm64',
    }));
    // Pin the SystemVersion.plist read so the test is deterministic on every
    // host; other reads (the device id file) still hit the real filesystem.
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const readFileSync = ((path: unknown, ...rest: unknown[]) => {
        if (String(path) !== MACOS_SYSTEM_VERSION_PLIST) {
          return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
        }
        if (systemVersionPlist instanceof Error) throw systemVersionPlist;
        return systemVersionPlist;
      }) as typeof actual.readFileSync;
      return { ...actual, readFileSync };
    });
  }

  function unmockDarwinHost(): void {
    vi.doUnmock('node:os');
    vi.doUnmock('node:fs');
    vi.resetModules();
  }

  it('reads the macOS product version from SystemVersion.plist without spawning sw_vers', async () => {
    mockDarwinHost(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        '<dict>',
        '\t<key>ProductName</key>',
        '\t<string>macOS</string>',
        '\t<key>ProductVersion</key>',
        '\t<string>26.1</string>',
        '</dict>',
        '</plist>',
      ].join('\n'),
    );

    try {
      const { createKimiDeviceHeaders } = await import('../src/identity');
      const headers = createKimiDeviceHeaders({ homeDir: tempHome(), version: '1.0.0', platform: 'test' });
      expect(headers['X-Msh-Device-Model']).toBe('macOS 26.1 arm64');
    } finally {
      unmockDarwinHost();
    }
  });

  it('falls back to Darwin kernel version when SystemVersion.plist is unavailable', async () => {
    mockDarwinHost(new Error('ENOENT'));

    try {
      const { createKimiDeviceHeaders } = await import('../src/identity');
      const headers = createKimiDeviceHeaders({ homeDir: tempHome(), version: '1.0.0', platform: 'test' });
      expect(headers['X-Msh-Device-Model']).toBe('macOS 25.5.0 arm64');
    } finally {
      unmockDarwinHost();
    }
  });
});
