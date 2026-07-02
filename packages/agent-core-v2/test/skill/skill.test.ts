import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentSkillService } from '#/agent/skill';
import { InMemorySkillCatalog } from '#/app/globalSkillCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
import { AgentSkillService } from '#/agent/skill/skillService';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillTool,
} from '#/agent/skill/tools/skill';
import { ModelSkillTool } from '#/agent/skill/tools/modelSkill';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { Turn } from '#/agent/turn';
import { IAgentWireRecordService } from '#/agent/wireRecord';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { AgentRecordService, IAgentRecordService } from '#/agent/record';
import { stubWireRecord } from '../contextMemory/stubs';
import { executeTool } from '../tools/fixtures/execute-tool';
import { stubSkill } from './stubs';

const COMMIT_SKILL = stubSkill('commit', {
  description: 'commit changes',
  path: '/skills/commit/SKILL.md',
  dir: '/skills/commit',
  content: '# Commit',
  metadata: {},
  source: 'user',
});

function fakeTurn(): Turn {
  return {
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
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
          prompt: (message) => {
            prompted.push(message);
            return fakeTurn();
          },
          steer: (message) => {
            prompted.push(message);
            return undefined;
          },
          retry: () => undefined,
          undo: () => 0,
          clear: () => {},
        });
        reg.definePartialInstance(IAgentEventSinkService, {
          emit: () => {},
          on: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(IAgentWireRecordService, stubWireRecord());
        reg.definePartialInstance(IAgentReplayBuilderService, {
          push: () => {},
          buildResult: () => [],
          captureLiveRecords: false,
          postRestoring: false,
        });
        reg.define(IAgentRecordService, AgentRecordService);
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
      },
    });
    skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
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
          prompt: (message: ContextMessage) => {
            prompted.push(message);
            return fakeTurn();
          },
          steer: (message: ContextMessage) => {
            prompted.push(message);
            return undefined;
          },
          retry: () => undefined,
          undo: () => 0,
          clear: () => {},
        });
        reg.definePartialInstance(IAgentEventSinkService, {
          emit: () => {},
          on: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(IAgentWireRecordService, stubWireRecord());
        reg.definePartialInstance(IAgentReplayBuilderService, {
          push: () => {},
          buildResult: () => [],
          captureLiveRecords: false,
          postRestoring: false,
        });
        reg.define(IAgentRecordService, AgentRecordService);
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
      },
    });
    skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    ix.set(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
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

  it('exposes metadata and schema for model-invoked skills', () => {
    const tool = new SkillTool(ix.get(IAgentSkillService));

    expect(tool.name).toBe('Skill');
    expect(tool.description).toContain('Invoke a registered skill');
    expect(tool.description).toContain(String(MAX_SKILL_QUERY_DEPTH));
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['skill'],
      additionalProperties: false,
      properties: {
        skill: expect.objectContaining({ type: 'string' }),
        args: expect.objectContaining({ type: 'string' }),
      },
    });
  });

  it('returns a tool error when the skill is unknown', async () => {
    const result = await executeTool(
      new SkillTool(ix.get(IAgentSkillService)),
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
      new SkillTool(ix.get(IAgentSkillService)),
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
      new SkillTool(ix.get(IAgentSkillService)),
      toolContext({ skill: 'flow-only' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "flow-only" is not an inline skill and cannot be invoked by the model in v1.',
    });
  });

  it('loads inline skills through the model-tool wrapper without exposing the body in output', async () => {
    const result = await executeTool(
      new SkillTool(ix.get(IAgentSkillService)),
      toolContext({ skill: 'commit', args: 'src/app.ts' }),
    );

    expect(result).toMatchObject({
      output: 'Skill "commit" loaded inline. Follow its instructions.',
    });
    expect(result.output).not.toContain('# Commit');
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
      trigger: 'model-tool',
    });
    expect(prompted[0]!.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '<kimi-skill-loaded name="commit" trigger="model-tool" source="user" dir="/skills/commit" args="src/app.ts">',
      ),
    });
    expect(prompted[0]!.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('ARGUMENTS: src/app.ts'),
    });
  });

  it('honors initialQueryDepth as an alias for queryDepth', async () => {
    const calls: Array<{ readonly name: string; readonly queryDepth?: number }> = [];
    const service: IAgentSkillService = {
      _serviceBrand: undefined,
      activate: async () => fakeTurn(),
      activateFromModel: async (input) => {
        calls.push({ name: input.name, queryDepth: input.queryDepth });
        return { output: 'loaded' };
      },
    };

    await executeTool(
      new SkillTool(service, { initialQueryDepth: 2 }),
      toolContext({ skill: 'commit' }),
    );
    await executeTool(
      new ModelSkillTool(service, { initialQueryDepth: 1 }),
      toolContext({ skill: 'commit' }),
    );

    expect(calls).toEqual([
      { name: 'commit', queryDepth: 2 },
      { name: 'commit', queryDepth: 1 },
    ]);
  });

  it('throws a structured recursion error when nested skill invocation is too deep', async () => {
    const service: IAgentSkillService = {
      _serviceBrand: undefined,
      activate: async () => fakeTurn(),
      activateFromModel: async () => ({ output: 'should not run' }),
    };

    await expect(
      executeTool(
        new SkillTool(service, { initialQueryDepth: MAX_SKILL_QUERY_DEPTH }),
        toolContext({ skill: 'commit' }),
      ),
    ).rejects.toBeInstanceOf(NestedSkillTooDeepError);
  });
});
