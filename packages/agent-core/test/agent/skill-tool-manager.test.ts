import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it, vi } from 'vitest';

import { Agent, type AgentRecord } from '../../src/agent';
import { testKaos } from '../fixtures/test-kaos';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import type { AgentRecordPersistence } from '../../src/agent/records';
import { ProviderManager } from '../../src/providers/provider-manager';
import type { ApprovalResponse, SDKAgentRPC, SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SkillRegistry, type SkillDefinition } from '../../src/skill';
import { SkillTool } from '../../src/tools/builtin/collaboration/skill-tool';
import { executeTool } from '../tools/fixtures/execute-tool';


const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

function makeSkill(name: string, metadata: SkillDefinition['metadata'] = {}): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    content: `body of ${name}`,
    metadata,
    source: 'user',
  };
}

function makeAgent(
  skills?: SkillRegistry,
  persistence?: AgentRecordPersistence,
): Agent {
  const rpc = {
    emitEvent: vi.fn(),
    requestApproval: vi.fn(),
    requestQuestion: vi.fn(),
    toolCall: vi.fn(),
  } as unknown as SDKAgentRPC;
  const agent = new Agent({
    runtime: {
      kaos: testKaos,
    },
    rpc,
    skills,
    persistence,
    providerManager: testProviderManager(),
  });
  agent.config.update({
    cwd: process.cwd(),
    modelAlias: MOCK_PROVIDER.model,
  });
  agent.tools.initializeBuiltinTools();
  agent.tools.setActiveTools(['Skill']);
  return agent;
}

function runtime(cwd?: string) {
  return {
    kaos: cwd === undefined ? testKaos : testKaos.withCwd(cwd),
  };
}

function sessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(),
    requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '' })),
  } as unknown as SDKSessionRPC;
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

describe('ToolManager SkillTool registration', () => {
  it('does not expose Skill when the agent has no skill registry', () => {
    const agent = makeAgent();

    expect(agent.tools.data().find((tool) => tool.name === 'Skill')).toBeUndefined();
    expect(agent.tools.loopTools.find((tool) => tool.name === 'Skill')).toBeUndefined();
  });

  it('does not expose Skill when there are no model-invocable skills', () => {
    const skills = new SkillRegistry();
    skills.register(makeSkill('private', { disableModelInvocation: true }));

    const agent = makeAgent(skills);

    expect(agent.tools.data().find((tool) => tool.name === 'Skill')).toBeUndefined();
    expect(agent.tools.loopTools.find((tool) => tool.name === 'Skill')).toBeUndefined();
  });

  it('exposes Skill when at least one inline skill is model-invocable', () => {
    const skills = new SkillRegistry();
    skills.register(makeSkill('review'));
    skills.register(makeSkill('flow-only', { type: 'flow' }));

    const agent = makeAgent(skills);
    const skillInfo = agent.tools.data().find((tool) => tool.name === 'Skill');
    const skillTool = agent.tools.loopTools.find((tool) => tool.name === 'Skill');

    expect(skillInfo).toMatchObject({ name: 'Skill', active: true, source: 'builtin' });
    expect(skillTool).toBeInstanceOf(SkillTool);
  });

  it('persists model-invoked inline skill reminders through agent wire', async () => {
    const skills = new SkillRegistry();
    skills.register(makeSkill('review'));
    const wireRecords: AgentRecord[] = [];
    const persistence = new InMemoryAgentRecordPersistence([], {
      onRecord: (record) => wireRecords.push(record),
    });
    const agent = makeAgent(skills, persistence);
    const skillTool = agent.tools.loopTools.find((tool) => tool.name === 'Skill');
    if (!(skillTool instanceof SkillTool)) {
      throw new Error('Expected SkillTool to be active');
    }

    const result = await executeTool(skillTool, {
      turnId: '0',
      toolCallId: 'call_skill',
      args: { skill: 'review' },
      signal: new AbortController().signal,
    });

    expect(result.output).toContain('loaded inline');
    expect(wireRecords.find((record) => record.type === 'context.append_message')).toMatchObject({
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\n<kimi-skill-loaded name="review" args="">\nbody of review\n</kimi-skill-loaded>\n</system-reminder>',
          },
        ],
        origin: {
          kind: 'skill_activation',
          skillName: 'review',
          trigger: 'model-tool',
        },
      },
    });
    expect(agent.context.history.at(-1)).toMatchObject({
      role: 'user',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
      },
    });
  });

  it('exposes session skills after the main agent is created', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-core-skill-tool-refresh-'));
    try {
      const homeDir = join(tmp, 'home');
      const workDir = join(tmp, 'work');
      const skillDir = join(workDir, '.kimi-code', 'skills', 'review');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: review', 'description: Review code', '---', '', 'Review body.'].join('\n'),
      );

      const session = new Session({
        id: 'test-skill-tool',
        runtime: runtime(workDir),
        homedir: homeDir,
        rpc: sessionRpc(),
        providerManager: testProviderManager(),
      });
      const mainAgent = await session.createMain();
      mainAgent.config.update({
        modelAlias: MOCK_PROVIDER.model,
      });
      mainAgent.tools.initializeBuiltinTools();
      mainAgent.tools.setActiveTools(['Skill']);

      expect(mainAgent.tools.loopTools.find((tool) => tool.name === 'Skill')).toBeInstanceOf(
        SkillTool,
      );
      await session.flushMetadata();
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });
});
