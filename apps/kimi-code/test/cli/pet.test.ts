/**
 * `kimi pet` CLI layer: start/stop lifecycle with injected deps — no real
 * Electron download, no real process spawn. Covers pidfile idempotency,
 * error paths, and skin env forwarding.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handlePet, type PetDeps } from '#/cli/sub/pet';

describe('handlePet', () => {
  let dir: string;
  let pidFile: string;
  let out: string[];
  let errored: string[];

  function makeDeps(over: Partial<PetDeps> = {}): PetDeps {
    return {
      ensureElectron: vi.fn(async () => '/cache/electron/Electron'),
      resolveOverlayEntry: () => join(dir, 'pet-overlay.mjs'),
      spawnProcess: vi.fn(() => ({
        pid: 4321,
        unref: vi.fn(),
      })) as unknown as PetDeps['spawnProcess'],
      pidFile,
      isProcessAlive: () => false,
      killProcess: vi.fn(),
      stdout: {
        write: (s: string) => {
          out.push(s);
          return true;
        },
      },
      stderr: {
        write: (s: string) => {
          errored.push(s);
          return true;
        },
      },
      exit: vi.fn() as unknown as PetDeps['exit'],
      ...over,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pet-cmd-'));
    pidFile = join(dir, 'overlay.pid');
    out = [];
    errored = [];
    // The overlay entry must exist for the start path.
    writeFileSync(join(dir, 'pet-overlay.mjs'), '// overlay');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('spawns the detached overlay and writes the pidfile', async () => {
    const deps = makeDeps();
    await handlePet(deps, { stop: false });
    expect(deps.ensureElectron).toHaveBeenCalledOnce();
    expect(deps.spawnProcess).toHaveBeenCalledWith(
      '/cache/electron/Electron',
      [join(dir, 'pet-overlay.mjs')],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(existsSync(pidFile)).toBe(true);
    expect(out.join('')).toContain('kimi pet is on your desktop');
  });

  it('forwards the selected skin via env', async () => {
    const deps = makeDeps();
    await handlePet(deps, { stop: false, skin: 'cat' });
    const env = (deps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(env?.['KIMI_PET_SKIN']).toBe('cat');
  });

  it('is idempotent when the pet is already running', async () => {
    writeFileSync(pidFile, '4321');
    const deps = makeDeps({ isProcessAlive: () => true });
    await handlePet(deps, { stop: false });
    expect(deps.spawnProcess).not.toHaveBeenCalled();
    expect(out.join('')).toContain('already running');
  });

  it('exits with an error when the overlay bundle is missing', async () => {
    rmSync(join(dir, 'pet-overlay.mjs'));
    const deps = makeDeps();
    await handlePet(deps, { stop: false });
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(errored.join('')).toContain('not found');
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });

  it('exits with an error when the Electron runtime cannot be set up', async () => {
    const deps = makeDeps({
      ensureElectron: vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    });
    await handlePet(deps, { stop: false });
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(errored.join('')).toContain('network unreachable');
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });

  it('stops a running pet and removes the pidfile', async () => {
    writeFileSync(pidFile, '4321');
    const deps = makeDeps({ isProcessAlive: () => true });
    await handlePet(deps, { stop: true });
    expect(deps.killProcess).toHaveBeenCalledWith(4321);
    expect(existsSync(pidFile)).toBe(false);
    expect(out.join('')).toContain('stopped');
  });

  it('reports stop as a no-op when the pet is not running', async () => {
    const deps = makeDeps();
    await handlePet(deps, { stop: true });
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(out.join('')).toContain('not running');
  });
});
