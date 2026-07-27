/**
 * Scenario: v2 wiring MVP — the harness talks to the in-process agent-core-v2
 * engine (klient memory transport) instead of the v1 KimiCore RPC pair.
 * Responsibilities: `getExperimentalFeatures` is migrated end-to-end; every
 * not-yet-migrated method fails loudly with `not_implemented` instead of
 * silently hitting a v1 core.
 * Wiring: real v2 engine bootstrapped on a temp KIMI_CODE_HOME; no provider calls.
 * Run: pnpm exec vitest run test/sdk-rpc-client-v2.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarnessV2, ErrorCodes, KimiError, KimiHarness } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<KimiHarness> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
  tempDirs.push(homeDir);
  return createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
}

describe('SDKRpcClientV2 (agent-core-v2 wiring MVP)', () => {
  it('serves getExperimentalFeatures from the v2 engine', async () => {
    const harness = await makeHarness();
    try {
      const features = await harness.getExperimentalFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
      for (const feature of features) {
        expect(typeof feature.id).toBe('string');
        expect(typeof feature.title).toBe('string');
        expect(typeof feature.env).toBe('string');
        expect(typeof feature.enabled).toBe('boolean');
        expect(typeof feature.defaultEnabled).toBe('boolean');
      }
    } finally {
      await harness.close();
    }
  });

  it('fails loudly with not_implemented for methods not yet migrated', async () => {
    const harness = await makeHarness();
    try {
      await expect(harness.listSessions()).rejects.toThrowError(KimiError);
      await expect(harness.listSessions()).rejects.toMatchObject({
        code: ErrorCodes.NOT_IMPLEMENTED,
      });
    } finally {
      await harness.close();
    }
  });
});
