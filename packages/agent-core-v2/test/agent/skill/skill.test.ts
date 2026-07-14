import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentSkillService } from '#/agent/skill/skill';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AgentSkillService } from '#/agent/skill/skillService';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillTool,
  SkillToolInputSchema,
} from '#/agent/skill/tools/skill';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { Turn } from '#/agent/loop/loop';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { stubSkill } from '../../app/skillCatalog/stubs';

const COMMIT_SKILL = stubSkill('commit', {
  description: 'commit changes',
  path: '/skills/commit/SKILL.md',
  dir: '/skills/commit',
  content: '# Commit',
  metadata: {},
  source: 'user',
});

function stubSessionContext(sessionId = 'test-session'): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId,
    workspaceId: 'test-workspace',
    sessionDir: '/sessions/test',
    metaScope: 'sessions/test',
    cwd: '/sessions/test',
    scope: (subKey?: string) => (subKey ? `sessions/test/${subKey}` : 'sessions/test'),
  };
}

function fakeTurn(): Turn {
  return {
    id: 1,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
    cancel: () => true,
  };
}

describe('AgentSkillService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let prompted: ContextMessage[];
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    disposables = new DisposableStore();
    prompted = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentPromptService, {
          enqueue: ({ message }: { message: ContextMessage }) => { prompted.push(message); return Promise.resolve({ launched: Promise.resolve(fakeTurn()) } as never); },
          retry: () => Promise.resolve(undefined),
          undo: () => 0,
          clear: () => {},
        });
        reg.defineInstance(
          IAgentWireService,
          new WireService({ logScope: 'wire', logKey: 'skill-test' }),
        );
        reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(ISessionContext, stubSessionContext());
      },
    });
    skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
    };
    ix.set(ISessionSkillCatalog, skillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));
  });
  afterEach(() => disposables.dispose());

  it('activate prompts with the rendered skill for a known skill', async () => {
    const svc = ix.get(IAgentSkillService);
    const turn = await svc.activate({ name: 'commit' });

    expect(turn).toBeDefined();
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.role).toBe('user');
    expect(prompted[0]!.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });

  it('activate throws for an unknown skill', async () => {
    const svc = ix.get(IAgentSkillService);
    await expect(svc.activate({ name: 'missing' })).rejects.toThrow(/not found/i);
  });

  it('activate waits for the catalog to be ready before resolving', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    ix.set(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: skills,
      ready,
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
    } satisfies ISessionSkillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));

    const svc = ix.get(IAgentSkillService);
    let finished = false;
    const activation = svc.activate({ name: 'commit' }).then(() => {
      finished = true;
    });

    await Promise.resolve();
    expect(finished).toBe(false);

    resolveReady();
    await activation;

    expect(finished).toBe(true);
    expect(prompted).toHaveLength(1);
  });
});

describe('SkillTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let prompted: ContextMessage[];
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    disposables = new DisposableStore();
    prompted = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentPromptService, {
          enqueue: ({ message }: { message: ContextMessage }) => { prompted.push(message); return Promise.resolve({ launched: Promise.resolve(fakeTurn()) } as never); },
          retry: () => Promise.resolve(undefined),
          undo: () => 0,
          clear: () => {},
        });
        reg.defineInstance(
          IAgentWireService,
          new WireService({ logScope: 'wire', logKey: 'skill-test' }),
        );
        reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(ISessionContext, stubSessionContext());
      },
    });
    skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    ix.set(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
    } satisfies ISessionSkillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));
  });
  afterEach(() => disposables.dispose());

  function toolContext(args: { readonly skill: string; readonly args?: string }) {
    return {
      turnId: 0,
      toolCallId: 'call_skill',
      args,
      signal: new AbortController().signal,
    };
  }

  function stubSkillService(): IAgentSkillService {
    return {
      _serviceBrand: undefined,
      activate: () => Promise.reject(new Error('not implemented')),
      recordModelToolActivation: () => {},
    };
  }

  function makeTool(ix: TestInstantiationService, depth?: number): SkillTool {
    const tool = new SkillTool(
      ix.get(ISessionSkillCatalog),
      stubSkillService(),
      stubSessionContext(),
    );
    return depth === undefined ? tool : tool.withInitialQueryDepth(depth);
  }

  it('exposes metadata and schema for model-invoked skills', () => {
    const tool = makeTool(ix);

    expect(tool.name).toBe('Skill');
    expect(tool.description).toContain('Invoke a registered skill');
    expect(tool.description).toContain('kimi-skill-loaded');
    expect(tool.description).toContain('with the same `args`');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['skill'],
      additionalProperties: false,
      properties: {
        skill: expect.objectContaining({
          type: 'string',
          description: expect.stringMatching(/skill listing/i),
        }),
        args: expect.objectContaining({
          type: 'string',
          description: expect.stringMatching(/argument/i),
        }),
      },
    });
    expect(SkillToolInputSchema.safeParse({ skill: 'commit' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({ skill: 'commit', args: '-m fix' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({}).success).toBe(false);
  });

  it('returns a tool error when the skill is unknown', async () => {
    const result = await executeTool(
      makeTool(ix),
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
      makeTool(ix),
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
      makeTool(ix),
      toolContext({ skill: 'flow-only' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "flow-only" is not an inline skill and cannot be invoked by the model in v1.',
    });
  });

  it('loads inline skills through the model-tool wrapper without exposing the body in output', async () => {
    const result = await executeTool(
      makeTool(ix),
      toolContext({ skill: 'commit', args: 'src/app.ts' }),
    );

    expect(result).toMatchObject({
      output: 'Skill "commit" loaded inline. Follow its instructions.',
    });
    expect(result.output).not.toContain('# Commit');
    expect(prompted).toHaveLength(0);
    expect(result.delivery?.kind).toBe('steer');
    expect(result.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
      trigger: 'model-tool',
    });
    expect(result.delivery?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '<kimi-skill-loaded name="commit" trigger="model-tool" source="user" dir="/skills/commit" args="src/app.ts">',
      ),
    });
    expect(result.delivery?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('ARGUMENTS: src/app.ts'),
    });
  });

  it('honors initialQueryDepth as an alias for queryDepth', async () => {
    const nested = await executeTool(
      makeTool(ix, 2),
      toolContext({ skill: 'commit' }),
    );
    const root = await executeTool(
      makeTool(ix, 0),
      toolContext({ skill: 'commit' }),
    );

    expect(prompted).toHaveLength(0);
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
        makeTool(ix, MAX_SKILL_QUERY_DEPTH),
        toolContext({ skill: 'commit' }),
      ),
    ).rejects.toBeInstanceOf(NestedSkillTooDeepError);
    expect(prompted).toHaveLength(0);
  });
});
