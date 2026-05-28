import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { localKaos } from '@moonshot-ai/kaos';
import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderManager } from '../../src/providers/provider-manager';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const OS_ENV = {
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
} as const;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Session.listMemory', () => {
  it('returns entries from both user and project scopes', async () => {
    const { session, workDir, homeRoot } = await setupSession();

    await writeFact(join(homeRoot, '.kimi-code', 'memory'), 'user-fact', {
      type: 'user',
      description: 'a user-scope fact',
      body: 'user body',
    });
    await writeFact(join(workDir, '.kimi-code', 'memory'), 'project-fact', {
      type: 'project',
      description: 'a project-scope fact',
      body: 'project body',
    });

    const entries = await session.listMemory();

    const slugs = entries.map((e) => `${e.scope}:${e.record.name}`).toSorted();
    expect(slugs).toEqual(['project:project-fact', 'user:user-fact']);

    const userEntry = entries.find((e) => e.record.name === 'user-fact')!;
    expect(userEntry.scope).toBe('user');
    expect(userEntry.record.type).toBe('user');
    expect(userEntry.body).toContain('user body');

    const projectEntry = entries.find((e) => e.record.name === 'project-fact')!;
    expect(projectEntry.scope).toBe('project');
    expect(projectEntry.record.description).toBe('a project-scope fact');
  });

  it('returns both user and project entries when scopes hold a colliding slug', async () => {
    const { session, workDir, homeRoot } = await setupSession();

    await writeFact(join(homeRoot, '.kimi-code', 'memory'), 'code-style', {
      type: 'user',
      description: 'user code style',
      body: 'user code style body',
    });
    await writeFact(join(workDir, '.kimi-code', 'memory'), 'code-style', {
      type: 'project',
      description: 'project code style',
      body: 'project code style body',
    });

    const entries = await session.listMemory();
    const matching = entries.filter((e) => e.record.name === 'code-style');
    expect(matching).toHaveLength(2);
    expect(matching.map((e) => e.scope).toSorted()).toEqual(['project', 'user']);
  });
});

describe('Session.deleteMemory', () => {
  it('removes the body file and excludes it from subsequent listMemory results', async () => {
    const { session, workDir } = await setupSession();
    const dir = join(workDir, '.kimi-code', 'memory');

    await writeFact(dir, 'doomed', {
      type: 'project',
      description: 'about to be deleted',
      body: 'doomed body',
    });
    await writeFact(dir, 'surviving', {
      type: 'project',
      description: 'survives the delete',
      body: 'surviving body',
    });

    const before = await session.listMemory();
    expect(before.map((e) => e.record.name).toSorted()).toEqual(['doomed', 'surviving']);

    const removed = await session.deleteMemory('project', 'doomed');
    expect(removed).toBe(true);

    const after = await session.listMemory();
    expect(after.map((e) => e.record.name)).toEqual(['surviving']);
  });

  it('returns false for an unknown slug without throwing', async () => {
    const { session } = await setupSession();
    const removed = await session.deleteMemory('project', 'never-existed');
    expect(removed).toBe(false);
  });
});

describe('Session.remember', () => {
  it('spawns a subagent with a prompt that contains the user text and write instruction', async () => {
    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const { session, mainAgent } = await setupSessionWithMainAgent(events, scripted);

    scripted.mockNextResponse({
      type: 'text',
      text: 'Recorded the fact via the Memory tool with operation write so the user can recall it in future sessions across this repository. The slug, type, scope, and description were chosen to match the project conventions described in the request.',
    });

    await session.remember('Use pnpm not npm in this repo');

    // Subagent spawned event recorded by the parent.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        agentId: 'main',
        subagentName: 'coder',
      }),
    );

    // The subagent's first generate call must have been seeded with the
    // synthesized prompt we passed in.
    const firstCallHistory = scripted.calls[0]?.history;
    expect(firstCallHistory).toBeDefined();
    const promptText = firstCallHistory!
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(promptText).toContain('Use pnpm not npm in this repo');
    expect(promptText).toMatch(/Memory tool/i);
    expect(promptText).toMatch(/operation:?\s*["']?write["']?/i);

    // Completion appends a 'memory'-variant system reminder on the main agent.
    const mainContext = mainAgent.context.history
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(mainContext).toContain('<system-reminder>');
  });
});

async function setupSession(): Promise<{
  session: Session;
  workDir: string;
  homeRoot: string;
}> {
  const workDir = await makeTempDir();
  const sessionDir = await makeTempDir();
  const homeRoot = await makeTempDir();
  await mkdir(join(workDir, '.git'), { recursive: true });

  const session = new Session({
    runtime: { kaos: localKaos, osEnv: OS_ENV },
    homedir: sessionDir,
    cwd: workDir,
    kimiHomeDir: homeRoot,
    rpc: createSessionRpc([]),
    skills: { userHomeDir: homeRoot, explicitDirs: [join(workDir, 'missing-skills')] },
    providerManager: testProviderManager(),
  });
  // Override gethome so memory roots resolve under our temp.
  const realGetHome = localKaos.gethome.bind(localKaos);
  vi.spyOn(localKaos, 'gethome').mockReturnValue(homeRoot);
  void realGetHome;
  return { session, workDir, homeRoot };
}

async function setupSessionWithMainAgent(
  events: Array<Record<string, unknown>>,
  scripted: ReturnType<typeof createScriptedGenerate>,
): Promise<{
  session: Session;
  workDir: string;
  homeRoot: string;
  mainAgent: import('../../src/agent').Agent;
}> {
  const workDir = await makeTempDir();
  const sessionDir = await makeTempDir();
  const homeRoot = await makeTempDir();
  await mkdir(join(workDir, '.git'), { recursive: true });

  vi.spyOn(localKaos, 'gethome').mockReturnValue(homeRoot);

  const session = new Session({
    id: 'test-remember',
    runtime: { kaos: localKaos, osEnv: OS_ENV },
    homedir: sessionDir,
    cwd: workDir,
    kimiHomeDir: homeRoot,
    rpc: createSessionRpc(events),
    skills: { userHomeDir: homeRoot, explicitDirs: [join(workDir, 'missing-skills')] },
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
  return { session, workDir, homeRoot, mainAgent };
}

async function writeFact(
  dir: string,
  slug: string,
  opts: { type: string; description: string; body: string },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const frontmatter = [
    '---',
    `name: ${slug}`,
    `description: ${opts.description}`,
    `type: ${opts.type}`,
    '---',
    '',
    opts.body,
    '',
  ].join('\n');
  await writeFile(join(dir, `${slug}.md`), frontmatter, 'utf-8');
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-core-memory-'));
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
