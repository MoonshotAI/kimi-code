/**
 * Scenario: public SDK skill discovery and activation.
 * Responsibilities: list workspace/session skills and activate a session skill through KimiHarness.
 * Wiring: the in-process core and filesystem are real; only the remote model provider is stubbed.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-skills.test.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createKimiHarness,
  type Event,
  type KimiError,
  type SkillActivatedEvent,
  type SkillSummary,
} from '#/index';
import type { SDKRpcClientBase } from '#/rpc';

import {
  fakeLlmStep,
  makeTempDir,
  removeTempDirs,
  waitForSDKEvent,
  writeFakeModelConfig,
} from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

/**
 * Fake host-proxy model step state. The Rust engine runs turns against the
 * `llmStep` host callback (the retired JS-engine kosong `createProvider` mock
 * does not reach the engine), so tests drive and inspect the step here.
 */
const llmState: {
  calls: Array<{ system_prompt: string; messages: unknown; model_name?: string }>;
  responseText: string;
} = {
  calls: [],
  responseText: 'skill response',
};

const { Session } = await import('#/index');

const tempDirs: string[] = [];

beforeEach(() => {
  llmState.calls.length = 0;
  llmState.responseText = 'skill response';
});

afterEach(async () => {
  await removeTempDirs(tempDirs);
  vi.unstubAllEnvs();
});

describe('Session skills', () => {
  it('lists session skills without exposing content', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      'disable_model_invocation: true',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_sdk_skill_list', workDir });

      const skills = await session.listSkills();
      const listed = skills.find((skill) => skill.name === 'review');

      expect(listed).toMatchObject({
        name: 'review',
        description: 'Review code',
        source: 'project',
        disableModelInvocation: true,
      });
      expect(listed?.path.endsWith('/.kimi-code/skills/review/SKILL.md')).toBe(true);
      expect(JSON.stringify(skills)).not.toContain('Review the requested file.');
    } finally {
      await harness.close();
    }
  });

  it('activates a skill through core and emits engine turn events', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_sdk_skill_activate', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      // The engine signals activation by running a turn over the seeded skill
      // prompt (`session.turn.started`/`session.turn.ended`); the legacy
      // `skill.activated` event is no longer part of the public contract.
      const started = waitForSDKEvent(session, (event) => event.type === 'session.turn.started');
      const ended = waitForSDKEvent(session, (event) => event.type === 'session.turn.ended');

      await session.activateSkill(' review ', ' src/app.ts ');
      const startedEvent = await started;
      await ended;
      unsubscribe();

      expect(startedEvent).toMatchObject({
        type: 'session.turn.started',
        sessionId: session.id,
        agentId: 'main',
      });
      expect(events).toContainEqual(expect.objectContaining({ type: 'session.turn.ended' }));
      expect(JSON.stringify(events)).not.toContain('Review the requested file.');

      // The engine loads the skill body from disk at activation and seeds it
      // as the turn's user message; the host-proxy model step observes the
      // rendered prompt (trimmed name, loaded body, trimmed arguments). The
      // session directory / host wire.jsonl surface is engine-internal now.
      const renderedMessages = llmState.calls[0]?.messages;
      expect(renderedMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('[Skill: review]'),
          }),
        ]),
      );
      const renderedText = JSON.stringify(renderedMessages);
      expect(renderedText).toContain('Review the requested file.');
      expect(renderedText).toContain('Args: src/app.ts');
    } finally {
      await harness.close();
    }
  });

  it('resolves user brand skills from KIMI_CODE_HOME, not the OS home', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const processHome = await makeTempDir(tempDirs, 'kimi-sdk-skills-process-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    vi.stubEnv('HOME', processHome);
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    await writeLegacyUserSkill(processHome, 'sdk-real-home-only', 'SDK real home skill');
    await writeBrandUserSkill(homeDir, 'sdk-sandbox-only', 'SDK sandbox skill');
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_sdk_skill_env_home', workDir });
      const names = new Set((await session.listSkills()).map((skill) => skill.name));

      expect(names.has('sdk-real-home-only')).toBe(false);
      expect(names.has('sdk-sandbox-only')).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('rejects empty names before calling RPC and rejects after close', async () => {
    const activateSkill = vi.fn(async () => {});
    const closeSession = vi.fn(async (_input: { readonly sessionId: string }) => {});
    const clearSessionHandlers = vi.fn();
    const listSkills = vi.fn(async () => []);
    const session = new Session({
      id: 'ses_skill_validation',
      workDir: '/tmp/work',
      rpc: {
        activateSkill,
        closeSession,
        clearSessionHandlers,
        listSkills,
      } as unknown as SDKRpcClientBase,
    });

    await expect(session.activateSkill('   ')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'skill.name_empty',
    } satisfies Partial<KimiError>);
    expect(activateSkill).not.toHaveBeenCalled();

    await session.close();
    expect(closeSession).toHaveBeenCalledWith({ sessionId: session.id });
    expect(clearSessionHandlers).toHaveBeenCalledWith(session.id);
    await expect(session.listSkills()).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
    await expect(session.activateSkill('review')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
  });

  it('finalizes local close state when the core close RPC fails', async () => {
    const closeSession = vi.fn(async (_input: { readonly sessionId: string }) => {
      throw new Error('flush failed');
    });
    const clearSessionHandlers = vi.fn();
    const listSkills = vi.fn(async () => []);
    const activateSkill = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_close_failed',
      workDir: '/tmp/work',
      rpc: {
        activateSkill,
        closeSession,
        clearSessionHandlers,
        listSkills,
      } as unknown as SDKRpcClientBase,
    });

    await expect(session.close()).rejects.toThrow('flush failed');
    await expect(session.close()).resolves.toBeUndefined();
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(clearSessionHandlers).toHaveBeenCalledWith(session.id);
    await expect(session.listSkills()).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
  });

  it('exposes public skill event and summary types', () => {
    expectTypeOf<SkillSummary['name']>().toEqualTypeOf<string>();
    expectTypeOf<SkillActivatedEvent['skillName']>().toEqualTypeOf<string>();
  });
});

describe('KimiHarness workspace skills', () => {
  it('returns project skills when no session exists', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-work-');
    await writeSkill(workDir, 'workspace-review', [
      '---',
      'name: workspace-review',
      'description: Review workspace changes',
      '---',
      '',
      'Inspect every changed file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const skills = await harness.listWorkspaceSkills(workDir);

      expect(skills.find((skill) => skill.name === 'workspace-review')).toMatchObject({
        name: 'workspace-review',
        description: 'Review workspace changes',
        source: 'project',
      });
      expect(harness.sessions.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('preserves the core error when workDir is empty', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-home-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(harness.listWorkspaceSkills('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
        message: 'listWorkspaceSkills requires workDir',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('preserves the core error when workDir is not a string', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-home-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(harness.listWorkspaceSkills(null as never)).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
        message: 'listWorkspaceSkills requires workDir',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});

async function writeSkill(workDir: string, name: string, lines: readonly string[]): Promise<void> {
  const dir = join(workDir, '.kimi-code', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), lines.join('\n'));
}

async function writeLegacyUserSkill(
  userHomeDir: string,
  name: string,
  description: string,
): Promise<void> {
  await writeSkillFile(join(userHomeDir, '.kimi-code', 'skills', name), name, description);
}

async function writeBrandUserSkill(
  brandHomeDir: string,
  name: string,
  description: string,
): Promise<void> {
  await writeSkillFile(join(brandHomeDir, 'skills', name), name, description);
}

async function writeSkillFile(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `${description}.`].join(
      '\n',
    ),
  );
}
