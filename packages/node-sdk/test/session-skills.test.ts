/**
 * Scenario: public SDK skill discovery and activation.
 * Responsibilities: list workspace/session skills and activate a session skill through KimiHarness.
 * Wiring: the in-process core and filesystem are real; only the remote model provider is stubbed.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-skills.test.ts
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createKimiHarness,
  createKimiHarnessV2,
  type Event,
  type KimiError,
  type SkillActivatedEvent,
  type SkillSummary,
} from '#/index';
import type { SDKRpcClientBase } from '#/rpc';

import { normalizeWorkDir } from '../../agent-core/src/session/store';
import {
  makeTempDir,
  removeTempDirs,
  waitForAgentWireEvent,
  waitForSDKEvent,
} from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const fakeProviderState = vi.hoisted(() => ({
  histories: [] as unknown[],
  responseText: 'skill response',
}));

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof KosongModule>();
  return {
    ...actual,
    createProvider: () => ({
      name: 'fake',
      modelName: 'fake-model',
      thinkingEffort: null,
      async generate(_systemPrompt: string, _tools: unknown, history: unknown) {
        fakeProviderState.histories.push(history);
        return {
          id: 'fake-response',
          usage: {
            inputOther: 0,
            output: 1,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
          finishReason: 'completed',
          rawFinishReason: 'stop',
          async *[Symbol.asyncIterator]() {
            yield { type: 'text', text: fakeProviderState.responseText };
          },
        };
      },
      withThinking() {
        return this;
      },
    }),
  };
});

const { Session } = await import('#/index');

const tempDirs: string[] = [];

const CONFIG_ENV_PATTERN =
  /^(KIMI_MODEL_|KIMI_LOOP_|KIMI_MCP_|KIMI_WEB_|KIMI_IMAGE_|KIMI_CODE_BACKGROUND_|KIMI_CODE_MODEL_CATALOG_)/;

/** Keep ambient env from injecting providers/models into the v2 engine. */
function scrubConfigEnv(): () => void {
  const saved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CONFIG_ENV_PATTERN.test(key)) {
      saved[key] = value;
      delete process.env[key];
    }
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      process.env[key] = value;
    }
  };
}

beforeEach(() => {
  fakeProviderState.histories.length = 0;
  fakeProviderState.responseText = 'skill response';
});

afterEach(async () => {
  await removeTempDirs(tempDirs);
  vi.unstubAllEnvs();
});

describe('Session skills', () => {
  it('submits multiple skills with a prompt as one grouped turn (v2 engine)', async () => {
    const restoreEnv = scrubConfigEnv();
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
    await writeSkill(workDir, 'security', [
      '---',
      'name: security',
      'description: Check security',
      '---',
      '',
      'Check the requested file for security issues.',
    ]);
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_multi_skill', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      // Model-less on purpose: the grouped surface (activation events, single
      // turn) settles before the provider-less turn fails asynchronously.
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

      await session.promptWithSkills(
        'Review this change.',
        [{ name: 'review' }, { name: 'security' }],
      );
      await ended;
      unsubscribe();

      const activations = events.filter(
        (event): event is Extract<Event, { type: 'skill.activated' }> =>
          event.type === 'skill.activated',
      );
      expect(activations.map((event) => event.skillName)).toEqual(['review', 'security']);
      expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
    } finally {
      await harness.close();
      restoreEnv();
    }
  });

  it('rejects promptWithSkills on the v1 engine', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_multi_skill_v1', workDir });
      await expect(
        session.promptWithSkills('Review this change.', [{ name: 'review' }]),
      ).rejects.toMatchObject({
        code: 'not_implemented',
      });
    } finally {
      await harness.close();
    }
  });

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
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
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

  it('activates a skill through core and emits the public skill event', async () => {
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
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_activate', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      const activated = waitForSDKEvent(session, (event) => event.type === 'skill.activated');
      const metaUpdated = waitForSDKEvent(
        session,
        (event) => event.type === 'session.meta.updated',
      );
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

      await session.activateSkill(' review ', ' src/app.ts ');
      const activatedEvent = await activated;
      const metaEvent = await metaUpdated;
      await ended;
      unsubscribe();

      expect(activatedEvent).toMatchObject({
        type: 'skill.activated',
        sessionId: session.id,
        agentId: 'main',
        skillName: 'review',
        skillArgs: 'src/app.ts',
        trigger: 'user-slash',
        skillSource: 'project',
      });
      expect(JSON.stringify(activatedEvent)).not.toContain('Review the requested file.');
      expect(events.findIndex((event) => event.type === 'skill.activated')).toBeGreaterThanOrEqual(
        0,
      );
      expect(events.findIndex((event) => event.type === 'turn.started')).toBeGreaterThan(
        events.findIndex((event) => event.type === 'skill.activated'),
      );
      expect(metaEvent).toMatchObject({
        type: 'session.meta.updated',
        sessionId: session.id,
        agentId: 'main',
        title: '/review src/app.ts',
        patch: {
          title: '/review src/app.ts',
          isCustomTitle: false,
          lastPrompt: '/review src/app.ts',
        },
      });

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(state['title']).toBe('/review src/app.ts');
      expect(state['isCustomTitle']).toBe(false);
      expect(state['lastPrompt']).toBe('/review src/app.ts');

      const skillDir = normalizeWorkDir(await realpath(join(workDir, '.kimi-code', 'skills', 'review')));
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'turn.prompt',
          (event) => event['origin'] !== undefined,
        ),
      ).resolves.toMatchObject({
        type: 'turn.prompt',
        input: [
          {
            type: 'text',
            text: [
              'User activated the skill "review". Follow the loaded skill instructions.',
              '',
              `<kimi-skill-loaded name="review" trigger="user-slash" source="project" dir="${skillDir}" args="src/app.ts">`,
              'Review the requested file.',
              '',
              'ARGUMENTS: src/app.ts',
              '</kimi-skill-loaded>',
            ].join('\n'),
          },
        ],
        origin: {
          kind: 'skill_activation',
          skillName: 'review',
          skillArgs: 'src/app.ts',
        },
      });
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
    const harness = createKimiHarness({ identity: TEST_IDENTITY });

    try {
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
