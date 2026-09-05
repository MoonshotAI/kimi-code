import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlledPromise } from '@antfu/utils';

import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import { summarizeSkill } from '#/features/skill/catalog/types';
import { IAgentSkillService } from '#/features/skill/skillService';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import {
  ISkillTool,
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillToolInputSchema,
} from '#/features/skill/tools/skill';
import { SkillTool } from '#/features/skill/tools/skillTool';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { stubSkill } from './catalog/stubs';
import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  skillServices,
  type TestAgentContext,
} from '../../harness';

type GenerateFn = typeof kosongGenerate;

const COMMIT_SKILL = stubSkill('commit', {
  description: 'commit changes',
  path: '/skills/commit/SKILL.md',
  dir: '/skills/commit',
  content: '# Commit',
  metadata: {},
  source: 'user',
});

function catalogWithCommit(): InMemorySkillCatalog {
  const skills = new InMemorySkillCatalog();
  skills.register(COMMIT_SKILL);
  return skills;
}

describe('AgentSkillService', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('activate prompts with the rendered skill for a known skill', async () => {
    ctx = createTestAgent(skillServices(catalogWithCommit()));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const launched = await ctx.get(IAgentSkillService).activate({ name: 'commit' });
    expect(launched.turn_id).toBe(0);
    await ctx.untilTurnEnd();

    const activation = ctx.context.get().find((m) => m.origin?.kind === 'skill_activation');
    expect(activation?.role).toBe('user');
    expect(activation?.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });

  it('activate throws for an unknown skill', async () => {
    ctx = createTestAgent(skillServices(catalogWithCommit()));

    await expect(ctx.get(IAgentSkillService).activate({ name: 'missing' })).rejects.toThrow(
      /not found/i,
    );
  });

  it('activate waits for the catalog to be ready before resolving', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const skills = catalogWithCommit();
    ctx = createTestAgent(
      skillServices({
        _serviceBrand: undefined,
        catalog: skills,
        ready,
        onDidChange: () => ({ dispose: () => {} }),
        load: async () => {},
        reload: async () => {},
        list: async () => skills.listSkills().map(summarizeSkill),
      }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    let finished = false;
    const activation = ctx
      .get(IAgentSkillService)
      .activate({ name: 'commit' })
      .then(() => {
        finished = true;
      });

    await Promise.resolve();
    expect(finished).toBe(false);

    resolveReady();
    await activation;

    expect(finished).toBe(true);
    await ctx.untilTurnEnd();
    expect(ctx.context.get().some((m) => m.origin?.kind === 'skill_activation')).toBe(true);
  });
});

describe('SkillTool', () => {
  let ctx: TestAgentContext;
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    skills = catalogWithCommit();
    ctx = createTestAgent(skillServices(skills));
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  function toolContext(args: { readonly skill: string; readonly args?: string }) {
    return {
      turnId: 0,
      toolCallId: 'call_skill',
      args,
      signal: new AbortController().signal,
    };
  }

  function makeTool(depth?: number): SkillTool {
    const tool = ctx.get(ISkillTool) as SkillTool;
    return depth === undefined ? tool : tool.withInitialQueryDepth(depth);
  }

  it('exposes metadata and schema for model-invoked skills', () => {
    const tool = makeTool();

    expect(tool.name).toBe('Skill');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['skill'],
      additionalProperties: false,
      properties: {
        skill: { type: 'string' },
        args: { type: 'string' },
      },
    });
    expect(SkillToolInputSchema.safeParse({ skill: 'commit' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({ skill: 'commit', args: '-m fix' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({}).success).toBe(false);
  });

  it('returns a tool error when the skill is unknown', async () => {
    const result = await executeTool(
      makeTool(),
      toolContext({ skill: 'missing' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "missing" not found in the current skill listing.',
    });
  });

  it('rejects skills that disable model invocation', async () => {
    skills.register(stubSkill('private', { metadata: { disableModelInvocation: true } }));

    const result = await executeTool(
      makeTool(),
      toolContext({ skill: 'private' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "private" can only be triggered by the user (model invocation is disabled).',
    });
  });

  it('rejects non-inline skill types in the current v1 runtime', async () => {
    skills.register(stubSkill('flow-only', { metadata: { type: 'flow' } }));

    const result = await executeTool(
      makeTool(),
      toolContext({ skill: 'flow-only' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "flow-only" is not an inline skill and cannot be invoked by the model in v1.',
    });
  });

  it('loads inline skills through the model-tool wrapper without exposing the body in output', async () => {
    const result = await executeTool(
      makeTool(),
      toolContext({ skill: 'commit', args: 'src/app.ts' }),
    );

    expect(result).toMatchObject({
      output: 'Skill "commit" loaded inline. Follow its instructions.',
    });
    expect(result.output).not.toContain('# Commit');
    expect(ctx.context.get()).toHaveLength(0);
    expect(result.delivery?.kind).toBe('steer');
    expect(result.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
      trigger: 'model-tool',
    });
    expect(result.delivery?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '<skill-loaded name="commit" trigger="model-tool" source="user" dir="/skills/commit" args="src/app.ts">',
      ),
    });
    expect(result.delivery?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('ARGUMENTS: src/app.ts'),
    });
  });

  it('honors initialQueryDepth as an alias for queryDepth', async () => {
    const nested = await executeTool(
      makeTool(2),
      toolContext({ skill: 'commit' }),
    );
    const root = await executeTool(
      makeTool(0),
      toolContext({ skill: 'commit' }),
    );

    expect(ctx.context.get()).toHaveLength(0);
    expect(nested.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      trigger: 'nested-skill',
    });
    expect(root.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      trigger: 'model-tool',
    });
  });

  it('throws a structured recursion error when nested skill invocation is too deep', async () => {
    await expect(
      executeTool(
        makeTool(MAX_SKILL_QUERY_DEPTH),
        toolContext({ skill: 'commit' }),
      ),
    ).rejects.toBeInstanceOf(NestedSkillTooDeepError);
    expect(ctx.context.get()).toHaveLength(0);
  });
});

describe('AgentSkillService busy delivery (harness)', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('steers the activation into the running turn and launches a new one when idle', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(
      stubSkill('tower', {
        content: 'Tower mission: $ARGUMENTS',
        metadata: {},
      }),
    );

    const gate = createControlledPromise<void>();
    let generateCalls = 0;
    const generate: GenerateFn = async (_chat, _systemPrompt, _tools, _history, callbacks, options) => {
      generateCalls += 1;
      const n = generateCalls;
      options?.onRequestStart?.();
      if (n === 1) await gate;
      options?.signal?.throwIfAborted();
      const text = `response-${String(n)}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      options?.onStreamEnd?.();
      return {
        id: `mock-${String(n)}`,
        message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
        traceId: null,
      };
    };

    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(skillServices(catalog), { generate, persistence });

    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await vi.waitFor(() => {
      expect(generateCalls).toBe(1);
    });

    const busyResult = await ctx.get(IAgentSkillService).activate({ name: 'tower', args: 'mission-1' });
    expect(busyResult.turn_id).toBe(0);
    expect(generateCalls).toBe(1);

    gate.resolve();
    await promptPromise;
    await ctx.untilTurnEnd();

    const idleResult = await ctx.get(IAgentSkillService).activate({ name: 'tower', args: 'mission-2' });
    expect(idleResult.turn_id).toBe(1);
    await ctx.untilTurnEnd();
    expect(generateCalls).toBe(3);

    const activations = ctx
      .contextData()
      .history.filter((m) => m.role === 'user' && m.origin?.kind === 'skill_activation');
    expect(activations.map((m) => (m.origin?.kind === 'skill_activation' ? m.origin.skillArgs : ''))).toEqual([
      'mission-1',
      'mission-2',
    ]);

    const types = persistence.records.map((record) => record.type);
    expect(types.filter((type) => type === 'turn.prompt')).toHaveLength(2);
    expect(types.filter((type) => type === 'turn.steer')).toHaveLength(1);
    const steer = persistence.records.find((record) => record.type === 'turn.steer');
    expect(steer).toMatchObject({ origin: { kind: 'skill_activation', skillArgs: 'mission-1' } });
  });
});
