import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { testKaos } from '../fixtures/test-kaos';
import type { ProviderConfig, ToolCall } from '@moonshot-ai/kosong';
import type { Kaos, StatResult } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentOptions } from '../../src/agent';
import { trimTrailingOpenToolExchange } from '../../src/agent/context/projector';
import type { KimiConfig } from '../../src/config';
import { FlagResolver } from '../../src/flags';
import { McpOAuthCoordinator } from '../../src/mcp';
import { ProviderManager } from '../../src/session/provider-manager';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { estimateTokensForMessages } from '../../src/utils/tokens';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';
import { executeTool } from '../tools/fixtures/execute-tool';
import { createFakeKaos, toolContentString } from '../tools/fixtures/fake-kaos';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;


const here = import.meta.dirname;
const mcpStdioFixture = join(here, '..', 'mcp', 'fixtures', 'mock-stdio-server.mjs');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Session.init', () => {
  it('subscribes to MCP credential changes before app-level registration', async () => {
    const coordinator = new McpOAuthCoordinator();
    const session = new Session({
      id: 'test-mcp-credentials-during-init',
      kaos: testKaos.withCwd(await makeTempDir()),
      homedir: await makeTempDir(),
      rpc: createSessionRpc([]),
      providerManager: testProviderManager(),
      mcpOAuthCoordinator: coordinator,
    });
    const reconnect = vi
      .spyOn(session, 'reconnectMcpAfterCredentialsChanged')
      .mockResolvedValue();

    coordinator.notifyCredentialsChanged('remote', 'https://mcp.example.test/service');
    expect(reconnect).toHaveBeenCalledOnce();

    await session.close();
    coordinator.notifyCredentialsChanged('remote', 'https://mcp.example.test/service');
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('runs an isolated system-trigger turn and records the latest AGENTS as a system reminder', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    await mkdir(join(workDir, '.git'));
    await writeFile(join(workDir, 'AGENTS.md'), 'latest project instructions', 'utf-8');

    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const session = new Session({
      id: 'test-init',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      { profile: testProfile() },
    );
    mainAgent.config.update({
      modelAlias: 'mock-model',
      thinkingEffort: 'off',
    });
    mainAgent.tools.setActiveTools([]);
    events.length = 0;
    scripted.mockNextResponse({
      type: 'text',
      text: 'Explored the project structure, identified the build and test commands, mapped the module layout, and wrote a comprehensive summary into AGENTS.md covering architecture, conventions, and the developer workflow for future agents.',
    });

    await session.generateAgentsMd();

    expect(session.agents.size).toBe(2);
    expect(session.agents.get('main')).toBe(mainAgent);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        agentId: 'main',
        subagentId: 'agent-0',
        subagentName: 'coder',
        parentToolCallId: 'generate-agents-md',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.started',
        agentId: 'agent-0',
        origin: { kind: 'system_trigger', name: 'subagent' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.completed',
        agentId: 'main',
        subagentId: 'agent-0',
        contextTokens: expect.any(Number),
      }),
    );
    expect(scripted.calls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [
          expect.objectContaining({
            text: expect.stringContaining('Task requirements:'),
          }),
        ],
      },
    ]);

    const contextText = mainAgent.context.history
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(contextText).toContain('<system-reminder>');
    expect(contextText).toContain('Latest AGENTS.md file content:');
    expect(contextText).toContain('latest project instructions');
    expect(contextText).not.toContain('Task requirements:');
  });

  it('loads AGENTS.md via the persistence kaos when the tool kaos rejects readText (Zed ACP "Internal error" regression)', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    await mkdir(join(workDir, '.git'));
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions from disk', 'utf-8');

    // Simulate Zed's `fs/readTextFile` returning a generic -32603 Internal
    // error: every `readText` through the tool kaos rejects. The persistence
    // kaos is a real LocalKaos that can reach AGENTS.md on disk.
    const toolKaos = wrapReadTextWithError(
      testKaos.withCwd(workDir),
      new Error('acp: readTextFile failed: Internal error'),
    );

    const capturedContext: { agentsMd: string | undefined } = { agentsMd: undefined };
    const events: Array<Record<string, unknown>> = [];
    const session = new Session({
      id: 'test-bootstrap-acp-fallback',
      kaos: toolKaos,
      persistenceKaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    try {
      const { agent } = await session.createAgent(
        { type: 'main' },
        {
          profile: {
            name: 'capture',
            systemPrompt: (ctx) => {
              capturedContext.agentsMd = ctx.agentsMd;
              return '<system-prompt>';
            },
            tools: [],
          },
        },
      );

      expect(agent.config.systemPrompt).toBe('<system-prompt>');
      expect(capturedContext.agentsMd).toContain('project instructions from disk');
    } finally {
      await session.close();
    }
  });

  it('refreshes AGENTS.md from a resumed native session system prompt', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    await mkdir(join(workDir, '.git'));
    await writeFile(join(workDir, 'AGENTS.md'), 'initial resume instructions', 'utf-8');

    const firstSession = new Session({
      id: 'test-resume-system-prompt-refresh',
      kaos: testKaos.withCwd(workDir),
      persistenceKaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    try {
      const agent = await firstSession.createMain();
      expect(agent.config.systemPrompt).toContain('initial resume instructions');
    } finally {
      await firstSession.closeForReload();
    }

    await writeFile(join(workDir, 'AGENTS.md'), 'updated resume instructions', 'utf-8');

    const resumedSession = new Session({
      id: 'test-resume-system-prompt-refresh',
      kaos: testKaos.withCwd(workDir),
      persistenceKaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    try {
      await resumedSession.resume();
      const resumedAgent = await resumedSession.ensureAgentResumed('main');
      expect(resumedAgent.config.systemPrompt).toContain('initial resume instructions');

      await resumedAgent.refreshSystemPrompt();

      expect(resumedAgent.config.systemPrompt).toContain('updated resume instructions');
      expect(resumedAgent.config.systemPrompt).not.toContain('initial resume instructions');
    } finally {
      await resumedSession.close();
    }
  });

  it('resumes a v2 session from the standard path instead of persisted homedir', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const options = {
      id: 'test-resume-without-agent-homedir',
      kaos: testKaos.withCwd(workDir),
      persistenceKaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    };
    const firstSession = new Session(options);
    try {
      await firstSession.createMain();
    } finally {
      await firstSession.closeForReload();
    }

    const statePath = join(sessionDir, 'state.json');
    const now = Date.now();
    await writeFile(statePath, JSON.stringify({
      id: options.id,
      version: 2,
      createdAt: now,
      updatedAt: now,
      archived: false,
      cwd: workDir,
      agents: { main: { homedir: '/stale/session/agents/main', type: 'main' } },
      custom: {},
    }), 'utf-8');

    const resumedSession = new Session(options);
    try {
      await resumedSession.resume();
      const main = await resumedSession.ensureAgentResumed('main');

      expect(main.homedir).toBe(join(sessionDir, 'agents', 'main'));
      expect(main.config.systemPrompt).not.toBe('');
    } finally {
      await resumedSession.close();
    }
  });

  it('rebuilds builtin tools when rebinding the session tool kaos', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const staleKaos = createReadToolKaos(workDir, 'stale kaos\n');
    const replacementKaos = createReadToolKaos(workDir, 'replacement kaos\n');
    const session = new Session({
      id: 'test-rebind-tool-kaos',
      kaos: staleKaos,
      persistenceKaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });

    try {
      const { agent } = await session.createAgent({ type: 'main' }, { profile: testProfile() });
      agent.config.update({
        modelAlias: 'mock-model',
        thinkingEffort: 'off',
      });
      agent.tools.initializeBuiltinTools();
      agent.tools.setActiveTools(['Read']);

      session.setToolKaos(replacementKaos);

      const readTool = agent.tools.loopTools.find((candidate) => candidate.name === 'Read');
      expect(readTool).toBeDefined();
      const result = await executeTool(readTool!, {
        args: { path: join(workDir, 'file.txt') },
        turnId: '1',
        toolCallId: 'call_read',
        signal: new AbortController().signal,
      });

      expect(result.isError).not.toBe(true);
      expect(toolContentString(result)).toContain('replacement kaos');
    } finally {
      await session.close();
    }
  });

  it('tracks connected and failed MCP server totals after initial load', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      providerManager: testProviderManager(),
      mcpConfig: {
        servers: {
          connected: {
            transport: 'stdio',
            command: process.execPath,
            args: [mcpStdioFixture],
          },
          failed: {
            transport: 'stdio',
            command: '/this/path/does/not/exist/anywhere',
          },
          disabled: {
            transport: 'stdio',
            command: process.execPath,
            args: [mcpStdioFixture],
            enabled: false,
          },
        },
      },
      telemetry: recordingTelemetry(records),
    });

    try {
      await session.mcp.waitForInitialLoad();
      await expect(new SessionAPIImpl(session).getMcpStartupMetrics({})).resolves.toEqual({
        durationMs: expect.any(Number),
      });

      expect(records).toContainEqual({
        event: 'mcp_connected',
        properties: {
          server_count: 1,
          total_count: 2,
        },
      });
      expect(records).toContainEqual({
        event: 'mcp_failed',
        properties: {
          failed_count: 1,
          total_count: 2,
        },
      });
    } finally {
      await session.close();
    }
  }, 20000);
});

describe('AgentAPI.startBtw', () => {
  it('runs a side subagent from a stable parent context snapshot without writing btw history', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();

    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const session = new Session({
      id: 'test-btw',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      { profile: testProfile() },
    );
    mainAgent.config.update({
      modelAlias: 'mock-model',
      thinkingEffort: 'off',
    });
    mainAgent.tools.setActiveTools(['Read']);
    registerLookupNoteTool(mainAgent);
    mainAgent.context.appendUserMessage([{ type: 'text', text: 'Main task: implement /btw.' }]);
    mainAgent.context.appendLoopEvent({
      type: 'step.begin',
      uuid: 'open-step',
      turnId: 'main-turn',
      step: 1,
    });
    mainAgent.context.appendLoopEvent({
      type: 'tool.call',
      uuid: 'open-call',
      turnId: 'main-turn',
      step: 1,
      stepUuid: 'open-step',
      toolCallId: 'call-open',
      name: 'Read',
      args: { path: 'src/main.ts' },
    });
    events.length = 0;
    const summary = 'Main agent is implementing /btw.';
    scripted.mockNextResponse({ type: 'text', text: summary });

    try {
      const api = new SessionAPIImpl(session);
      const agentId = await api.startBtw({ agentId: 'main' });
      expect(agentId).toBe('agent-0');
      expect(scripted.calls).toHaveLength(0);
      expect(session.metadata.agents[agentId]).toBeUndefined();
      const childAgent = session.getReadyAgent(agentId);
      if (childAgent === undefined) throw new Error('Expected /btw child agent');
      const inheritedHistory = trimTrailingOpenToolExchange(
        mainAgent.context.project(mainAgent.context.history),
      );
      expect(childAgent.context.history.slice(0, inheritedHistory.length)).toEqual(inheritedHistory);
      expect(childAgent.context.tokenCount).toBe(0);
      expect(childAgent.context.tokenCountWithPending).toBeGreaterThanOrEqual(
        estimateTokensForMessages(inheritedHistory),
      );

      await api.prompt({
        agentId,
        input: [{ type: 'text', text: 'What are you working on right now?' }],
      });

      await vi.waitFor(() => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn.ended',
            agentId: 'agent-0',
            reason: 'completed',
          }),
        );
      });
      expect(events.filter((event) => String(event['type']).startsWith('subagent.'))).toEqual([]);
      expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn.started',
            agentId: 'agent-0',
            origin: { kind: 'user' },
          }),
        );
      expect(scripted.calls).toHaveLength(1);
      expect(scripted.calls[0]?.systemPrompt).toBe('<system-prompt>');
      expect(scripted.calls[0]?.tools.map((tool) => tool.name)).toEqual([
        'LookupNote',
        'Read',
      ]);
      const historyText = JSON.stringify(scripted.calls[0]?.history);
      expect(historyText).toContain('Main task: implement /btw.');
      expect(historyText).toContain('This is a side-channel conversation with the user.');
      expect(historyText).toContain('All tool calls are disabled and will be rejected.');
      expect(historyText).toContain('What are you working on right now?');
      expect(historyText).not.toContain('call-open');
      expect(JSON.stringify(mainAgent.context.history)).not.toContain(
        'What are you working on right now?',
      );
      expect(JSON.stringify(session.getReadyAgent('agent-0')?.context.history)).toContain(
        'What are you working on right now?',
      );
      scripted.mockNextResponse({ type: 'text', text: 'Follow-up answer from the same side agent.' });
      await api.prompt({
        agentId,
        input: [{ type: 'text', text: 'Can you say that another way?' }],
      });
      await vi.waitFor(() => {
        expect(scripted.calls).toHaveLength(2);
      });
      const followUpHistoryText = JSON.stringify(scripted.calls[1]?.history);
      expect(followUpHistoryText).toContain('What are you working on right now?');
      expect(followUpHistoryText).toContain('Can you say that another way?');
      await expect(access(join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'))).rejects.toThrow();
    } finally {
      await session.close();
    }
  });

  it('declares parent tools but rejects side-question tool calls before a second text turn', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();

    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const session = new Session({
      id: 'test-btw-deny-tools',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      { profile: testProfile() },
    );
    mainAgent.config.update({
      modelAlias: 'mock-model',
      thinkingEffort: 'off',
    });
    mainAgent.tools.setActiveTools(['Read']);
    registerLookupNoteTool(mainAgent);
    mainAgent.context.appendUserMessage([{ type: 'text', text: 'Main task context.' }]);
    events.length = 0;

    scripted.mockNextResponse(lookupNoteCall());
    scripted.mockNextResponse({
      type: 'text',
      text: 'Main agent is implementing /btw based on the existing context.',
    });

    try {
      const api = new SessionAPIImpl(session);
      const agentId = await api.startBtw({ agentId: 'main' });
      expect(agentId).toBe('agent-0');
      await api.prompt({
        agentId,
        input: [{ type: 'text', text: 'What are you working on right now?' }],
      });

      await vi.waitFor(() => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn.ended',
            agentId: 'agent-0',
            reason: 'completed',
          }),
        );
      });
      expect(events.filter((event) => String(event['type']).startsWith('subagent.'))).toEqual([]);
      expect(scripted.calls).toHaveLength(2);
      expect(scripted.calls[0]?.systemPrompt).toBe('<system-prompt>');
      expect(scripted.calls[1]?.systemPrompt).toBe('<system-prompt>');
      expect(scripted.calls[0]?.tools.map((tool) => tool.name)).toEqual([
        'LookupNote',
        'Read',
      ]);
      expect(scripted.calls[1]?.tools.map((tool) => tool.name)).toEqual([
        'LookupNote',
        'Read',
      ]);
      expect(JSON.stringify(scripted.calls[1]?.history)).toContain(
        'Tool calls are disabled for side questions. Answer with text only.',
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.result',
          agentId: 'agent-0',
          toolCallId: 'call_lookup_note',
          isError: true,
          output: 'Tool calls are disabled for side questions. Answer with text only.',
        }),
      );
      expect(JSON.stringify(mainAgent.context.history)).not.toContain(
        'What are you working on right now?',
      );
    } finally {
      await session.close();
    }
  });

  it('cancels a btw turn through the returned agent id', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();

    const events: Array<Record<string, unknown>> = [];
    const generate: NonNullable<AgentOptions['generate']> = vi.fn(
      async (_chat, _systemPrompt, _tools, _history, _callbacks, options) => {
        const signal = options?.signal;
        if (signal === undefined) {
          throw new Error('Expected generate signal');
        }
        return new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    );
    const session = new Session({
      id: 'test-btw-cancel',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate },
      { profile: testProfile() },
    );
    mainAgent.config.update({
      modelAlias: 'mock-model',
      thinkingEffort: 'off',
    });
    events.length = 0;

    try {
      const api = new SessionAPIImpl(session);
      const agentId = await api.startBtw({ agentId: 'main' });
      expect(agentId).toBe('agent-0');
      await api.prompt({
        agentId,
        input: [{ type: 'text', text: 'Where are things right now?' }],
      });

      await vi.waitFor(() => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn.started',
            agentId: 'agent-0',
            origin: { kind: 'user' },
          }),
        );
      });

      await api.cancel({ agentId });

      await vi.waitFor(() => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn.ended',
            agentId: 'agent-0',
            reason: 'cancelled',
          }),
        );
      });
      expect(events.filter((event) => String(event['type']).startsWith('subagent.'))).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('discovers sub-skills and builtins', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const skillsRoot = join(workDir, 'skills');
    await mkdir(join(skillsRoot, 'outer', 'inner'), { recursive: true });
    await writeFile(
      join(skillsRoot, 'outer', 'SKILL.md'),
      [
        '---',
        'name: outer',
        'description: Parent skill',
        'has-sub-skill: true',
        '---',
        '',
        'Outer body.',
      ].join('\n'),
    );
    await writeFile(
      join(skillsRoot, 'outer', 'inner', 'SKILL.md'),
      ['---', 'name: inner', 'description: Nested skill', '---', '', 'Inner body.'].join('\n'),
    );

    const disabledSession = new Session({
      id: 'test-disabled-sub-skills',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [skillsRoot] },
    });

    try {
      const disabledSkills = await disabledSession.listSkills();
      expect(disabledSkills.map((skill) => skill.name)).toContain('outer');
      expect(disabledSkills.map((skill) => skill.name)).toContain('outer.inner');
      expect(disabledSkills.map((skill) => skill.name)).toContain('sub-skill.consolidate');
    } finally {
      await disabledSession.close();
    }

    const enabledSession = new Session({
      id: 'test-enabled-sub-skills',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [skillsRoot] },
    });

    try {
      const enabledSkills = await enabledSession.listSkills();
      expect(enabledSkills.map((skill) => skill.name)).toContain('outer');
      expect(enabledSkills.map((skill) => skill.name)).toContain('outer.inner');
      expect(enabledSkills.map((skill) => skill.name)).toContain('sub-skill.consolidate');
    } finally {
      await enabledSession.close();
    }
  });
});

describe('Session secondary-model live config', () => {
  const SECONDARY_BASE_CONFIG: KimiConfig = {
    providers: {
      test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey },
    },
    models: {
      [MOCK_PROVIDER.model]: {
        provider: 'test',
        model: MOCK_PROVIDER.model,
        maxContextSize: 1_000_000,
      },
    },
  };
  const SECONDARY_POINTER_CONFIG: KimiConfig = {
    ...SECONDARY_BASE_CONFIG,
    secondaryModel: { model: MOCK_PROVIDER.model },
  };
  const SECONDARY_PATCHED_CONFIG: KimiConfig = {
    ...SECONDARY_BASE_CONFIG,
    models: {
      ...SECONDARY_BASE_CONFIG.models,
      __secondary__: {
        ...SECONDARY_BASE_CONFIG.models![MOCK_PROVIDER.model]!,
        overrides: { defaultEffort: 'low' },
      },
    },
    secondaryModel: { model: MOCK_PROVIDER.model, defaultEffort: 'low' },
  };

  async function makeSession(config?: KimiConfig): Promise<Session> {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    return new Session({
      id: 'test-secondary-model',
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc([]),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
      experimentalFlags: new FlagResolver({
        KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL: '1',
      }),
      config,
    });
  }

  it('live-applies the recipe to the session snapshot and live agents', async () => {
    const session = await makeSession(SECONDARY_BASE_CONFIG);
    try {
      const { agent } = await session.createAgent(
        { type: 'main', generate: createScriptedGenerate().generate },
        { profile: testProfile() },
      );

      session.setSecondaryModelConfig(SECONDARY_POINTER_CONFIG);

      expect(session.kimiConfig?.secondaryModel).toEqual({ model: MOCK_PROVIDER.model });
      expect(agent.kimiConfig?.secondaryModel).toEqual({ model: MOCK_PROVIDER.model });
      // A pointer-only recipe synthesizes no derived entry.
      expect(session.kimiConfig?.models?.['__secondary__']).toBeUndefined();

      // Agents created after the switch read the updated snapshot too.
      const { agent: second } = await session.createAgent(
        { type: 'sub', generate: createScriptedGenerate().generate },
        { profile: testProfile(), parentAgentId: 'main' },
      );
      expect(second.kimiConfig?.secondaryModel).toEqual({ model: MOCK_PROVIDER.model });
    } finally {
      await session.close();
    }
  });

  it('refreshes collaboration tool descriptions when live-applying a recipe', async () => {
    const session = await makeSession(SECONDARY_BASE_CONFIG);
    try {
      const { agent } = await session.createAgent(
        { type: 'main', generate: createScriptedGenerate().generate },
        { profile: { ...testProfile(), tools: ['Agent', 'AgentSwarm'] } },
      );
      agent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });

      const descriptionsBefore = Object.fromEntries(
        agent.tools.loopTools.map((tool) => [tool.name, tool.description]),
      );
      expect(descriptionsBefore['Agent']).not.toContain('Available models');
      expect(descriptionsBefore['AgentSwarm']).not.toContain('Available models');

      session.setSecondaryModelConfig(SECONDARY_POINTER_CONFIG);

      const descriptionsAfter = Object.fromEntries(
        agent.tools.loopTools.map((tool) => [tool.name, tool.description]),
      );
      expect(descriptionsAfter['Agent']).toContain('- secondary: mock-model');
      expect(descriptionsAfter['AgentSwarm']).toContain('- secondary: mock-model');
    } finally {
      await session.close();
    }
  });

  it('replaces a patched runtime snapshot with a pointer-only runtime snapshot', async () => {
    const session = await makeSession(SECONDARY_BASE_CONFIG);
    try {
      session.setSecondaryModelConfig(SECONDARY_PATCHED_CONFIG);
      const derived = session.kimiConfig?.models?.['__secondary__'];
      expect(derived).toBeDefined();
      expect(derived?.overrides?.defaultEffort).toBe('low');

      session.setSecondaryModelConfig(SECONDARY_POINTER_CONFIG);
      expect(session.kimiConfig?.models?.['__secondary__']).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('keeps unrelated session settings when applying a secondary-model config', async () => {
    const session = await makeSession({
      ...SECONDARY_BASE_CONFIG,
      loopControl: { maxStepsPerTurn: 7 },
    });
    try {
      session.setSecondaryModelConfig({
        ...SECONDARY_POINTER_CONFIG,
        loopControl: { maxStepsPerTurn: 99 },
      });

      expect(session.kimiConfig?.loopControl?.maxStepsPerTurn).toBe(7);
    } finally {
      await session.close();
    }
  });

  it('rejects a dangling pointer with the wrapped secondary-model error', async () => {
    const session = await makeSession(SECONDARY_BASE_CONFIG);
    try {
      expect(() =>
        session.setSecondaryModelConfig({
          ...SECONDARY_BASE_CONFIG,
          secondaryModel: { model: 'missing-model' },
        }),
      ).toThrow(/\[secondary_model\]\.model/);
      expect(session.kimiConfig?.secondaryModel).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('rejects when the complete config has no persisted secondary recipe', async () => {
    const session = await makeSession(SECONDARY_BASE_CONFIG);
    try {
      expect(() => session.setSecondaryModelConfig(SECONDARY_BASE_CONFIG)).toThrow(/persist/);
    } finally {
      await session.close();
    }
  });

  it('rejects when the session has no config', async () => {
    const session = await makeSession();
    try {
      expect(() => session.setSecondaryModelConfig(SECONDARY_POINTER_CONFIG)).toThrow(/no config/);
    } finally {
      await session.close();
    }
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-core-init-'));
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

function testProfile(): ResolvedAgentProfile {
  return {
    name: 'test',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
}

function createReadToolKaos(cwd: string, content: string): Kaos {
  return createFakeKaos({
    getcwd: () => cwd,
    stat: async () =>
      ({
        stMode: 0o100644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: content.length,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      }) satisfies StatResult,
    readBytes: async () => Buffer.from(content),
    readLines: async function* () {
      yield content;
    },
  });
}

function registerLookupNoteTool(agent: Agent): void {
  agent.tools.registerUserTool({
    name: 'LookupNote',
    description: 'Look up a note from the host application.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  });
}

function lookupNoteCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_lookup_note',
    name: 'LookupNote',
    arguments: JSON.stringify({ query: 'status' }),
  };
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}

/**
 * Wrap a {@link Kaos} so every `readText` (and `readLines`, which reads via
 * `readText` in the ACP bridge) rejects with `cause`. Used to simulate the
 * Zed ACP `fs/readTextFile` "Internal error" path that broke session bootstrap
 * before AGENTS.md loading was rerouted onto the persistence kaos.
 */
function wrapReadTextWithError(inner: Kaos, cause: Error): Kaos {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'readText') {
        return async () => {
          throw cause;
        };
      }
      if (prop === 'readLines') {
        return async function* () {
          yield* [];
          throw cause;
        };
      }
      if (prop === 'withCwd') {
        return (cwd: string) => wrapReadTextWithError(target.withCwd(cwd), cause);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
