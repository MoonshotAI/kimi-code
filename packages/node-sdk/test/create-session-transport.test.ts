/**
 * Scenario: KimiHarness session creation and resume transport behavior.
 * Responsibilities: SDK options reach the in-process core; session identity and resume handoffs remain stable.
 * Wiring: the real SDK/core are used; model/network boundaries are configured but never called.
 * Run: pnpm -C packages/node-sdk exec vitest run test/create-session-transport.test.ts
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kaos } from '@moonshot-ai/kaos';
import {
  createKimiHarness,
  createKimiHarnessV2,
  KimiHarness,
  SDKRpcClient,
  type ApprovalHandler,
  type Event,
  type QuestionHandler,
  type Session,
} from '#/index';
import type { KimiError } from '#/index';
import type { ResumeSessionInput, ResumedSessionSummary } from '#/types';
import { SDKRpcClientBase } from '#/rpc';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForAgentWireEvent } from './session-runtime-helpers';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

// node-sdk/agent-core normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-create-'));
  tempDirs.push(dir);
  return dir;
}

function createSignal(): { readonly promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

async function writeTestModelConfig(homeDir: string, modelName = 'kimi-test-model'): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."${modelName}"]
provider = "local"
model = "${modelName}"
max_context_size = 1000
`,
    'utf-8',
  );
}

async function writeReviewerAgent(workDir: string): Promise<void> {
  const agentDir = join(workDir, '.kimi-code', 'agents');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code.\nsubagents:\n  - explore\n---\n\nReview the requested change.\n',
    'utf-8',
  );
}

class StubRpc extends SDKRpcClientBase {
  resumeCalls: Array<{ input: ResumeSessionInput; kaos: Kaos; persistenceKaos?: Kaos }> = [];

  protected async getRpc(): Promise<never> {
    throw new Error('not used');
  }

  override async createSession(input: { id?: string; workDir: string }) {
    return {
      id: input.id ?? 'ses_stub',
      workDir: input.workDir,
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
    };
  }

  override async resumeSessionWithKaos(input: ResumeSessionInput, kaos: Kaos, persistenceKaos?: Kaos): Promise<ResumedSessionSummary> {
    this.resumeCalls.push({ input, kaos, persistenceKaos });
    return {
      id: input.id,
      workDir: '/tmp/work',
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
      sessionMetadata: {
        createdAt: '',
        updatedAt: '',
        title: '',
        isCustomTitle: false,
        agents: {},
        custom: {},
      },
      agents: {},
    };
  }
}

class ResumeEventRpc extends SDKRpcClientBase {
  private subscriptions = 0;

  constructor(
    private readonly rejectResume = false,
    private readonly onResume?: () => void,
  ) {
    super();
  }

  get listenerCount(): number {
    return this.subscriptions;
  }

  protected async getRpc(): Promise<never> {
    throw new Error('not used');
  }

  override onEvent(listener: (event: Event) => void): () => void {
    const unsubscribe = super.onEvent(listener);
    this.subscriptions += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscriptions -= 1;
      unsubscribe();
    };
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    this.onResume?.();
    for (const event of resumeEvents(input.id)) {
      this.receiveEvent(event);
    }
    if (this.rejectResume) {
      throw new Error('resume failed');
    }
    return resumedSummary(input.id);
  }

  override async closeSession(): Promise<void> {}
}

class HandoffRpc extends StubRpc {
  closeCalls = 0;

  constructor(private readonly resumeSummary: ResumedSessionSummary) {
    super();
  }

  override async resumeSessionWithHandoff(
    _input: ResumeSessionInput,
    handoff: (summary: ResumedSessionSummary) => Promise<void>,
    onSnapshotStart?: () => void,
    onSnapshotReady?: () => void,
  ): Promise<ResumedSessionSummary> {
    onSnapshotStart?.();
    onSnapshotReady?.();
    await handoff(this.resumeSummary);
    return this.resumeSummary;
  }

  override async closeSession(): Promise<void> {
    this.closeCalls += 1;
  }
}

class RollbackOwningHandoffRpc extends HandoffRpc {
  override readonly handlesResumeHandoffFailure = true;
}

class DelayedFirstRollbackOwningHandoffRpc extends RollbackOwningHandoffRpc {
  private resumeCount = 0;

  constructor(
    resumeSummary: ResumedSessionSummary,
    private readonly firstResumeReady: Promise<void>,
  ) {
    super(resumeSummary);
  }

  override async resumeSessionWithHandoff(
    input: ResumeSessionInput,
    handoff: (summary: ResumedSessionSummary) => Promise<void>,
    onSnapshotStart?: () => void,
    onSnapshotReady?: () => void,
  ): Promise<ResumedSessionSummary> {
    const resumeIndex = this.resumeCount++;
    if (resumeIndex === 0) {
      await this.firstResumeReady;
    }
    return super.resumeSessionWithHandoff(
      input,
      handoff,
      onSnapshotStart,
      onSnapshotReady,
    );
  }
}

function resumedSummary(id: string): ResumedSessionSummary {
  return {
    id,
    workDir: '/tmp/work',
    sessionDir: '/tmp/session',
    createdAt: 1,
    updatedAt: 1,
    sessionMetadata: {
      createdAt: '',
      updatedAt: '',
      title: '',
      isCustomTitle: false,
      agents: {},
      custom: {},
    },
    agents: {},
  };
}

function resumeEvents(sessionId: string): readonly Event[] {
  return [
    {
      type: 'cron.fired',
      sessionId,
      agentId: 'main',
      origin: {
        kind: 'cron_job',
        jobId: 'cron-example',
        cron: '0 9 * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
      prompt: 'Review the scheduled report.',
    },
    {
      type: 'turn.started',
      sessionId,
      agentId: 'main',
      turnId: 7,
      origin: {
        kind: 'cron_job',
        jobId: 'cron-example',
        cron: '0 9 * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
    },
    {
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 7,
      delta: 'Scheduled review finished.',
    },
    {
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 7,
      reason: 'completed',
    },
  ] as Event[];
}

function makeStubHarness(rpc: SDKRpcClientBase): KimiHarness {
  return new KimiHarness(rpc, {
    homeDir: '/tmp/home',
    configPath: '/tmp/config.toml',
    auth: { status: async () => ({ providers: [] }) } as never,
    telemetry: recordingTelemetry([]),
    ensureConfigFile: async () => undefined,
    onClose: () => undefined,
  });
}

interface HandoffHarnessCase {
  readonly engine: 'v1' | 'v2';
  readonly createHarness: typeof createKimiHarness;
}

const HANDOFF_HARNESS_CASES: readonly HandoffHarnessCase[] = [
  { engine: 'v1', createHarness: createKimiHarness },
  { engine: 'v2', createHarness: createKimiHarnessV2 },
];

describe('KimiHarness.createSession transport link', () => {
  it('emits session_started with client attribution when a session is opened', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started',
        workDir,
      });
      await harness.resumeSession({ id: session.id });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
        },
      });
      expect(records.filter((record) => record.event === 'session_started')).toHaveLength(1);
      expect(records).toContainEqual({
        event: 'session_new',
        sessionId: session.id,
        properties: undefined,
      });

      await session.close();
      await harness.resumeSession({ id: session.id });

      expect(records.filter((record) => record.event === 'session_started')).toHaveLength(2);
      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
        },
      });
      expect(records).toContainEqual({
        event: 'session_resume',
        sessionId: session.id,
        properties: undefined,
      });
    } finally {
      await harness.close();
    }
  });

  it('uses the configured UI mode for session_started attribution', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      uiMode: 'print',
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started_print',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'print',
          resumed: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('merges process-level sessionStartedProperties into session_started', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      sessionStartedProperties: { yolo: true, plan: false },
    });

    try {
      const session = await harness.createSession({
        id: 'ses_process_props',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          yolo: true,
          plan: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('merges session-level sessionStartedProperties and overrides process-level ones', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      sessionStartedProperties: { mode: 'process', source: 'process' },
    });

    try {
      const session = await harness.createSession({
        id: 'ses_scoped_props',
        workDir,
        sessionStartedProperties: { mode: 'new' },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          mode: 'new',
          source: 'process',
        },
      });

      await session.close();
      await harness.resumeSession({
        id: session.id,
        sessionStartedProperties: { mode: 'load' },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
          mode: 'load',
          source: 'process',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('does not let sessionStartedProperties override canonical session_started fields', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_reserved_keys',
        workDir,
        sessionStartedProperties: {
          client_name: 'evil',
          client_version: 'evil',
          ui_mode: 'evil',
          resumed: true,
          extra: 'kept',
        },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          extra: 'kept',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('emits session_fork with the forked session context', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const source = await harness.createSession({
        id: 'ses_fork_source',
        workDir,
      });
      const forked = await harness.forkSession({
        id: source.id,
        forkId: 'ses_fork_child',
        title: 'Forked child',
      });

      expect(forked.id).toBe('ses_fork_child');
      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: forked.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
        },
      });
      expect(records).toContainEqual({
        event: 'session_fork',
        sessionId: forked.id,
        properties: undefined,
      });
    } finally {
      await harness.close();
    }
  });

  it('does not invent client attribution without host identity', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started_shell',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: null,
          client_version: null,
          ui_mode: 'shell',
          resumed: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('creates metadata and keeps the session active in the harness', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_transport_link',
        workDir,
        model: 'kimi-test-model',
      });

      expect(session.id).toBe('ses_transport_link');
      expect(session.workDir).toBe(toPosix(workDir));
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-test-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'kimi-test-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'kimi-test-model',
      });
      expect(configEvent).not.toHaveProperty('provider');

      const summaries = await harness.listSessions({ workDir });
      const summary = summaries.find((item) => item.id === session.id);
      expect(summary?.sessionDir).not.toBe(join(homeDir, 'sessions', session.id));
      expect(summary?.sessionDir).toContain(toPosix(join(homeDir, 'sessions')));
      expect(existsSync(join(summary!.sessionDir, 'state.json'))).toBe(true);
      expect(await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8')).toContain(session.id);

      const summariesById = await harness.listSessions({ sessionId: session.id });
      expect(summariesById).toHaveLength(1);
      expect(summariesById[0]).toMatchObject({
        id: session.id,
        workDir: toPosix(workDir),
      });
      await expect(harness.listSessions({ sessionId: 'ses_missing' })).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('accepts configured model aliases while creating the core session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "alias-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.alias-model]
provider = "local"
model = "real-model"
max_context_size = 1000

[thinking]
effort = "medium"
`,
      'utf-8',
    );
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_alias_model', workDir });
      expect(session.id).toBe('ses_alias_model');
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'alias-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'alias-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'alias-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('does not require provider config or API keys before prompt is implemented', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_config', workDir });
      expect(session.id).toBe('ses_empty_config');
      expect((await session.getStatus()).model).toBeUndefined();
      expect(harness.sessions.get(session.id)).toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('requires a non-empty workDir on createSession', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(
        harness.createSession({ id: 'ses_missing_workdir' } as never),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
      await expect(
        harness.createSession({ id: 'ses_blank_workdir', workDir: '   ' }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when MCP config validation fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    // Project-local mcp.json is intentionally ignored, so plant the malformed
    // file under the user home dir where the loader actually reads from.
    await writeFile(join(homeDir, 'mcp.json'), '{not json}', 'utf-8');
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({ id: 'ses_bad_mcp_config', workDir }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'config.invalid',
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, 'session_index.jsonl'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when the requested agent profile is missing', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: 'ses_missing_agent_profile',
          workDir,
          agentProfile: 'missing-agent',
        }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'agent.not_found',
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, 'session_index.jsonl'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('allows the session ID to be reused after agent profile selection fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: 'ses_reusable_after_missing_profile',
          workDir,
          agentProfile: 'missing-agent',
        }),
      ).rejects.toMatchObject({ code: 'agent.not_found' });

      await expect(
        harness.createSession({
          id: 'ses_reusable_after_missing_profile',
          workDir,
        }),
      ).resolves.toMatchObject({ id: 'ses_reusable_after_missing_profile' });
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when an explicit agent file cannot be loaded', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({
          id: 'ses_missing_explicit_agent_file',
          workDir,
          agentFiles: [join(workDir, 'missing-agent.md')],
        }),
      ).rejects.toThrow(/missing-agent\.md/);
      expect(await harness.listSessions({ workDir })).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('closes active runtime handles through closeSession, session.close, and close', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    const first = await harness.createSession({
      id: 'ses_close_one',
      workDir,
      model: 'kimi-test-model',
    });
    const second = await harness.createSession({
      id: 'ses_close_two',
      workDir,
      model: 'kimi-test-model',
    });
    expect(coreSessionIds(harness)).toEqual([first.id, second.id]);

    await harness.closeSession(first.id);
    expect(harness.getSession(first.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([second.id]);

    await second.close();
    expect(harness.getSession(second.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([]);

    await harness.close();
    expect(harness.sessions.size).toBe(0);
    expect(coreSessionIds(harness)).toEqual([]);
  });

  it('permanently deletes an active session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_delete_active', workDir });
      const [summary] = await harness.listSessions({ sessionId: session.id });

      await harness.deleteSession(session.id);

      expect(harness.getSession(session.id)).toBeUndefined();
      await expect(harness.listSessions({ sessionId: session.id })).resolves.toEqual([]);
      expect(existsSync(summary!.sessionDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('returns session.not_found when deleteSession targets a missing id', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await expect(harness.deleteSession('ses_delete_missing')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.not_found',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('allows a deleted session id to be created again', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const sessionId = 'ses_delete_recreate';

    try {
      await harness.createSession({ id: sessionId, workDir });
      await harness.deleteSession(sessionId);

      const recreated = await harness.createSession({ id: sessionId, workDir });

      expect(recreated.id).toBe(sessionId);
      await expect(harness.listSessions({ sessionId })).resolves.toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('preserves a legacy source directory referenced by session metadata', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const legacySourceDir = await makeTempDir();
    const markerPath = join(legacySourceDir, 'legacy-marker.txt');
    await writeFile(markerPath, 'legacy source remains', 'utf-8');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_delete_migrated',
        workDir,
        metadata: { kimi_cli_source_path: legacySourceDir },
      });

      await harness.deleteSession(session.id);

      await expect(readFile(markerPath, 'utf-8')).resolves.toBe('legacy source remains');
    } finally {
      await harness.close();
    }
  });

  it('applies initial thinking and permission runtime options', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_initial_runtime_options',
        workDir,
        thinking: 'low',
        permission: 'auto',
      });

      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'config.update',
          (event) => event['thinkingEffort'] === 'low',
        ),
      ).resolves.toMatchObject({
        type: 'config.update',
        thinkingEffort: 'low',
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });
    } finally {
      await harness.close();
    }
  });

  it('applies configured default permission mode to new sessions', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(join(homeDir, 'config.toml'), 'default_permission_mode = "auto"\n', 'utf-8');
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_default_permission_mode',
        workDir,
      });

      await expect(session.getStatus()).resolves.toMatchObject({ permission: 'auto' });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });

      const explicit = await harness.createSession({
        id: 'ses_default_permission_explicit_override',
        workDir,
        permission: 'manual',
      });
      await expect(explicit.getStatus()).resolves.toMatchObject({ permission: 'manual' });
    } finally {
      await harness.close();
    }
  });

  it('rebinds an active session when resumeSession receives a new Kaos', async () => {
    const records: TelemetryRecord[] = [];
    const rpc = new StubRpc();
    const harness = new KimiHarness(rpc, {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry(records),
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
    });

    const session = await harness.createSession({ id: 'ses_active', workDir: '/tmp/work' });
    const kaos = {} as Kaos;

    const resumed = await harness.resumeSession({ id: session.id, kaos });

    expect(resumed).toBe(session);
    expect(rpc.resumeCalls).toHaveLength(1);
    expect(rpc.resumeCalls[0]).toMatchObject({
      input: { id: 'ses_active' },
      kaos,
      persistenceKaos: undefined,
    });
  });

  it('runs the default snapshot-start hook once at the beginning of the resume lifecycle', async () => {
    const sessionId = 'ses_default_handoff';
    const order: string[] = [];
    const rpc = new ResumeEventRpc(false, () => order.push('resume'));

    const resume = rpc.resumeSessionWithHandoff(
      { id: sessionId },
      async () => {
        order.push('handoff');
      },
      () => order.push('snapshot-start'),
      () => order.push('snapshot-ready'),
    );

    expect(order).toEqual(['snapshot-start', 'resume']);
    await resume;
    expect(order).toEqual([
      'snapshot-start',
      'resume',
      'snapshot-ready',
      'handoff',
    ]);
  });

  it('registers a cold Session before resumeSessionWithHandoff invokes the host callback', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sessionId = 'ses_cold_handoff';
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const created = await harness.createSession({ id: sessionId, workDir });
      await created.close();

      const resumed = await harness.resumeSessionWithHandoff(
        { id: sessionId },
        async (session) => {
          expect(harness.sessions.get(sessionId)).toBe(session);
        },
      );

      expect(resumed).toBe(harness.sessions.get(sessionId));
    } finally {
      await harness.close();
    }
  });

  it.each(HANDOFF_HARNESS_CASES)(
    'keeps the successful cold Session live when a concurrent $engine handoff rejects',
    async ({ engine, createHarness }) => {
      const homeDir = await makeTempDir();
      const workDir = await makeTempDir();
      const sessionId = `ses_concurrent_${engine}_handoff`;
      const harness = createHarness({ identity: TEST_IDENTITY, homeDir });
      const successfulHandoffReturned = createSignal();
      const handoffError = new Error(`${engine} concurrent handoff rejected`);

      const created = await harness.createSession({ id: sessionId, workDir });
      await created.close();

      const successfulResume = harness.resumeSessionWithHandoff(
        { id: ` ${sessionId} ` },
        async () => undefined,
      );
      const rejectedResume = harness.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          await successfulHandoffReturned.promise;
          throw handoffError;
        },
      );
      void rejectedResume.catch(() => undefined);

      try {
        const successfulSession = await successfulResume;
        successfulHandoffReturned.fire();
        await expect(rejectedResume).rejects.toThrow(handoffError.message);

        expect(harness.getSession(sessionId)).toBe(successfulSession);
        await expect(successfulSession.getContext()).resolves.toMatchObject({
          history: [],
        });
      } finally {
        successfulHandoffReturned.fire();
        await Promise.allSettled([successfulResume, rejectedResume]);
        await harness.close();
      }
    },
  );

  it('keeps a successful direct v1 cold handoff live when the next handoff rejects', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sessionId = 'ses_direct_concurrent_v1_handoff';
    const rpc = new SDKRpcClient({ identity: TEST_IDENTITY, homeDir });
    const handoffError = new Error('direct v1 concurrent handoff rejected');

    await rpc.createSession({ id: sessionId, workDir });
    await rpc.closeSession({ sessionId });

    let successfulResume!: ReturnType<SDKRpcClient['resumeSessionWithHandoff']>;
    successfulResume = rpc.resumeSessionWithHandoff(
      { id: sessionId },
      async () => undefined,
    );
    const rejectedResume = rpc.resumeSessionWithHandoff(
      { id: sessionId },
      async () => {
        await successfulResume;
        throw handoffError;
      },
    );
    void rejectedResume.catch(() => undefined);

    try {
      await expect(successfulResume).resolves.toMatchObject({ id: sessionId });
      await expect(rejectedResume).rejects.toBe(handoffError);
      expect(rpc.core.sessions.has(sessionId)).toBe(true);

      await expect(
        rpc.resumeSessionWithHandoff(
          { id: ` ${sessionId} ` },
          async () => undefined,
        ),
      ).resolves.toMatchObject({ id: sessionId });
      expect(rpc.core.sessions.has(sessionId)).toBe(true);
    } finally {
      await Promise.allSettled([successfulResume, rejectedResume]);
      await rpc.closeSession({ sessionId });
      await rpc.close();
    }
  });

  it('serializes an ordinary v2 resume with a rejecting handoff resume', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sessionId = 'ses_v2_ordinary_and_handoff_resume';
    const harness = createKimiHarnessV2({ identity: TEST_IDENTITY, homeDir });
    const handoffError = new Error('v2 mixed resume handoff rejected');

    const created = await harness.createSession({ id: sessionId, workDir });
    await created.close();

    const ordinaryResume = harness.resumeSession({ id: ` ${sessionId} ` });
    const rejectedResume = harness.resumeSessionWithHandoff(
      { id: sessionId },
      async () => {
        await ordinaryResume;
        throw handoffError;
      },
    );
    void rejectedResume.catch(() => undefined);

    try {
      const session = await ordinaryResume;
      await expect(rejectedResume).rejects.toBe(handoffError);
      expect(harness.getSession(sessionId)).toBe(session);
      await expect(session.getContext()).resolves.toMatchObject({ history: [] });

      await expect(
        harness.resumeSessionWithHandoff(
          { id: sessionId },
          async () => undefined,
        ),
      ).resolves.toBe(session);
    } finally {
      await Promise.allSettled([ordinaryResume, rejectedResume]);
      await harness.close();
    }
  });

  it('preserves a successful wrapper interaction handler when a concurrent handoff rejects', async () => {
    const sessionId = 'ses_concurrent_handoff_handler';
    const firstResumeReady = createSignal();
    const successfulHandoffReturned = createSignal();
    const rpc = new DelayedFirstRollbackOwningHandoffRpc(
      resumedSummary(sessionId),
      firstResumeReady.promise,
    );
    const harness = makeStubHarness(rpc);
    const handoffError = new Error('concurrent handoff rejected');
    let releaseApprovalHandler: (() => void) | undefined;

    const successfulResume = harness.resumeSessionWithHandoff(
      { id: ` ${sessionId} ` },
      async (session) => {
        releaseApprovalHandler = session.registerApprovalHandler(
          () => ({ decision: 'approved' }),
        );
      },
    );
    const rejectedResume = harness.resumeSessionWithHandoff(
      { id: sessionId },
      async () => {
        await successfulHandoffReturned.promise;
        throw handoffError;
      },
    );
    void rejectedResume.catch(() => undefined);
    firstResumeReady.fire();

    try {
      const successfulSession = await successfulResume;
      successfulHandoffReturned.fire();
      await expect(rejectedResume).rejects.toThrow(handoffError.message);

      expect(harness.getSession(sessionId)).toBe(successfulSession);
      await expect(
        rpc.requestApproval({
          sessionId,
          agentId: 'main',
          toolCallId: 'tool-concurrent-handoff',
          toolName: 'Bash',
          action: 'run command',
          display: { kind: 'command', command: 'echo ready' },
        }),
      ).resolves.toEqual({ decision: 'approved' });
    } finally {
      firstResumeReady.fire();
      successfulHandoffReturned.fire();
      await Promise.allSettled([successfulResume, rejectedResume]);
      releaseApprovalHandler?.();
      await harness.close();
    }
  });

  it('runs a later handoff after an earlier handoff rejects', async () => {
    const sessionId = 'ses_handoff_after_rejection';
    const rpc = new RollbackOwningHandoffRpc(resumedSummary(sessionId));
    const harness = makeStubHarness(rpc);

    try {
      await expect(
        harness.resumeSessionWithHandoff(
          { id: sessionId },
          async () => {
            throw new Error('first handoff rejected');
          },
        ),
      ).rejects.toThrow('first handoff rejected');

      const resumed = await harness.resumeSessionWithHandoff(
        { id: sessionId },
        async () => undefined,
      );

      expect(harness.getSession(sessionId)).toBe(resumed);
    } finally {
      await harness.close();
    }
  });

  it('calls snapshot-start once before the v1 cold handoff callback', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sessionId = 'ses_v1_snapshot_start';
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const order: string[] = [];

    try {
      const created = await harness.createSession({ id: sessionId, workDir });
      await created.close();

      await harness.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          order.push('handoff');
        },
        () => order.push('snapshot-start'),
        () => order.push('snapshot-ready'),
      );

      expect(order).toEqual(['snapshot-start', 'snapshot-ready', 'handoff']);
    } finally {
      await harness.close();
    }
  });

  it('refreshes an active Session snapshot before resumeSessionWithHandoff invokes the host callback', async () => {
    const sessionId = 'ses_active_handoff';
    const summary: ResumedSessionSummary = {
      ...resumedSummary(sessionId),
      warning: 'Recovered a partial replay.',
    };
    const harness = makeStubHarness(new HandoffRpc(summary));
    try {
      const active = await harness.createSession({ id: sessionId, workDir: '/tmp/work' });

      const resumed = await harness.resumeSessionWithHandoff(
        { id: sessionId },
        async (session) => {
          expect(session.getResumeState()?.warning).toBe('Recovered a partial replay.');
        },
      );

      expect(resumed).toBe(active);
    } finally {
      await harness.close();
    }
  });

  it('forwards snapshot-start once before an active handoff callback', async () => {
    const sessionId = 'ses_active_snapshot_start';
    const harness = makeStubHarness(new HandoffRpc(resumedSummary(sessionId)));
    const order: string[] = [];

    try {
      await harness.createSession({ id: sessionId, workDir: '/tmp/work' });

      await harness.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          order.push('handoff');
        },
        () => order.push('snapshot-start'),
        () => order.push('snapshot-ready'),
      );

      expect(order).toEqual(['snapshot-start', 'snapshot-ready', 'handoff']);
    } finally {
      await harness.close();
    }
  });

  it('removes a cold Session when the resumeSessionWithHandoff callback rejects', async () => {
    const sessionId = 'ses_rejected_handoff';
    const rpc = new HandoffRpc(resumedSummary(sessionId));
    const harness = makeStubHarness(rpc);

    await expect(
      harness.resumeSessionWithHandoff(
        { id: sessionId },
        async () => {
          throw new Error('handoff rejected');
        },
      ),
    ).rejects.toThrow('handoff rejected');

    expect(harness.sessions.has(sessionId)).toBe(false);
    expect(rpc.closeCalls).toBe(1);
    await harness.close();
  });

  it('discards only the wrapper when the transport already rolled back a failed handoff', async () => {
    const sessionId = 'ses_transport_owned_rollback';
    const rpc = new RollbackOwningHandoffRpc(resumedSummary(sessionId));
    const harness = makeStubHarness(rpc);
    let handedOff: Session | undefined;

    await expect(
      harness.resumeSessionWithHandoff(
        { id: sessionId },
        async (session) => {
          handedOff = session;
          throw new Error('handoff rejected after engine rollback');
        },
      ),
    ).rejects.toThrow('handoff rejected after engine rollback');

    expect(rpc.closeCalls).toBe(0);
    expect(harness.sessions.has(sessionId)).toBe(false);
    expect(() => handedOff?.getResumeState()).toThrow('Session is closed');
    await harness.close();
  });

  it('filters session events before resume resolves and then stays live', async () => {
    const sessionId = 'ses_resume_event_relay';
    const rpc = new ResumeEventRpc();
    const harness = makeStubHarness(rpc);
    const events: Event[] = [];
    const otherSessionEvents: Event[] = [];
    const unsubscribe = harness.onSessionEvent(sessionId, (event) => events.push(event));
    const unsubscribeOther = harness.onSessionEvent('ses_other', (event) => {
      otherSessionEvents.push(event);
    });

    await harness.resumeSession({ id: sessionId });
    rpc.receiveEvent({
      type: 'assistant.delta',
      sessionId,
      agentId: 'main',
      turnId: 8,
      delta: 'Live after resume.',
    });

    expect(events.map((event) => event.type)).toEqual([
      'cron.fired',
      'turn.started',
      'assistant.delta',
      'turn.ended',
      'assistant.delta',
    ]);
    expect(otherSessionEvents).toEqual([]);
    expect(events.filter((event) => event.type === 'cron.fired')).toHaveLength(1);
    expect(rpc.listenerCount).toBe(2);

    unsubscribe();
    unsubscribeOther();
    expect(rpc.listenerCount).toBe(0);
    await harness.close();
  });

  it('keeps pre-resume subscription ownership explicit when resume rejects', async () => {
    const rpc = new ResumeEventRpc(true);
    const harness = makeStubHarness(rpc);
    const unsubscribe = harness.onSessionEvent(
      'ses_resume_event_rejection',
      () => undefined,
    );

    await expect(
      harness.resumeSession({ id: 'ses_resume_event_rejection' }),
    ).rejects.toThrow('resume failed');

    expect(rpc.listenerCount).toBe(1);
    unsubscribe();
    expect(rpc.listenerCount).toBe(0);
    await harness.close();
  });

  it('releases only the exact interaction handler registration owner', async () => {
    const rpc = new ResumeEventRpc();
    const sessionId = 'ses_interaction_registration_owner';
    const approvalHandler: ApprovalHandler = () => ({ decision: 'approved' });
    const questionHandler: QuestionHandler = () => ({ 'Continue?': 'Yes' });
    const releaseApprovalFirst = rpc.registerApprovalHandler(
      sessionId,
      approvalHandler,
    );
    const releaseApprovalSecond = rpc.registerApprovalHandler(
      sessionId,
      approvalHandler,
    );
    const releaseQuestionFirst = rpc.registerQuestionHandler(
      sessionId,
      questionHandler,
    );
    const releaseQuestionSecond = rpc.registerQuestionHandler(
      sessionId,
      questionHandler,
    );

    releaseApprovalFirst();
    releaseQuestionFirst();
    await expect(
      rpc.requestApproval({
        sessionId,
        agentId: 'main',
        toolCallId: 'tool-registration-owner',
        toolName: 'Bash',
        action: 'run command',
        display: { kind: 'command', command: 'echo ready' },
      }),
    ).resolves.toEqual({ decision: 'approved' });
    await expect(
      rpc.requestQuestion({
        sessionId,
        agentId: 'main',
        toolCallId: 'question-registration-owner',
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }],
          },
        ],
      }),
    ).resolves.toEqual({ 'Continue?': 'Yes' });

    rpc.setApprovalHandler(sessionId, approvalHandler);
    rpc.setQuestionHandler(sessionId, questionHandler);
    releaseApprovalSecond();
    releaseQuestionSecond();
    await expect(
      rpc.requestApproval({
        sessionId,
        agentId: 'main',
        toolCallId: 'tool-setter-owner',
        toolName: 'Bash',
        action: 'run command',
        display: { kind: 'command', command: 'echo ready' },
      }),
    ).resolves.toEqual({ decision: 'approved' });
    await expect(
      rpc.requestQuestion({
        sessionId,
        agentId: 'main',
        toolCallId: 'question-setter-owner',
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }],
          },
        ],
      }),
    ).resolves.toEqual({ 'Continue?': 'Yes' });
  });

  it('rejects an active session resume when the requested profile differs from its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_active_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'agent' }),
      ).rejects.toThrow(
        'agent is already bound to profile "reviewer"; cannot switch to "agent" in this session',
      );
    } finally {
      await harness.close();
    }
  });

  it('returns the active session when the requested profile matches its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_matching_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'reviewer' }),
      ).resolves.toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('rejects a persisted session resume when the requested profile differs from its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_persisted_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });
      await session.close();

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'agent' }),
      ).rejects.toThrow(
        'agent is already bound to profile "reviewer"; cannot switch to "agent" in this session',
      );
    } finally {
      await harness.close();
    }
  });
});

function coreSessionIds(harness: KimiHarness): readonly string[] {
  const core = (
    harness as unknown as {
      readonly rpc: { readonly core: { readonly sessions: ReadonlyMap<string, unknown> } };
    }
  ).rpc.core;
  return Array.from(core.sessions.keys()).toSorted();
}
