import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SkillSummary } from '@moonshot-ai/agent-core-v2';

import { ACP_BUILTIN_SLASH_COMMANDS } from '../src/builtin-commands';
import { buildAcpSkillSlashCommands } from '../src/slash';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider, type ScriptedProvider } from './_helpers/scriptedProvider';

interface AvailableCommand {
  readonly name: string;
  readonly description?: string;
  readonly input?: { readonly hint?: string } | null;
}

/** The update payload's command list, typed loosely for assertions. */
function commandsOf(notification: unknown): readonly AvailableCommand[] {
  const params = (notification as { params?: { update?: { availableCommands?: unknown } } })
    .params;
  return (params?.update?.availableCommands ?? []) as readonly AvailableCommand[];
}

function skill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    source: 'project',
    ...overrides,
  };
}

describe('buildAcpSkillSlashCommands', () => {
  it('prefixes non-builtin skills with `skill:` and keeps builtin/sub-skill names bare', () => {
    const { commands, commandMap } = buildAcpSkillSlashCommands([
      skill('workspace-one'),
      skill('engine-one', { source: 'builtin' }),
      skill('nested', { isSubSkill: true }),
    ]);

    expect(commands.map((command) => command.name)).toEqual([
      'engine-one',
      'nested',
      'skill:workspace-one',
    ]);
    expect(commandMap.get('skill:workspace-one')).toBe('workspace-one');
    expect(commandMap.get('engine-one')).toBe('engine-one');
  });

  it('filters out skills the user cannot activate', () => {
    const { commands } = buildAcpSkillSlashCommands([
      skill('reference-only', { type: 'reference' }),
      skill('flow-one', { type: 'flow' }),
      skill('inline-one'),
    ]);

    expect(commands.map((command) => command.name)).toEqual(['skill:flow-one', 'skill:inline-one']);
  });

  it('drops skills whose command name collides with an ACP builtin', () => {
    const { commands, commandMap } = buildAcpSkillSlashCommands([
      skill('compact', { source: 'builtin' }),
      skill('help'),
    ]);

    expect(commands.map((command) => command.name)).toEqual(['skill:help']);
    expect(commandMap.has('compact')).toBe(false);
  });
});

describe('acp-server skills / available commands', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let scripted: ScriptedProvider | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-skills-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  /**
   * Boot with the scripted LLM and a project skill fixture at
   * `<cwd>/.kimi-code/skills/acp-fixture/SKILL.md` (the engine's project
   * skill discovery root; the temp cwd has no `.git`, so it IS the project
   * root).
   */
  async function bootWithFixtureSkill(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-skills-turn-'));
    await writeFakeModelConfig(homeDir);
    await mkdir(join(homeDir, '.kimi-code', 'skills', 'acp-fixture'), { recursive: true });
    await writeFile(
      join(homeDir, '.kimi-code', 'skills', 'acp-fixture', 'SKILL.md'),
      '---\nname: acp-fixture\ndescription: ACP fixture skill\n---\n\n' +
        '# ACP Fixture\n\nAlways answer with the word FIXTURE.\n',
    );
    scripted = createScriptedProvider();
    client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function newSession(c: TestClient): Promise<string> {
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    return created.sessionId;
  }

  it('session/new pushes builtins first, then the session skills', async () => {
    const c = await boot();
    await c.send('session/new', { cwd: homeDir, mcpServers: [] });

    const notification = await c.waitForSessionUpdate('available_commands_update', 10_000);
    const commands = commandsOf(notification);
    // The six ACP builtins (executed locally by the host) stay first…
    expect(commands.slice(0, ACP_BUILTIN_SLASH_COMMANDS.length).map((command) => command.name))
      .toEqual(ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name));
    // …followed by the engine's builtin skills (bare command names).
    expect(commands.length).toBeGreaterThan(ACP_BUILTIN_SLASH_COMMANDS.length);
    expect(commands.some((command) => command.name === 'write-goal')).toBe(true);
    const compact = commands.find((command) => command.name === 'compact');
    expect(compact?.input?.hint).toBe('<optional custom summarization instructions>');
  }, 30_000);

  it('advertises a workspace skill as `skill:<name>` with its description', async () => {
    const c = await bootWithFixtureSkill();
    await c.send('session/new', { cwd: homeDir, mcpServers: [] });

    const notification = await c.waitForSessionUpdate('available_commands_update', 10_000);
    const commands = commandsOf(notification);
    const fixture = commands.find((command) => command.name === 'skill:acp-fixture');
    expect(fixture?.description).toBe('ACP fixture skill');
  }, 30_000);

  it('/skill:acp-fixture activates the skill and drives a normal turn', async () => {
    const c = await bootWithFixtureSkill();
    scripted!.mockNextText('FIXTURE');
    const sessionId = await newSession(c);

    const promptPromise = c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/skill:acp-fixture some args' }],
    });

    const chunk = await c.waitForSessionUpdate('agent_message_chunk', 10_000);
    expect(
      (chunk.params as { update?: { content?: { text?: string } } }).update?.content?.text,
    ).toContain('FIXTURE');

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(1);

    // The model received the rendered skill activation (content + args), not
    // the raw slash text.
    const history = JSON.stringify(scripted!.callHistory()[0]);
    expect(history).toContain('kimi-skill-loaded');
    expect(history).toContain('Always answer with the word FIXTURE');
    expect(history).toContain('ARGUMENTS: some args');
    expect(history).not.toContain('/skill:acp-fixture');
  }, 30_000);

  it('a builtin-source skill activates through its bare command name', async () => {
    const c = await bootWithFixtureSkill();
    scripted!.mockNextText('goal noted');
    const sessionId = await newSession(c);

    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/write-goal ship it' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(1);

    const history = JSON.stringify(scripted!.callHistory()[0]);
    expect(history).toContain('kimi-skill-loaded');
    expect(history).toContain('write-goal');
  }, 30_000);

  it('an unknown slash command is answered locally and never reaches the model', async () => {
    const c = await bootWithFixtureSkill();
    scripted!.mockNextText('echoed');
    const sessionId = await newSession(c);

    const before = c.sessionUpdates().length;
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '/no-such-skill hi' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    // No LLM turn was launched — the notice is a local agent_message_chunk.
    expect(scripted!.callCount()).toBe(0);
    type Update = { sessionUpdate?: string; content?: { text?: string } };
    const chunk = c
      .sessionUpdates()
      .slice(before)
      .map((m) => (m.params as { update?: Update }).update)
      .find((u) => u?.sessionUpdate === 'agent_message_chunk');
    expect(chunk?.content?.text).toBe(
      'Unknown ACP command: /no-such-skill. Use /help to see available commands.',
    );
  }, 30_000);
});
