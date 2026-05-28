import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { fileURLToPath } from 'node:url';

import { testKaos } from '../fixtures/test-kaos';
import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderManager } from '../../src/providers/provider-manager';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';

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
  it('runs an isolated system-trigger turn and records the latest AGENTS as a system reminder', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    await mkdir(join(workDir, '.git'));
    await writeFile(join(workDir, 'AGENTS.md'), 'latest project instructions', 'utf-8');

    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const session = new Session({
      id: 'test-init',
      runtime: { kaos: testKaos.withCwd(workDir) },
      homedir: sessionDir,
      rpc: createSessionRpc(events),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      testProfile(),
    );
    mainAgent.config.update({
      modelAlias: 'mock-model',
      thinkingLevel: 'off',
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
        origin: { kind: 'system_trigger', name: 'init' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.completed',
        agentId: 'main',
        subagentId: 'agent-0',
        parentToolCallId: 'generate-agents-md',
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

  it('tracks connected and failed MCP server totals after initial load', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const session = new Session({
      runtime: { kaos: testKaos.withCwd(workDir) },
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
