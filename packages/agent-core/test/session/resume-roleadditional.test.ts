import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { testKaos } from '../fixtures/test-kaos';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-core-resume-roleadditional-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: {
          type: MOCK_PROVIDER.type,
          apiKey: MOCK_PROVIDER.apiKey,
        },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}

function customRoleAdditionalProfile(roleAdditionalMarker: string): ResolvedAgentProfile {
  return {
    name: 'role-additional-test',
    systemPrompt: ({ roleAdditional }) =>
      `system prompt marker: ${roleAdditionalMarker}; roleAdditional: ${roleAdditional ?? '<empty>'}`,
    tools: [],
  };
}

describe('Session.resume with roleAdditional', () => {
  it('re-renders the system prompt with the fresh roleAdditional after replay', async () => {
    const sessionDir = await makeTempDir();
    const workDir = await makeTempDir();

    // Launch 1: create and persist a session with roleAdditional "W1".
    const session1 = new Session({
      id: 'test-resume-roleadditional',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W1',
    });

    const { agent: mainAgent1 } = await session1.createAgent(
      { type: 'main' },
      { profile: DEFAULT_AGENT_PROFILES['agent'] },
    );

    expect(mainAgent1.config.systemPrompt).toContain('role-additional-marker-W1');
    expect(mainAgent1.config.systemPrompt).not.toContain('role-additional-marker-W2');

    await session1.close();

    // Launch 2: resume the same session with roleAdditional "W2".
    const session2 = new Session({
      id: 'test-resume-roleadditional',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W2',
    });

    try {
      await session2.resume();
      const mainAgent2 = await session2.ensureAgentResumed('main');

      // The resumed agent must use the fresh W2 roleAdditional, not the stale W1.
      expect(mainAgent2.config.systemPrompt).toContain('role-additional-marker-W2');
      expect(mainAgent2.config.systemPrompt).not.toContain('role-additional-marker-W1');
    } finally {
      await session2.close();
    }
  });

  it('preserves the persisted roleAdditional when resume/reload omits it', async () => {
    const sessionDir = await makeTempDir();
    const workDir = await makeTempDir();

    // Launch 1: create and persist a session with roleAdditional "W1".
    const session1 = new Session({
      id: 'test-resume-roleadditional-omitted',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W1',
    });

    const { agent: mainAgent1 } = await session1.createAgent(
      { type: 'main' },
      { profile: DEFAULT_AGENT_PROFILES['agent'] },
    );

    expect(mainAgent1.config.systemPrompt).toContain('role-additional-marker-W1');
    await session1.close();

    // Launch 2: resume WITHOUT a roleAdditional, exactly as `/reload` and a plain
    // resumeSession({ id }) do — neither has a way to pass the value. The standing
    // prompt persisted with the session must be preserved, not cleared.
    const session2 = new Session({
      id: 'test-resume-roleadditional-omitted',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      // roleAdditional intentionally omitted.
    });

    try {
      await session2.resume();
      const mainAgent2 = await session2.ensureAgentResumed('main');

      // The standing prompt survives the omitted resume/reload.
      expect(mainAgent2.config.systemPrompt).toContain('role-additional-marker-W1');
    } finally {
      await session2.close();
    }
  });

  it('does not re-render the system prompt when roleAdditional is unchanged', async () => {
    const sessionDir = await makeTempDir();
    const workDir = await makeTempDir();
    await mkdir(join(workDir, '.git'));
    await writeFile(join(workDir, 'AGENTS.md'), 'initial resume instructions', 'utf-8');

    const session1 = new Session({
      id: 'test-resume-roleadditional-unchanged',
      kaos: testKaos.withCwd(workDir),
      persistenceKaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W1',
    });

    const { agent: mainAgent1 } = await session1.createAgent(
      { type: 'main' },
      { profile: DEFAULT_AGENT_PROFILES['agent'] },
    );

    expect(mainAgent1.config.systemPrompt).toContain('initial resume instructions');
    await session1.closeForReload();

    // Mutate AGENTS.md while the session is closed.
    await writeFile(join(workDir, 'AGENTS.md'), 'updated resume instructions', 'utf-8');

    // Resume with the same roleAdditional: the persisted prompt must stay intact.
    const session2 = new Session({
      id: 'test-resume-roleadditional-unchanged',
      kaos: testKaos.withCwd(workDir),
      persistenceKaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W1',
    });

    try {
      await session2.resume();
      const mainAgent2 = await session2.ensureAgentResumed('main');

      expect(mainAgent2.config.systemPrompt).toContain('initial resume instructions');
      expect(mainAgent2.config.systemPrompt).not.toContain('updated resume instructions');

      // An explicit refresh still picks up the new AGENTS.md.
      await mainAgent2.refreshSystemPrompt();
      expect(mainAgent2.config.systemPrompt).toContain('updated resume instructions');
      expect(mainAgent2.config.systemPrompt).not.toContain('initial resume instructions');
    } finally {
      await session2.close();
    }
  });

  it('leaves an unresolved custom profile unchanged when roleAdditional changes', async () => {
    const sessionDir = await makeTempDir();
    const workDir = await makeTempDir();

    const session1 = new Session({
      id: 'test-resume-roleadditional-custom',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W1',
    });

    const { agent: mainAgent1 } = await session1.createAgent(
      { type: 'main' },
      { profile: customRoleAdditionalProfile('W1') },
    );

    expect(mainAgent1.config.systemPrompt).toContain('roleAdditional: role-additional-marker-W1');
    await session1.close();

    // Resume with a different roleAdditional but a custom profile that cannot be
    // resolved from DEFAULT_AGENT_PROFILES. The persisted prompt must remain
    // unchanged and the resume must not throw.
    const session2 = new Session({
      id: 'test-resume-roleadditional-custom',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      providerManager: testProviderManager(),
      roleAdditional: 'role-additional-marker-W2',
    });

    try {
      await session2.resume();
      const mainAgent2 = await session2.ensureAgentResumed('main');

      expect(mainAgent2.config.systemPrompt).toContain('roleAdditional: role-additional-marker-W1');
      expect(mainAgent2.config.systemPrompt).not.toContain('roleAdditional: role-additional-marker-W2');
    } finally {
      await session2.close();
    }
  });
});
