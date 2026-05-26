import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Event, KimiError, SkillActivatedEvent, SkillSummary } from '#/index';
import type { SDKRpcClient } from '#/rpc';

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

const { KimiHarness, Session } = await import('#/index');

const tempDirs: string[] = [];

beforeEach(() => {
  fakeProviderState.histories.length = 0;
  fakeProviderState.responseText = 'skill response';
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
    const harness = new KimiHarness({ homeDir, identity: TEST_IDENTITY });

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
    const harness = new KimiHarness({ homeDir, identity: TEST_IDENTITY });

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
            text: 'Review the requested file.\n\nARGUMENTS: src/app.ts',
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

  it('resolves user skills from the OS home directory, independently of KIMI_CODE_HOME', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const processHome = await makeTempDir(tempDirs, 'kimi-sdk-skills-process-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    vi.stubEnv('HOME', processHome);
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    await writeUserSkill(processHome, 'sdk-real-home-only', 'SDK real home skill');
    await writeUserSkill(homeDir, 'sdk-sandbox-only', 'SDK sandbox skill');
    const harness = new KimiHarness({ identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_env_home', workDir });
      const names = new Set((await session.listSkills()).map((skill) => skill.name));

      expect(names.has('sdk-real-home-only')).toBe(true);
      expect(names.has('sdk-sandbox-only')).toBe(false);
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
      } as unknown as SDKRpcClient,
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
      } as unknown as SDKRpcClient,
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

async function writeSkill(workDir: string, name: string, lines: readonly string[]): Promise<void> {
  const dir = join(workDir, '.kimi-code', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), lines.join('\n'));
}

async function writeUserSkill(userHomeDir: string, name: string, description: string): Promise<void> {
  const dir = join(userHomeDir, '.kimi-code', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `${description}.`].join(
      '\n',
    ),
  );
}
