/**
 * G1 — configService + bootstrapService host-side tests over the rust
 * transport. No engine RPC is involved: config reads/writes resolve through
 * node-sdk (`loadRuntimeConfigSafe`) and the local TOML port, so each test
 * runs against a fresh temp home and never touches the real user config.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Klient } from '#/core/klient';
import { createKlientFromRust } from '#/transports/rust/index';

/** Forward-slash-normalized join (the transport reports normalized paths). */
function normJoin(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '').replaceAll('\\', '/')}/${name}`;
}

describe('rust transport configService', () => {
  let homeDir: string;
  let configPath: string;
  let klient: Klient;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'klient-config-'));
    configPath = normJoin(homeDir, 'config.toml');
    klient = createKlientFromRust({ homeDir });
  });

  afterEach(async () => {
    await klient.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('set persists a scalar domain to config.toml (snake_case) and get reads it back', async () => {
    await klient.global.config.set({ domain: 'defaultModel', patch: 'moonshot-kimi-k2' });

    expect(await klient.global.config.get('defaultModel')).toBe('moonshot-kimi-k2');
    expect(existsSync(configPath)).toBe(true);
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('default_model = "moonshot-kimi-k2"');
  });

  it('set deep-merges into a section and persists snake_case fields', async () => {
    await klient.global.config.set({ domain: 'thinking', patch: { effort: 'high' } });

    expect(await klient.global.config.get('thinking')).toEqual({ effort: 'high' });
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('[thinking]');
    expect(text).toContain('effort = "high"');
  });

  it('set does not clobber unrelated domains already in config.toml', async () => {
    writeFileSync(configPath, 'default_model = "existing"\n[thinking]\neffort = "low"\n');

    await klient.global.config.set({ domain: 'thinking', patch: { enabled: true } });

    expect(await klient.global.config.get('defaultModel')).toBe('existing');
    expect(await klient.global.config.get('thinking')).toEqual({ enabled: true, effort: 'low' });
  });

  it('replace overwrites the whole domain value', async () => {
    await klient.global.config.set({ domain: 'defaultModel', patch: 'a' });
    await klient.global.config.replace({ domain: 'defaultModel', value: 'b' });

    expect(await klient.global.config.get('defaultModel')).toBe('b');
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('default_model = "b"');
    expect(text).not.toContain('default_model = "a"');
  });

  it('getAll returns the merged record without the raw key', async () => {
    await klient.global.config.set({ domain: 'defaultModel', patch: 'k2' });

    const all = await klient.global.config.getAll();
    expect(all['defaultModel']).toBe('k2');
    expect('raw' in all).toBe(false);
    expect(all['providers']).toEqual({});
  });

  it('set with target memory stays in-process and never touches disk', async () => {
    await klient.global.config.set({ domain: 'planMode', patch: true, target: 'memory' });

    expect(await klient.global.config.get('planMode')).toBe(true);
    expect(existsSync(configPath)).toBe(false);

    const inspected = await klient.global.config.inspect('planMode');
    expect(inspected.value).toBe(true);
    expect(inspected.memoryValue).toBe(true);
  });

  it('inspect reports userValue from disk and memoryValue from the overlay', async () => {
    await klient.global.config.set({ domain: 'defaultModel', patch: 'disk-value' });
    await klient.global.config.set({
      domain: 'defaultModel',
      patch: 'mem-value',
      target: 'memory',
    });

    const inspected = await klient.global.config.inspect('defaultModel');
    expect(inspected.value).toBe('mem-value');
    expect(inspected.userValue).toBe('disk-value');
    expect(inspected.memoryValue).toBe('mem-value');
  });

  it('reload re-reads the on-disk config after an external edit', async () => {
    await klient.global.config.set({ domain: 'defaultModel', patch: 'a' });
    writeFileSync(configPath, 'default_model = "edited"\n');

    await klient.global.config.reload();
    expect(await klient.global.config.get('defaultModel')).toBe('edited');
  });

  it('diagnostics reports an error for an unparseable config file', async () => {
    writeFileSync(configPath, 'default_model = [unclosed\n');

    const diagnostics = await klient.global.config.diagnostics();
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('diagnostics reports a warning for salvageable breakage', async () => {
    writeFileSync(configPath, '[providers]\nbogus = { type = "not-a-provider-type" }\n');

    const diagnostics = await klient.global.config.diagnostics();
    expect(diagnostics.some((d) => d.severity === 'warning')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('providers.bogus'))).toBe(true);
  });

  it('set refuses to overwrite a file that cannot be parsed at all', async () => {
    writeFileSync(configPath, 'default_model = [unclosed\n');

    await expect(
      klient.global.config.set({ domain: 'defaultModel', patch: 'k2' }),
    ).rejects.toThrow(/invalid/i);
  });
});

describe('rust transport bootstrapService', () => {
  let homeDir: string;
  let klient: Klient;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'klient-boot-'));
    klient = createKlientFromRust({ homeDir });
  });

  afterEach(async () => {
    await klient.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('env() reports the host snapshot from the resolved home', async () => {
    const env = await klient.global.env();

    expect(env.platform).toBe(process.platform);
    expect(env.arch).toBe(process.arch);
    expect(env.cwd).toBe(process.cwd());
    expect(env.homeDir).toBe(homeDir);
    expect(env.configPath).toBe(normJoin(homeDir, 'config.toml'));
    expect(env.sessionsDir).toBe(normJoin(homeDir, 'sessions'));
    expect(env.blobsDir).toBe(normJoin(homeDir, 'blobs'));
    expect(env.storeDir).toBe(normJoin(homeDir, 'store'));
    expect(env.cacheDir).toBe(normJoin(homeDir, 'cache'));
    expect(env.logsDir).toBe(normJoin(homeDir, 'logs'));
    expect(typeof env.osHomeDir).toBe('string');
    expect(env.osHomeDir.length).toBeGreaterThan(0);
    expect(typeof env.clientVersion).toBe('string');
    expect(env.clientVersion.length).toBeGreaterThan(0);
  });
});
