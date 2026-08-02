import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, KimiHarness, SDKRpcClientBase, type ImageLimits } from '#/index';

import { recordingTelemetry } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The recursive RPC surface KimiHarness touches for the tests below: kept
 * minimal like the StubRpc in create-session-transport.test.ts.
 */
class StubRpc extends SDKRpcClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    throw new Error('no core calls expected');
  }
}

describe('KimiHarness imageLimits', () => {
  it('exposes the in-process core [image] limits loaded from config.toml', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[image]
max_edge_px = 1200
read_byte_budget = 65536
`,
      'utf-8',
    );

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      // The Rust engine owns image handling; the SDK harness carries no
      // client-side ingestion limits under the native engine.
      expect(harness.imageLimits).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('falls back to built-in defaults when no [image] section is configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      expect(harness.imageLimits).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('a hand-built harness returns the injected ImageLimits as-is', () => {
    const limits: ImageLimits = { maxEdgePx: 900, readByteBudget: 65536 };
    const harness = new KimiHarness(new StubRpc(), {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry([]),
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
      imageLimits: limits,
    });

    expect(harness.imageLimits).toBe(limits);
    expect(harness.imageLimits?.maxEdgePx).toBe(900);
  });
});
