import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlledPromise } from '@antfu/utils';
import { basename } from 'pathe';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import { summarizeSkill } from '#/features/skill/catalog/types';
import { IAgentSkillService } from '#/features/skill/skillService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '#/tool/toolContract';
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
  createMockProvider,
  InMemoryWireRecordPersistence,
  skillServices,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

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

    const activation = ctx.context.history().find((m) => m.origin?.kind === 'skill_activation');
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
    expect(ctx.context.history().some((m) => m.origin?.kind === 'skill_activation')).toBe(true);
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

  it('renders arguments and session context through the model-tool path', async () => {
    skills.register(
      stubSkill('rename-session', {
        content: 'Run "$ARGUMENTS" with "${KIMI_SESSION_ID}"',
      }),
    );

    const result = await executeTool(
      makeTool(),
      toolContext({ skill: 'rename-session', args: 'Tokenizer Myths' }),
    );
    await ctx.restorePersisted();
    ctx.get(IAgentLoopService).flushReminders();
    const text = ctx.context.history().flatMap((message) => message.content).map((part) => part.type === 'text' ? part.text : '').join('\n');
    const sessionId = ctx.get(ISessionContext).sessionId;

    expect(text).toContain('Tokenizer Myths');
    expect(text).toContain(sessionId);
    expect(text).not.toContain('${KIMI_SESSION_ID}');
    expect(text).toContain('dir="/skills/rename-session"');
    expect(text).not.toContain('Tool output exceeded');
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

  it('loads inline skills through the model-tool wrapper and truncates oversized content', async () => {
    const bulk = `${'x'.repeat(99)}\n`.repeat(Math.ceil(DEFAULT_TOOL_RESULT_MAX_CHARS / 100) + 1);
    const skillContent = `HEAD_MARKER\n${bulk}TAIL_MARKER`;
    const renderedSkillContent = `${skillContent}\n\nARGUMENTS: src/app.ts`;
    skills.register(stubSkill('oversized', { content: skillContent }));

    const result = await executeTool(
      makeTool(),
      toolContext({ skill: 'oversized', args: 'src/app.ts' }),
    );

    expect(result).toMatchObject({
      output: 'Skill "oversized" loaded inline. Follow its instructions.',
    });
    expect(result.output).not.toContain('HEAD_MARKER');
    expect(ctx.context.history()).toHaveLength(0);

    await ctx.restorePersisted();
    ctx.get(IAgentLoopService).flushReminders();
    const [reminder] = ctx.context.history();
    expect(reminder?.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'oversized',
      trigger: 'model-tool',
    });
    const reminderPart = reminder?.content[0];
    expect(reminderPart).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '<skill-loaded name="oversized" trigger="model-tool" source="user" dir="/skills/oversized" args="src/app.ts">',
      ),
    });
    const reminderText = reminderPart?.type === 'text' ? reminderPart.text : '';
    expect(reminderText).toContain('Tool output exceeded 50000 characters');
    expect(reminderText).toContain('tool_call_id: call_skill');
    expect(reminderText).toContain('HEAD_MARKER');
    expect(reminderText).toContain('TAIL_MARKER');
    expect(reminderText).toContain('ARGUMENTS: src/app.ts');
    expect(reminderText.length).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_CHARS);

    const outputPath = /^output_path: (.+)$/m.exec(reminderText)?.[1];
    expect(outputPath).toBeDefined();
    if (outputPath === undefined) throw new Error('expected a spill output path');
    const storage = ctx.get(IFileSystemStorageService);
    const scope = ctx.get(IAgentScopeContext).scope('tool-results');
    const saved = await storage.read(scope, basename(outputPath));
    expect(saved).toBeDefined();
    if (saved === undefined) throw new Error('expected saved skill content');
    expect(new TextDecoder().decode(saved)).toBe(renderedSkillContent);
  });

  it('honors initialQueryDepth as an alias for queryDepth', async () => {
    await executeTool(
      makeTool(2),
      toolContext({ skill: 'commit' }),
    );
    await executeTool(
      makeTool(0),
      toolContext({ skill: 'commit' }),
    );

    expect(ctx.context.history()).toHaveLength(0);
    await ctx.restorePersisted();
    ctx.get(IAgentLoopService).flushReminders();
    const reminders = ctx.context.history();
    expect(reminders).toHaveLength(2);
    expect(reminders[0]?.origin).toMatchObject({
      kind: 'skill_activation',
      trigger: 'nested-skill',
    });
    expect(reminders[1]?.origin).toMatchObject({
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
    expect(ctx.context.history()).toHaveLength(0);
  });
});

describe('AgentSkillService busy delivery (harness)', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('launches a busy activation in the next turn and an idle activation immediately', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(
      stubSkill('tower', {
        content: 'Tower mission: $ARGUMENTS',
        metadata: {},
      }),
    );

    const gate = createControlledPromise<void>();
    let generateCalls = 0;
    const generate = createMockProvider(async () => {
      generateCalls += 1;
      const n = generateCalls;
      if (n === 1) await gate;
      const text = `response-${String(n)}`;
      return {
        id: `mock-${String(n)}`,
        message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    });

    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(skillServices(catalog), { generate, persistence });

    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await vi.waitFor(() => {
      expect(generateCalls).toBe(1);
    });

    const busyPromise = ctx.get(IAgentSkillService).activate({ name: 'tower', args: 'mission-1' });
    gate.resolve();
    const busyResult = await busyPromise;
    expect(busyResult.turn_id).toBe(1);

    await promptPromise;
    await ctx.get(IAgentLoopService).settled();

    const idleResult = await ctx.get(IAgentSkillService).activate({ name: 'tower', args: 'mission-2' });
    expect(idleResult.turn_id).toBe(2);
    await ctx.get(IAgentLoopService).settled();
    expect(generateCalls).toBe(3);

    const activations = ctx
      .contextData()
      .history.filter((m) => m.role === 'user' && m.origin?.kind === 'skill_activation');
    expect(activations.map((m) => (m.origin?.kind === 'skill_activation' ? m.origin.skillArgs : ''))).toEqual([
      'mission-1',
      'mission-2',
    ]);

    const types = persistence.records.map((record) => record.type);
    expect(types.filter((type) => type === 'turn.prompt')).toHaveLength(3);
    expect(types.filter((type) => type === 'turn.steer')).toHaveLength(0);
    const busyPrompt = persistence.records.find((record) => record.type === 'turn.prompt' && record['turnId'] === 1);
    expect(busyPrompt).toMatchObject({ turnId: 1, origin: { kind: 'skill_activation', skillArgs: 'mission-1' } });
  });

  it('resets nesting depth for each user activation in the same running turn', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(stubSkill('tower'));
    const gate = createControlledPromise<void>();
    let generateCalls = 0;
    const generate = createMockProvider(async () => {
      generateCalls += 1;
      await gate;
      return {
        id: 'mock-depth-reset',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
        usage: null,
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    });
    ctx = createTestAgent(skillServices(catalog), { generate });
    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await vi.waitFor(() => { expect(generateCalls).toBe(1); });
    const service = ctx.get(IAgentSkillService);

    const one = service.activate({ name: 'tower', args: 'one' });
    const two = service.activate({ name: 'tower', args: 'two' });
    const three = service.activate({ name: 'tower', args: 'three' });

    gate.resolve();
    await Promise.all([one, two, three]);
    await promptPromise;
    expect(service.modelToolContext()).toEqual({ queryDepth: 1, workspaceDir: undefined });
    await ctx.untilTurnEnd();
  });
});
