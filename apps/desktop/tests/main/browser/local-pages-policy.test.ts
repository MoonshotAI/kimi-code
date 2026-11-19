import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FUSE_READ_TIMEOUT_MS,
  UNSAFE_LOCAL_PAGES_ENV,
  createLocalPagesPolicy,
  electronFuseBinary,
  fileProtocolPrivilegesDisabled,
} from '../../../src/main/browser/local-pages-policy';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

function wire(grantFileProtocolExtraPrivileges: string, { version = 1, length = 9 } = {}): Buffer {
  const fuses = `1111111${grantFileProtocolExtraPrivileges}1`.slice(0, length);
  return Buffer.concat([Buffer.from(SENTINEL), Buffer.from([version, length]), Buffer.from(fuses)]);
}

function binary(...parts: Buffer[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'kimi-fuse-')), 'Electron');
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

const filler = (size: number) => Buffer.alloc(size, 0x2e);

describe('fileProtocolPrivilegesDisabled', () => {
  it('reads the GrantFileProtocolExtraPrivileges fuse from the fuse wire', async () => {
    expect(await fileProtocolPrivilegesDisabled(binary(filler(100), wire('0'), filler(100)))).toBe(true);
    expect(await fileProtocolPrivilegesDisabled(binary(filler(100), wire('1'), filler(100)))).toBe(false);
    expect(await fileProtocolPrivilegesDisabled(binary(filler(100), wire('r'), filler(100)))).toBe(false);
  });

  it('finds the wire wherever chunk boundaries fall', async () => {
    for (const lead of [0, 1, 5, 31, 32, 33, 40]) {
      const file = binary(filler(lead), wire('0'), filler(3));
      for (const chunkSize of [7, 16, 33, 64]) {
        expect(await fileProtocolPrivilegesDisabled(file, chunkSize), `lead ${lead}, chunk ${chunkSize}`).toBe(true);
      }
    }
  });

  it('requires every slice of a universal binary to have the fuse off', async () => {
    expect(await fileProtocolPrivilegesDisabled(binary(wire('0'), filler(50), wire('0')), 16)).toBe(true);
    expect(await fileProtocolPrivilegesDisabled(binary(wire('0'), filler(50), wire('1')), 16)).toBe(false);
  });

  it('treats a missing, unknown or short wire as not confirmed', async () => {
    expect(await fileProtocolPrivilegesDisabled(binary(filler(200)))).toBe(false);
    expect(await fileProtocolPrivilegesDisabled(binary(wire('0', { version: 2 })))).toBe(false);
    expect(await fileProtocolPrivilegesDisabled(binary(wire('0', { length: 7 }), filler(20)))).toBe(false);
  });

  it('reports the fuse as on in the stock Electron used for development', async () => {
    const executable = createRequire(import.meta.url)('electron') as string;
    expect(await fileProtocolPrivilegesDisabled(electronFuseBinary(executable, process.platform))).toBe(false);
  }, 30_000);
});

describe('electronFuseBinary', () => {
  it('points at the Electron framework on macOS and the executable elsewhere', () => {
    expect(electronFuseBinary('/Applications/Kimi Code.app/Contents/MacOS/Kimi Code', 'darwin'))
      .toBe('/Applications/Kimi Code.app/Contents/Frameworks/Electron Framework.framework/Electron Framework');
    expect(electronFuseBinary('C:\\Program Files\\Kimi Code\\Kimi Code.exe', 'win32')).toBe('C:\\Program Files\\Kimi Code\\Kimi Code.exe');
    expect(electronFuseBinary('/opt/Kimi Code/kimi-code-app', 'linux')).toBe('/opt/Kimi Code/kimi-code-app');
  });
});

describe('createLocalPagesPolicy', () => {
  const base = { execPath: '/opt/app/kimi', platform: 'linux' as const, env: {} };

  it('keeps local pages off in unpackaged builds without reading the binary', async () => {
    const readFuse = vi.fn(async () => true);
    expect(await createLocalPagesPolicy({ ...base, isPackaged: false, warn: vi.fn(), readFuse })()).toBe(false);
    expect(readFuse).not.toHaveBeenCalled();
  });

  it('allows local pages in packaged builds only when the fuse is confirmed off', async () => {
    expect(await createLocalPagesPolicy({ ...base, isPackaged: true, warn: vi.fn(), readFuse: async () => true })()).toBe(true);
    expect(await createLocalPagesPolicy({ ...base, isPackaged: true, warn: vi.fn(), readFuse: async () => false })()).toBe(false);
    expect(await createLocalPagesPolicy({ ...base, isPackaged: true, warn: vi.fn(), readFuse: async () => { throw new Error('EACCES'); } })()).toBe(false);
  });

  it('reads the fuse once per run', async () => {
    const readFuse = vi.fn(async () => true);
    const allowed = createLocalPagesPolicy({ ...base, isPackaged: true, warn: vi.fn(), readFuse });
    await allowed();
    await allowed();
    expect(readFuse).toHaveBeenCalledOnce();
    expect(readFuse).toHaveBeenCalledWith('/opt/app/kimi');
  });

  it('gives up on a fuse read that never returns', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const allowed = createLocalPagesPolicy({ ...base, isPackaged: true, warn, readFuse: () => new Promise<boolean>(() => {}) });
      const decision = allowed();
      await vi.advanceTimersByTimeAsync(FUSE_READ_TIMEOUT_MS);
      expect(await decision).toBe(false);
      expect(warn.mock.calls[0]![0]).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports extra file privileges unless the fuse is confirmed off', async () => {
    const off = createLocalPagesPolicy({ ...base, isPackaged: true, warn: vi.fn(), readFuse: async () => true });
    expect(off.extraPrivileges()).toBe(true);
    await off();
    expect(off.extraPrivileges()).toBe(false);

    const on = createLocalPagesPolicy({ ...base, isPackaged: true, env: { [UNSAFE_LOCAL_PAGES_ENV]: '1' }, warn: vi.fn(), readFuse: async () => false });
    expect(await on()).toBe(true);
    expect(on.extraPrivileges()).toBe(true);

    const unpackaged = createLocalPagesPolicy({ ...base, isPackaged: false, env: { [UNSAFE_LOCAL_PAGES_ENV]: '1' }, warn: vi.fn(), readFuse: async () => true });
    expect(await unpackaged()).toBe(true);
    expect(unpackaged.extraPrivileges()).toBe(true);
  });

  it('lets a developer opt in explicitly, with a warning', async () => {
    const warn = vi.fn();
    const readFuse = vi.fn(async () => false);
    const allowed = createLocalPagesPolicy({ ...base, isPackaged: false, env: { [UNSAFE_LOCAL_PAGES_ENV]: '1' }, warn, readFuse });
    expect(await allowed()).toBe(true);
    expect(await allowed()).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(UNSAFE_LOCAL_PAGES_ENV);
    expect(warn.mock.calls[0]![0]).toContain('cannot reproduce shipped file:// behaviour');
    expect(readFuse).not.toHaveBeenCalled();
    expect(await createLocalPagesPolicy({ ...base, isPackaged: false, env: { [UNSAFE_LOCAL_PAGES_ENV]: 'true' }, warn: vi.fn(), readFuse })()).toBe(false);
  });

  it('prefers a packaged build with the fuse off over the developer opt-in', async () => {
    const warn = vi.fn();
    const readFuse = vi.fn(async () => true);
    const allowed = createLocalPagesPolicy({ ...base, isPackaged: true, env: { [UNSAFE_LOCAL_PAGES_ENV]: '1' }, warn, readFuse });
    expect(await allowed()).toBe(true);
    expect(allowed.extraPrivileges()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
