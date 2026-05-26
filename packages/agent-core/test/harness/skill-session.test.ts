import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  KimiCore,
  type ApprovalResponse,
  type CoreAPI,
  type CoreRPC,
  type Event,
  type SDKAPI,
  type TelemetryClient,
} from '../../src';
import {
  recordingContextTelemetry,
  type TelemetryContextRecord,
} from '../fixtures/telemetry';

describe('HarnessAPI session skills', () => {
  let tmp: string;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-skills-'));
    homeDir = join(tmp, 'home');
    workDir = join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('lists session skills without exposing content', async () => {
    await writeSkill('phase-one-review', [
      '---',
      'name: phase-one-review',
      'description: Review code',
      'disable_model_invocation: true',
      '---',
      '',
      'Review the requested file.',
    ]);
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_list', workDir });

    const skills = await rpc.listSkills({ sessionId: created.id });
    const listed = skills.find((skill) => skill.name === 'phase-one-review');

    expect(listed).toMatchObject({
      name: 'phase-one-review',
      description: 'Review code',
      source: 'project',
      disableModelInvocation: true,
    });
    expect(listed?.path.endsWith('/.kimi-code/skills/phase-one-review/SKILL.md')).toBe(true);
    expect(JSON.stringify(skills)).not.toContain('Review the requested file.');
  });

  it('uses the first body line when a flat skill description is missing', async () => {
    await writeFlatSkill('body-described', [
      '',
      '  First useful line that describes it.  ',
      '',
      'Full instructions stay private.',
    ]);
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_description_fallback', workDir });

    const skills = await rpc.listSkills({ sessionId: created.id });
    const listed = skills.find((skill) => skill.name === 'body-described');

    expect(listed).toMatchObject({
      name: 'body-described',
      description: 'First useful line that describes it.',
      source: 'project',
    });
    expect(JSON.stringify(skills)).not.toContain('Full instructions stay private.');
  });

  it('lists bundled built-in skills by default', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_builtin_skill_list', workDir });

    const skills = await rpc.listSkills({ sessionId: created.id });
    const listed = skills.find((skill) => skill.name === 'mcp-config');

    expect(listed).toMatchObject({
      name: 'mcp-config',
      description: 'Configure MCP servers and handle MCP OAuth login.',
      source: 'builtin',
    });
    expect(listed?.path).toBe('builtin://mcp-config');
    expect(JSON.stringify(skills)).not.toContain('Your tool list contains one synthetic tool');
  });

  it('resolves user skills from the OS home directory, not from the kimi home', async () => {
    const processHome = join(tmp, 'process-home');
    vi.stubEnv('HOME', processHome);
    await writeUserSkill(processHome, 'real-home-only', 'Real home skill');
    await writeUserSkill(homeDir, 'sandbox-only', 'Sandbox skill');
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_sandbox_home', workDir });

    const names = new Set((await rpc.listSkills({ sessionId: created.id })).map((skill) => skill.name));

    expect(names.has('real-home-only')).toBe(true);
    expect(names.has('sandbox-only')).toBe(false);
  });

  it('resolves user skills from the OS home directory even when KIMI_CODE_HOME is set', async () => {
    const processHome = join(tmp, 'env-process-home');
    vi.stubEnv('HOME', processHome);
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    await writeUserSkill(processHome, 'env-real-home-only', 'Env real home skill');
    await writeUserSkill(homeDir, 'env-sandbox-only', 'Env sandbox skill');
    const { rpc } = await createTestRpc({});
    const created = await rpc.createSession({ id: 'ses_skill_env_home', workDir });

    const names = new Set((await rpc.listSkills({ sessionId: created.id })).map((skill) => skill.name));

    expect(names.has('env-real-home-only')).toBe(true);
    expect(names.has('env-sandbox-only')).toBe(false);
  });

  it('activates an inline skill through core and records display origin metadata', async () => {
    await writeSkill('phase-one-review', [
      '---',
      'name: phase-one-review',
      'description: Review code',
      'disable_model_invocation: true',
      '---',
      '',
      'Review the requested file.',
    ]);
    const telemetryRecords: TelemetryContextRecord[] = [];
    const { core, events, rpc } = await createTestRpc({
      homeDir,
      telemetry: recordingContextTelemetry(telemetryRecords),
    });
    const created = await rpc.createSession({ id: 'ses_skill_activate', workDir });

    await rpc.activateSkill({
      sessionId: created.id,
      agentId: 'main',
      name: 'phase-one-review',
      args: 'src/app.ts',
    });
    await waitForEvent(events, (event) => event.type === 'skill.activated');
    await core.sessions.get(created.id)?.flushMetadata();

    const skillEvent = events.find((event) => event.type === 'skill.activated');
    expect(skillEvent).toMatchObject({
      type: 'skill.activated',
      agentId: 'main',
      sessionId: created.id,
      skillName: 'phase-one-review',
      skillArgs: 'src/app.ts',
      trigger: 'user-slash',
      skillSource: 'project',
    });
    expect(JSON.stringify(skillEvent)).not.toContain('Review the requested file.');
    expect(telemetryRecords).toContainEqual({
      event: 'skill_invoked',
      sessionId: created.id,
      properties: {
        skill_name: 'phase-one-review',
        trigger: 'user-slash',
      },
    });
    expect(telemetryRecords.some((record) => record.event === 'flow_invoked')).toBe(false);

    const skillIndex = events.findIndex((event) => event.type === 'skill.activated');
    const turnIndex = events.findIndex((event) => event.type === 'turn.started');
    expect(skillIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThan(skillIndex);

    const records = await readMainWire(created.sessionDir);
    const prompt = records.find((record) => record['type'] === 'turn.prompt');
    const userMessage = records.find((record) => record['type'] === 'context.append_message');
    const expectedPrompt = 'Review the requested file.\n\nARGUMENTS: src/app.ts';
    expect(prompt).toMatchObject({
      type: 'turn.prompt',
      input: [{ type: 'text', text: expectedPrompt }],
      origin: {
        kind: 'skill_activation',
        skillName: 'phase-one-review',
        skillArgs: 'src/app.ts',
        trigger: 'user-slash',
        skillSource: 'project',
      },
    });
    expect(userMessage).toMatchObject({
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: expectedPrompt }],
        origin: {
          kind: 'skill_activation',
          skillName: 'phase-one-review',
          skillArgs: 'src/app.ts',
          trigger: 'user-slash',
          skillSource: 'project',
        },
      },
    });
    expect(
      (prompt as { origin?: { activationId?: string } } | undefined)?.origin?.activationId,
    ).toBe((skillEvent as { activationId?: string } | undefined)?.activationId);
    expect((skillEvent as { activationId?: string } | undefined)?.activationId).toBe(
      (userMessage as { message?: { origin?: { activationId?: string } } } | undefined)?.message
        ?.origin?.activationId,
    );

    const context = await rpc.getContext({ sessionId: created.id, agentId: 'main' });
    expect(context.history.at(0)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expectedPrompt }],
      toolCalls: [],
      origin: {
        kind: 'skill_activation',
        skillName: 'phase-one-review',
        skillArgs: 'src/app.ts',
        trigger: 'user-slash',
        skillSource: 'project',
      },
    });
  });

  it('expands skill body placeholders on user slash activation', async () => {
    await writeSkill('templated-review', [
      '---',
      'name: templated-review',
      'description: Review with template variables',
      'arguments:',
      '  - target',
      '  - mode',
      '---',
      '',
      'Target: $target',
      'Mode: $mode',
      'Raw: $ARGUMENTS',
      'Dir: ${KIMI_SKILL_DIR}',
      'Session: ${KIMI_SESSION_ID}',
    ]);
    const { core, rpc } = await createTestRpc({ homeDir });
    const created = await rpc.createSession({ id: 'ses_skill_template', workDir });

    await rpc.activateSkill({
      sessionId: created.id,
      agentId: 'main',
      name: 'templated-review',
      args: '"src/app.ts" careful',
    });
    await core.sessions.get(created.id)?.flushMetadata();

    const records = await readMainWire(created.sessionDir);
    const prompt = records.find((record) => record['type'] === 'turn.prompt');
    const skillDir = await realpath(join(workDir, '.kimi-code', 'skills', 'templated-review'));
    const expectedPrompt = [
      'Target: src/app.ts',
      'Mode: careful',
      'Raw: "src/app.ts" careful',
      `Dir: ${skillDir}`,
      'Session: ses_skill_template',
    ].join('\n');
    expect(prompt).toMatchObject({
      type: 'turn.prompt',
      input: [{ type: 'text', text: expectedPrompt }],
      origin: {
        kind: 'skill_activation',
        skillName: 'templated-review',
        skillArgs: '"src/app.ts" careful',
      },
    });
    expect(JSON.stringify(prompt)).not.toContain('ARGUMENTS:');
  });

  it('records legacy flow telemetry when activating a flow skill', async () => {
    await writeSkill('review-flow', [
      '---',
      'name: review-flow',
      'description: Review flow',
      'type: flow',
      '---',
      '',
      'Review the requested file as a flow.',
    ]);
    const telemetryRecords: TelemetryContextRecord[] = [];
    const { events, rpc } = await createTestRpc({
      homeDir,
      telemetry: recordingContextTelemetry(telemetryRecords),
    });
    const created = await rpc.createSession({ id: 'ses_flow_skill_activate', workDir });

    await rpc.activateSkill({
      sessionId: created.id,
      agentId: 'main',
      name: 'review-flow',
    });
    await waitForEvent(events, (event) => event.type === 'skill.activated');

    expect(telemetryRecords).toContainEqual({
      event: 'skill_invoked',
      sessionId: created.id,
      properties: {
        skill_name: 'review-flow',
        trigger: 'user-slash',
      },
    });
    expect(telemetryRecords).toContainEqual({
      event: 'flow_invoked',
      sessionId: created.id,
      properties: {
        flow_name: 'review-flow',
      },
    });
  });

  it('does not re-emit skill activation live events on resume', async () => {
    await writeSkill('phase-one-review', [
      '---',
      'name: phase-one-review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_skill_resume', workDir });
    await first.rpc.activateSkill({
      sessionId: created.id,
      agentId: 'main',
      name: 'phase-one-review',
      args: 'src/app.ts',
    });
    await waitForEvent(first.events, (event) => event.type === 'skill.activated');
    await first.core.sessions.get(created.id)?.flushMetadata();

    const second = await createTestRpc();
    const resumed = await second.rpc.resumeSession({ sessionId: created.id });

    expect(second.events.some((event) => event.type === 'skill.activated')).toBe(false);
    const context = await second.rpc.getContext({ sessionId: created.id, agentId: 'main' });
    expect(context.history).toMatchObject([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Review the requested file.\n\nARGUMENTS: src/app.ts',
          },
        ],
        origin: {
          kind: 'skill_activation',
          skillName: 'phase-one-review',
          skillArgs: 'src/app.ts',
          trigger: 'user-slash',
          skillSource: 'project',
        },
      },
    ]);
    const replay = resumed.agents['main']?.replay ?? [];
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          origin: expect.objectContaining({
            kind: 'skill_activation',
            skillName: 'phase-one-review',
          }),
        }),
      }),
    );
    expect(replay).not.toContainEqual(
      expect.objectContaining({
        type: 'turn.prompt',
        origin: expect.objectContaining({ kind: 'skill_activation' }),
      }),
    );
  });

  it('registers builtin mcp-config skill, hides it from the model, and activates it via slash', async () => {
    const { core, events, rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_builtin', workDir });

    const skills = await rpc.listSkills({ sessionId: created.id });
    const builtin = skills.find((skill) => skill.name === 'mcp-config');
    expect(builtin).toMatchObject({
      name: 'mcp-config',
      source: 'builtin',
      disableModelInvocation: true,
    });

    const session = core.sessions.get(created.id);
    expect(session).toBeDefined();
    const invocable = session!.skills.listInvocableSkills();
    expect(invocable.some((skill) => skill.name === 'mcp-config')).toBe(false);
    expect(session!.skills.getModelSkillListing()).not.toContain('mcp-config');

    await rpc.activateSkill({
      sessionId: created.id,
      agentId: 'main',
      name: 'mcp-config',
    });
    const activated = await waitForEvent(events, (event) => event.type === 'skill.activated');
    expect(activated).toMatchObject({
      type: 'skill.activated',
      skillName: 'mcp-config',
      trigger: 'user-slash',
      skillSource: 'builtin',
    });

    await session?.flushMetadata();
    const records = await readMainWire(created.sessionDir);
    const prompt = records.find((record) => record['type'] === 'turn.prompt');
    expect(prompt).toMatchObject({
      type: 'turn.prompt',
      origin: {
        kind: 'skill_activation',
        skillName: 'mcp-config',
        skillSource: 'builtin',
      },
    });
    const promptInput = (prompt as { input?: ReadonlyArray<{ text?: string }> } | undefined)?.input;
    expect(promptInput?.[0]?.text).toContain('Interactive MCP server configuration');
    expect(promptInput?.[0]?.text).toContain('AskUserQuestion');
  });

  it('lets a user-supplied skill override the builtin of the same name', async () => {
    await writeSkill('mcp-config', [
      '---',
      'name: mcp-config',
      'description: Project-local override',
      '---',
      '',
      'Local override body.',
    ]);
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_builtin_override', workDir });

    const skills = await rpc.listSkills({ sessionId: created.id });
    const listed = skills.find((skill) => skill.name === 'mcp-config');
    expect(listed).toMatchObject({
      name: 'mcp-config',
      source: 'project',
      description: 'Project-local override',
    });
  });

  it('rejects missing and non-inline skills with structured errors', async () => {
    const { core, rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_errors', workDir });

    await expect(
      rpc.activateSkill({ sessionId: created.id, agentId: 'main', name: 'missing' }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'skill.not_found',
    });

    const session = core.sessions.get(created.id);
    session?.skills.registerBuiltinSkill({
      name: 'forked',
      description: 'Forked skill',
      path: '/skills/forked/SKILL.md',
      dir: '/skills/forked',
      content: 'fork body',
      metadata: { type: 'fork' },
      source: 'builtin',
    });

    await expect(
      rpc.activateSkill({ sessionId: created.id, agentId: 'main', name: 'forked' }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'skill.type_unsupported',
    });
  });

  async function writeSkill(name: string, lines: readonly string[]): Promise<void> {
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

  async function writeFlatSkill(name: string, lines: readonly string[]): Promise<void> {
    const dir = join(workDir, '.kimi-code', 'skills');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), lines.join('\n'));
  }

  async function createTestRpc(options?: {
    readonly homeDir?: string;
    readonly telemetry?: TelemetryClient;
  }): Promise<{
    core: KimiCore;
    events: Event[];
    rpc: CoreRPC;
  }> {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const events: Event[] = [];
    const configuredHomeDir = options === undefined ? homeDir : options.homeDir;
    const core = new KimiCore(
      coreRpc,
      { homeDir: configuredHomeDir, telemetry: options?.telemetry },
    );
    const rpc = await sdkRpc({
      emitEvent: (event) => {
        events.push(event);
      },
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    return { core, events, rpc };
  }
});

async function waitForEvent(
  events: readonly Event[],
  predicate: (event: Event) => boolean,
): Promise<Event> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await delay(10);
  }
  throw new Error('Timed out waiting for event');
}

async function readMainWire(sessionDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
