/**
 * Scenario: v1↔v2 parity gate — for every SDK method migrated to
 * agent-core-v2, the v1 harness (`createKimiHarness`) and the v2 harness
 * (`createKimiHarnessV2`) must return identical values on the same fixture
 * home. A method only counts as migrated while its comparison here passes;
 * temporary, understood gaps are pinned explicitly in `KNOWN_DIFFS` so the
 * list can only shrink deliberately, never grow silently.
 * Wiring: real v1 core and real v2 engine, both in-process on a temp
 * KIMI_CODE_HOME; no provider calls.
 * Run: pnpm exec vitest run test/v1-v2-parity.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, createKimiHarnessV2, type KimiHarness } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Understood v1↔v2 return-value gaps, pinned per method with the reason.
 * Each entry is a projection applied to BOTH results before comparison, so
 * the comparison still covers everything not listed here. Keep empty unless a
 * gap is genuinely accepted; remove entries as gaps close.
 */
const KNOWN_DIFFS = {
  // v2's flag registry is per-domain and already carries flags v1 does not
  // have (fault-injection, minidb backend, subagent); v1-only flags would be
  // the symmetric case. Parity is enforced on the intersection of ids until
  // the registries are unified.
  getExperimentalFeatures: (
    features: readonly { id: string }[],
    other: readonly { id: string }[],
  ): readonly { id: string }[] => {
    const otherIds = new Set(other.map((feature) => feature.id));
    return features.filter((feature) => otherIds.has(feature.id));
  },
} satisfies Record<string, (value: never, other: never) => unknown>;

/** Cross the same JSON boundary both engines' values already crossed, then
 *  sort object arrays by `key` so ordering differences don't count. */
function normalize(value: unknown, key: string): unknown {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value));
  if (Array.isArray(roundTripped)) {
    return roundTripped.toSorted((a, b) =>
      JSON.stringify(a[key] ?? a).localeCompare(JSON.stringify(b[key] ?? b)),
    );
  }
  return roundTripped;
}

interface ParityFixture {
  readonly v1: KimiHarness;
  readonly v2: KimiHarness;
  readonly homeDir: string;
}

async function makeParityPair(): Promise<ParityFixture> {
  const homeDir = await makeTempDir('kimi-sdk-parity-home-');
  const v1 = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
  const v2 = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
  return { v1, v2, homeDir };
}

async function closeAll(...harnesses: readonly KimiHarness[]): Promise<void> {
  for (const harness of harnesses) {
    await harness.close();
  }
}

describe('v1↔v2 return-value parity', () => {
  it('getExperimentalFeatures matches on the shared flag ids', async () => {
    const { v1, v2 } = await makeParityPair();
    try {
      const [v1Features, v2Features] = await Promise.all([
        v1.getExperimentalFeatures(),
        v2.getExperimentalFeatures(),
      ]);
      const project = KNOWN_DIFFS.getExperimentalFeatures;
      expect(normalize(project(v2Features, v1Features), 'id')).toEqual(
        normalize(project(v1Features, v2Features), 'id'),
      );
    } finally {
      await closeAll(v1, v2);
    }
  });

  it('listWorkspaceSkills returns the same skills on the same fixture', async () => {
    const { v1, v2, homeDir } = await makeParityPair();
    const workDir = await makeTempDir('kimi-sdk-parity-work-');
    await writeSkill(join(homeDir, 'skills', 'parity-user-skill'), 'parity-user-skill');
    await writeSkill(
      join(workDir, '.kimi-code', 'skills', 'parity-project-skill'),
      'parity-project-skill',
    );
    try {
      const [v1Skills, v2Skills] = await Promise.all([
        v1.listWorkspaceSkills(workDir),
        v2.listWorkspaceSkills(workDir),
      ]);
      expect(normalize(v2Skills, 'name')).toEqual(normalize(v1Skills, 'name'));
    } finally {
      await closeAll(v1, v2);
    }
  });
});

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name} for the parity test\n---\n\nBody of ${name}.\n`,
    'utf-8',
  );
}
