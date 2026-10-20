import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { shallowRef, useExpose, useFire, useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type ToolCall,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester, TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';

import { ConfigRef, createConfig, type ConfigStore } from '#/features/config/index';
import {
  createExternalHooks,
  createExternalHooksRunner,
  ExternalHooksRunnerRef,
  useHookSource,
  type ExternalHooksRunner,
  type HookDef,
} from '#/features/externalHooks/index';
import { indexHooks, runMatchedHooks } from '#/features/externalHooks/internal/match';
import { runHook } from '#/features/externalHooks/internal/run';
import type { OsHost, OsProcess, OsSpawnOptions } from '#/features/os/index';
import { ProfileCatalogRef, type AgentProfile } from '#/features/profiles/index';
import {
  agentCaps,
  createAgentRuntime,
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

interface FakeProcSpec {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: OsSpawnOptions;
  stdin?: string;
}

function fakeOsProcess(spec: FakeProcSpec, onStdin: (text: string) => void): OsProcess {
  let stdinText = '';
  let killed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (spec.hang !== true) release();
  const encoder = new TextEncoder();
  const streamOf = (text: string): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: async function* () {
      await gate;
      if (text.length > 0) yield encoder.encode(text);
    },
  });
  return {
    pid: 4242,
    get exitCode() {
      return killed ? -1 : (spec.exitCode ?? 0);
    },
    stdin: {
      write: (data) => {
        stdinText += typeof data === 'string' ? data : new TextDecoder().decode(data);
      },
      end: () => {
        onStdin(stdinText);
      },
    },
    stdout: streamOf(spec.stdout ?? ''),
    stderr: streamOf(spec.stderr ?? ''),
    wait: async () => {
      await gate;
      return killed ? -1 : (spec.exitCode ?? 0);
    },
    kill: async () => {
      if (killed) return;
      killed = true;
      release();
    },
    dispose: () => {},
  };
}

function createFakeHost(handler: (command: string) => FakeProcSpec): {
  host: OsHost;
  spawns: SpawnRecord[];
} {
  const spawns: SpawnRecord[] = [];
  const host: OsHost = {
    process: {
      spawn: async (command, args = [], options) => {
        const record: SpawnRecord = { command, args, options };
        spawns.push(record);
        return fakeOsProcess(handler(args.at(-1) ?? command), (text) => {
          record.stdin = text;
        });
      },
    },
    fs: {} as unknown as OsHost['fs'],
    environment: {} as unknown as OsHost['environment'],
  };
  return { host, spawns };
}

function spawnPayload(record: SpawnRecord): Record<string, unknown> {
  if (record.stdin === undefined) throw new Error(`hook '${record.args[1] ?? ''}' saw no stdin`);
  return JSON.parse(record.stdin) as Record<string, unknown>;
}

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(steps: readonly ScriptStep[] = []): LoopLlmRequester {
  const pending = [...steps];
  let seq = 0;
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const out = pending.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        return textOutcome('', [
          {
            type: 'function',
            id: `call-${(seq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        ]);
      }
      return textOutcome(out.text);
    },
  };
  return self;
}

interface ExecutedTool {
  readonly name: string;
  readonly arguments: string | null;
}

function bindTestTools(executed: ExecutedTool[]): Feature<void> {
  return createFeature('test-tools', {
    agent() {
      for (const name of ['Bash', 'Write']) {
        useAgentTools({
          name,
          description: `${name} tool`,
          parameters: { type: 'object', properties: {} },
          execute: async ({ toolCall }) => {
            executed.push({ name: toolCall.name, arguments: toolCall.arguments });
            return { content: [{ type: 'text' as const, text: `${name} ok` }] };
          },
        });
      }
    },
  });
}

function bindErrorTool(): Feature<void> {
  return createFeature('test-error-tool', {
    agent() {
      useAgentTools({
        name: 'Boom',
        description: 'Boom tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'boom' }], isError: true as const }),
      });
    },
  });
}

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const tmpDirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (disposers.length > 0) await disposers.pop()!();
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Capture {
  config?: Readonly<ShallowRef<ConfigStore | undefined>>;
  runner?: Readonly<ShallowRef<ExternalHooksRunner | undefined>>;
}

function probeCapture(): { readonly feature: Feature<void>; capture: Capture } {
  const capture: Capture = {};
  const feature = createFeature('test-probe', {
    app() {
      capture.config = useInject(ConfigRef);
      capture.runner = useInject(ExternalHooksRunnerRef);
    },
  });
  return { feature, capture };
}

interface TestApp {
  readonly harness: Harness;
  readonly session: Session;
  readonly main: Agent;
  readonly workDir: string;
  readonly capture: Capture;
  readonly runTurn: (text?: string, meta?: UserMeta) => Promise<TurnOutcome>;
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

async function startApp(options?: {
  host?: OsHost;
  requester?: LoopLlmRequester;
  executed?: ExecutedTool[];
  withConfig?: boolean;
  clientType?: string;
  extraFeatures?: Feature<void>[];
}): Promise<TestApp> {
  const workDir = await mkdtemp(join(tmpdir(), 'external-hooks-'));
  tmpDirs.push(workDir);
  const probe = probeCapture();
  const harness = createHarness({ space: memoryHarnessSpace() });
  if (options?.withConfig !== false) harness.app.features.add(createConfig({}));
  harness.app.features.add(
    createExternalHooks({
      host: options?.host,
      workDir,
      clientType: options?.clientType ?? 'test_client',
    }),
  );
  if (options?.executed !== undefined) harness.app.features.add(bindTestTools(options.executed));
  harness.app.features.add(probe.feature);
  for (const feature of options?.extraFeatures ?? []) harness.app.features.add(feature);
  await tick();
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, options?.requester ?? createMockRequester());
  await tick();
  disposers.push(async () => {
    await harness.close();
  });
  const runTurn = (text = 'go', meta?: UserMeta): Promise<TurnOutcome> =>
    main.loop.runTurn(user(text, meta));
  return { harness, session, main, workDir, capture: probe.capture, runTurn };
}

async function toolResultTexts(agent: Agent): Promise<string[]> {
  await agent.flush();
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

async function userTexts(agent: Agent): Promise<string[]> {
  await agent.flush();
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

interface SessionTestApp {
  readonly harness: Harness;
  readonly workDir: string;
  readonly capture: Capture;
}

function stubProfileCatalog(name: string): Feature<void> {
  return createFeature('test-profiles', {
    app() {
      useExpose(ProfileCatalogRef, {
        ready: Promise.resolve(),
        reload: async () => {},
        list: () => [],
        get: () => undefined,
        getDefault: () => ({ name }) as unknown as AgentProfile,
        inspect: () => undefined,
      });
    },
  });
}

async function startSessionApp(options: {
  host: OsHost;
  hooks: readonly HookDef[];
  model?: string;
  profile?: string;
}): Promise<SessionTestApp> {
  const workDir = await mkdtemp(join(tmpdir(), 'external-hooks-'));
  tmpDirs.push(workDir);
  const probe = probeCapture();
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(createConfig({}));
  harness.app.features.add(createExternalHooks({ host: options.host, workDir, clientType: 'test_client' }));
  if (options.profile !== undefined) harness.app.features.add(stubProfileCatalog(options.profile));
  harness.app.features.add(probe.feature);
  await tick();
  const config = probe.capture.config?.value;
  if (config === undefined) throw new Error('config face was not exposed');
  await config.set('hooks', options.hooks, 'memory');
  if (options.model !== undefined) {
    await config.set('defaultModel', options.model, 'memory');
  }
  disposers.push(async () => {
    await harness.close();
  });
  return { harness, workDir, capture: probe.capture };
}

function createGatedHost(): { host: OsHost; spawns: SpawnRecord[]; releaseAll: () => void } {
  const spawns: SpawnRecord[] = [];
  const releases: Array<() => void> = [];
  const host: OsHost = {
    process: {
      spawn: async (command, args = [], options) => {
        const record: SpawnRecord = { command, args, options };
        spawns.push(record);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        releases.push(release);
        const encoder = new TextEncoder();
        const streamOf = (text: string): AsyncIterable<Uint8Array> => ({
          [Symbol.asyncIterator]: async function* () {
            await gate;
            if (text.length > 0) yield encoder.encode(text);
          },
        });
        return {
          pid: 4242,
          exitCode: 0,
          stdin: {
            write: (data: string | Uint8Array) => {
              record.stdin = `${record.stdin ?? ''}${typeof data === 'string' ? data : new TextDecoder().decode(data)}`;
            },
            end: () => {},
          },
          stdout: streamOf(''),
          stderr: streamOf(''),
          wait: async () => {
            await gate;
            return 0;
          },
          kill: async () => {},
          dispose: () => {},
        };
      },
    },
    fs: {} as unknown as OsHost['fs'],
    environment: {} as unknown as OsHost['environment'],
  };
  return {
    host,
    spawns,
    releaseAll: () => {
      for (const release of releases) release();
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runHook', () => {
  it('returns allow on exit 0, captures stdout, and spawns through the posix shell', async () => {
    const { host, spawns } = createFakeHost(() => ({ stdout: 'ok\n' }));
    const result = await runHook(host.process, 'echo ok', { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.stdout).toBe('ok\n');
    expect(spawns[0]).toMatchObject({ command: '/bin/sh', args: ['-c', 'echo ok'] });
  });

  it('parses a stdout JSON message into the result message', async () => {
    const { host } = createFakeHost(() => ({ stdout: JSON.stringify({ message: 'hook says hi' }) }));
    const result = await runHook(host.process, 'noop', {}, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('maps exit code 2 to a block with the trimmed stderr as reason', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 2, stderr: 'blocked\n' }));
    const result = await runHook(host.process, 'noop', {}, { timeout: 5 });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 1 }));
    const result = await runHook(host.process, 'noop', {}, { timeout: 5 });
    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut when the hook exceeds the timeout', async () => {
    const { host } = createFakeHost(() => ({ hang: true }));
    const startedAt = Date.now();
    const result = await runHook(host.process, 'noop', {}, { timeout: 0.05 });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('maps a stdout JSON permissionDecision=deny to a block with the supplied reason', async () => {
    const { host } = createFakeHost(() => ({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'use rg' },
      }),
    }));
    const result = await runHook(host.process, 'noop', {}, { timeout: 5 });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('writes the input payload to the hook stdin as JSON', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    await runHook(host.process, 'noop', { tool_name: 'Write' }, { timeout: 5 });
    expect(JSON.parse(spawns[0]!.stdin!)).toEqual({ tool_name: 'Write' });
  });

  it('returns allow with stderr when the spawn itself fails', async () => {
    const { host } = createFakeHost(() => {
      throw new Error('spawn blew up');
    });
    const result = await runHook(host.process, 'noop', {}, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.stderr).toContain('spawn blew up');
  });

  it('honors a custom shell override', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    await runHook(host.process, 'noop', {}, { timeout: 5, shell: '/bin/zsh' });
    expect(spawns[0]).toMatchObject({ command: '/bin/zsh', args: ['-c', 'noop'] });
  });
});

describe('runMatchedHooks', () => {
  it('runs hooks whose matcher regex hits and skips the rest', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 0 }));
    const hooks: HookDef[] = [
      { event: 'PreToolUse', matcher: 'Bash|Write', command: 'a' },
      { event: 'PreToolUse', matcher: 'Read', command: 'b' },
    ];
    const results = await runMatchedHooks(host.process, indexHooks(hooks), 'PreToolUse', {
      matcherValue: 'Bash',
    });
    expect(results).toHaveLength(1);
    const misses = await runMatchedHooks(host.process, indexHooks(hooks), 'PreToolUse', {
      matcherValue: 'Grep',
    });
    expect(misses).toHaveLength(0);
  });

  it('silently skips hooks whose matcher is not a valid regex and treats empty as catch-all', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 0 }));
    const hooks: HookDef[] = [
      { event: 'PreToolUse', matcher: '[invalid', command: 'a' },
      { event: 'PreToolUse', matcher: '', command: 'b' },
    ];
    const results = await runMatchedHooks(host.process, indexHooks(hooks), 'PreToolUse', {
      matcherValue: 'anything',
    });
    expect(results).toHaveLength(1);
  });

  it('matches ContentPart matcher values against their joined text', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 0 }));
    const hooks: HookDef[] = [{ event: 'UserPromptQueued', matcher: 'hello world', command: 'a' }];
    const results = await runMatchedHooks(host.process, indexHooks(hooks), 'UserPromptQueued', {
      matcherValue: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', source: { kind: 'url', url: 'file:///tmp/a.png' } },
        { type: 'text', text: 'world' },
      ],
    });
    expect(results).toHaveLength(1);
  });

  it('dedupes hooks by cwd and command pair only', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const hooks: HookDef[] = [
      { event: 'Stop', command: 'same' },
      { event: 'Stop', command: 'same' },
      { event: 'Stop', command: 'same', cwd: '/elsewhere' },
    ];
    const results = await runMatchedHooks(host.process, indexHooks(hooks), 'Stop', {});
    expect(results).toHaveLength(2);
    expect(spawns.map((spawn) => spawn.options?.cwd)).toEqual([undefined, '/elsewhere']);
  });

  it('serializes camelCase inputData as snake_case with the base fields', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const hooks: HookDef[] = [{ event: 'PreToolUse', command: 'noop' }];
    await runMatchedHooks(host.process, indexHooks(hooks), 'PreToolUse', {
      matcherValue: 'Bash',
      sessionId: 'ses_1',
      cwd: '/repo',
      inputData: { toolName: 'Bash', toolCallId: 'call_1', clientType: 'test_client' },
    });
    expect(JSON.parse(spawns[0]!.stdin!)).toEqual({
      hook_event_name: 'PreToolUse',
      session_id: 'ses_1',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_call_id: 'call_1',
      client_type: 'test_client',
    });
  });

  it('forwards per-hook cwd and env overrides to the spawn options', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const hooks: HookDef[] = [
      { event: 'Stop', command: 'noop', cwd: '/other', env: { FOO: 'bar' } },
    ];
    await runMatchedHooks(host.process, indexHooks(hooks), 'Stop', { cwd: '/repo' });
    expect(spawns[0]?.options).toMatchObject({ cwd: '/other', env: { FOO: 'bar' } });
  });
});

describe('createExternalHooksRunner', () => {
  it('rebuilds the reactive index when the hooks source changes', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 0 }));
    const hooksRef = shallowRef<readonly HookDef[]>([{ event: 'PreToolUse', command: 'a' }]);
    const runner = createExternalHooksRunner({
      host,
      hooks: () => hooksRef.value,
      workDir: '/wd',
      clientType: 'test_client',
    });
    expect(runner.hasHooksFor('PreToolUse')).toBe(true);
    expect(runner.hasHooksFor('Stop')).toBe(false);
    hooksRef.value = [...hooksRef.value, { event: 'Stop', command: 'b' }];
    expect(runner.hasHooksFor('Stop')).toBe(true);
    expect(runner.summary).toEqual({ PreToolUse: 1, Stop: 1 });
  });

  it('fills cwd and client_type defaults and lets the caller override them', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const runner = createExternalHooksRunner({
      host,
      hooks: () => [{ event: 'SessionOpened', command: 'noop' }],
      workDir: '/wd',
      clientType: 'test_client',
    });
    await runner.trigger('SessionOpened', { sessionId: 's1' });
    expect(JSON.parse(spawns[0]!.stdin!)).toMatchObject({
      cwd: '/wd',
      client_type: 'test_client',
    });
    await runner.trigger('SessionOpened', { sessionId: 's1', inputData: { clientType: 'custom' } });
    expect(JSON.parse(spawns[1]!.stdin!)).toMatchObject({ client_type: 'custom' });
  });

  it('exposes triggerBlock with the default reason fallback', async () => {
    const { host } = createFakeHost((command) =>
      command === 'block-empty' ? { exitCode: 2 } : { exitCode: 2, stderr: 'blocked' },
    );
    const runner = createExternalHooksRunner({
      host,
      hooks: () => [
        { event: 'PreToolUse', matcher: 'Read', command: 'block-reason' },
        { event: 'PreToolUse', matcher: 'Grep', command: 'block-empty' },
      ],
    });
    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Read' }),
    ).resolves.toEqual({ block: true, reason: 'blocked' });
    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Grep' }),
    ).resolves.toEqual({ block: true, reason: 'Blocked by PreToolUse hook' });
  });

  it('fails open when the trigger input preparation throws', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const runner = createExternalHooksRunner({
      host,
      hooks: () => [{ event: 'PreToolUse', command: 'noop' }],
    });
    const inputData: Record<string, unknown> = {};
    Object.defineProperty(inputData, 'broken', {
      enumerable: true,
      get() {
        throw new Error('broken input');
      },
    });
    await expect(runner.trigger('PreToolUse', { inputData })).resolves.toEqual([]);
    await expect(runner.triggerBlock('PreToolUse', { inputData })).resolves.toBeUndefined();
    expect(spawns).toHaveLength(0);
  });
});

describe('externalHooks feature', () => {
  it('registers the hooks config section and flips hasHooksFor on config changes', async () => {
    const { host } = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host });
    const runner = t.capture.runner?.value;
    expect(runner?.hasHooksFor('PreToolUse')).toBe(false);
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'PreToolUse', matcher: 'Bash', command: 'gate' }], 'memory');
    expect(runner?.hasHooksFor('PreToolUse')).toBe(true);
    expect(runner?.summary).toEqual({ PreToolUse: 1 });
    await expect(
      config?.set('hooks', [{ event: 'Nope', command: 'x' } as unknown as HookDef], 'memory'),
    ).rejects.toThrow();
  });

  it('keeps the runner usable with hooks empty when the config feature is absent', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host, withConfig: false });
    const runner = t.capture.runner?.value;
    expect(runner?.hasHooksFor('PreToolUse')).toBe(false);
    await expect(runner?.trigger('PreToolUse', { matcherValue: 'Bash' })).resolves.toEqual([]);
    expect(spawns).toHaveLength(0);
  });

  it('no-ops every slot when the host is not provided', async () => {
    const executed: ExecutedTool[] = [];
    const t = await startApp({
      requester: createMockRequester([{ toolCall: { name: 'Bash', arguments: '{}' } }]),
      executed,
    });
    expect(t.capture.runner?.value).toBeUndefined();
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'PreToolUse', command: 'gate' }], 'memory');
    expect(config?.get('hooks')).toEqual([{ event: 'PreToolUse', command: 'gate' }]);
    const outcome = await t.runTurn('run bash');
    expect(outcome.type).toBe('done');
    expect(executed).toHaveLength(1);
  });

  it('denies a tool through a PreToolUse hook exit 2 and lets it run when unmatched', async () => {
    const executed: ExecutedTool[] = [];
    const fake = createFakeHost((command) =>
      command === 'deny bash' ? { exitCode: 2, stderr: 'no bash today\n' } : { exitCode: 0 },
    );
    const t = await startApp({
      host: fake.host,
      requester: createMockRequester([
        { toolCall: { name: 'Bash', arguments: '{"command":"ls -la"}' } },
        { text: 'first turn done' },
        { toolCall: { name: 'Bash', arguments: '{"command":"ls -la"}' } },
      ]),
      executed,
    });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'PreToolUse', matcher: 'Bash', command: 'deny bash' }], 'memory');
    await t.runTurn('run bash');
    expect(executed).toHaveLength(0);
    expect((await toolResultTexts(t.main)).join('\n')).toContain('no bash today');
    const denySpawn = fake.spawns.find((spawn) => spawn.args[1] === 'deny bash');
    expect(denySpawn).toBeDefined();
    expect(JSON.parse(denySpawn!.stdin!)).toMatchObject({
      hook_event_name: 'PreToolUse',
      session_id: 'sess',
      client_type: 'test_client',
      cwd: t.workDir,
      tool_name: 'Bash',
      tool_call_id: 'call-1',
      tool_input: { command: 'ls -la' },
    });
    await config?.set('hooks', [{ event: 'PreToolUse', matcher: 'Write', command: 'deny write' }], 'memory');
    await t.runTurn('run bash again');
    expect(executed).toHaveLength(1);
  });

  it('fires PostToolUse on success and PostToolUseFailure on an isError result', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({
      host: fake.host,
      requester: createMockRequester([
        { toolCall: { name: 'Bash', arguments: '{"command":"ls"}' } },
        { toolCall: { name: 'Boom', arguments: '{}' } },
        { text: 'done' },
      ]),
      executed: [],
      extraFeatures: [bindErrorTool()],
    });
    const config = t.capture.config?.value;
    await config?.set(
      'hooks',
      [
        { event: 'PostToolUse', command: 'post ok' },
        { event: 'PostToolUseFailure', command: 'post fail' },
      ],
      'memory',
    );
    await t.runTurn('run tools');
    await waitFor(
      () =>
        fake.spawns.some((spawn) => spawn.args[1] === 'post ok') &&
        fake.spawns.some((spawn) => spawn.args[1] === 'post fail'),
    );
    const ok = fake.spawns.find((spawn) => spawn.args[1] === 'post ok')!;
    expect(spawnPayload(ok)).toMatchObject({
      hook_event_name: 'PostToolUse',
      session_id: 'sess',
      tool_name: 'Bash',
      tool_call_id: 'call-1',
      tool_input: { command: 'ls' },
      tool_output: 'Bash ok',
    });
    expect('error' in spawnPayload(ok)).toBe(false);
    const fail = fake.spawns.find((spawn) => spawn.args[1] === 'post fail')!;
    expect(spawnPayload(fail)).toMatchObject({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Boom',
      tool_call_id: 'call-2',
      error: { message: 'boom' },
    });
    expect('tool_output' in spawnPayload(fail)).toBe(false);
  });

  it('appends UserPromptSubmit hook messages to the prompt as a hook_result part', async () => {
    const seen: string[] = [];
    const self: LoopLlmRequester = {
      with: () => self,
      request: (part) => part as unknown as LlmRequest,
      generate: async (rest) => {
        const messages = rest.content?.messages ?? [];
        const last = messages.at(-1);
        seen.push(last !== undefined && last.role === 'user' ? extractText(last) : '');
        return textOutcome('done');
      },
    };
    const fake = createFakeHost(() => ({ stdout: JSON.stringify({ message: 'hook note' }) }));
    const t = await startApp({ host: fake.host, requester: self });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'UserPromptSubmit', command: 'annotate' }], 'memory');
    const outcome = await t.runTurn('hello hook');
    expect(outcome.type).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('hello hook');
    expect(seen[0]).toContain('<hook_result hook_event="UserPromptSubmit">\nhook note\n</hook_result>');
    const spawn = fake.spawns.find((entry) => entry.args[1] === 'annotate')!;
    expect(spawnPayload(spawn)).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess',
      prompt: [{ type: 'text', text: 'hello hook' }],
      is_steer: false,
    });
  });

  it('blocks a prompt through a UserPromptSubmit hook exit 2 without calling the llm', async () => {
    let llmCalls = 0;
    const self: LoopLlmRequester = {
      with: () => self,
      request: (part) => part as unknown as LlmRequest,
      generate: async () => {
        llmCalls += 1;
        return textOutcome('done');
      },
    };
    const fake = createFakeHost(() => ({ exitCode: 2, stderr: 'no prompts\n' }));
    const t = await startApp({ host: fake.host, requester: self });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'UserPromptSubmit', command: 'gate prompt' }], 'memory');
    const outcome = await t.runTurn('blocked prompt');
    expect(llmCalls).toBe(0);
    expect(outcome).toEqual({
      type: 'blocked',
      at: 'step.starting',
      cause: { by: 'externalHooks', reason: 'user_prompt_submit', message: 'no prompts' },
    });
    expect(await userTexts(t.main)).toEqual(['blocked prompt']);
  });

  it('continues the turn with the Stop hook reason as a user message', async () => {
    const calls: string[][] = [];
    const self: LoopLlmRequester = {
      with: () => self,
      request: (part) => part as unknown as LlmRequest,
      generate: async (rest) => {
        const messages = rest.content?.messages ?? [];
        calls.push(
          messages.filter((message) => message.role === 'user').map((message) => extractText(message)),
        );
        return textOutcome('working');
      },
    };
    const fake = createFakeHost((command) =>
      command === 'stop gate' ? { exitCode: 2, stderr: 'keep going\n' } : { exitCode: 0 },
    );
    const t = await startApp({ host: fake.host, requester: self });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'Stop', command: 'stop gate' }], 'memory');
    const outcome = await t.runTurn('go');
    expect(outcome.type).toBe('done');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.at(-1)).toBe('keep going');
    expect(fake.spawns.filter((spawn) => spawn.args[1] === 'stop gate')).toHaveLength(1);
    expect(await userTexts(t.main)).toContain('keep going');
  });

  it('fires TurnStarted with the origin payload for displayable and named origins', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host: fake.host });
    await t.harness.app.update('sess', { title: 'My Session' });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'TurnStarted', command: 'rec turn' }], 'memory');
    await t.runTurn('hello hooks', { origin: { kind: 'cron_job' } });
    await waitFor(() => fake.spawns.some((spawn) => spawn.args[1] === 'rec turn'));
    const first = fake.spawns.find((spawn) => spawn.args[1] === 'rec turn')!;
    expect(spawnPayload(first)).toMatchObject({
      hook_event_name: 'TurnStarted',
      session_id: 'sess',
      client_type: 'test_client',
      origin_kind: 'cron_job',
      prompt: 'hello hooks',
      session_title: 'My Session',
    });
    expect('origin_name' in spawnPayload(first)).toBe(false);
    await t.runTurn('goal turn', {
      origin: { kind: 'system_trigger', name: 'goal' } as UserMeta['origin'],
    });
    await waitFor(
      () => fake.spawns.filter((spawn) => spawn.args[1] === 'rec turn').length === 2,
    );
    const second = fake.spawns.filter((spawn) => spawn.args[1] === 'rec turn')[1]!;
    expect(spawnPayload(second)).toMatchObject({
      origin_kind: 'system_trigger',
      origin_name: 'goal',
    });
    expect('prompt' in spawnPayload(second)).toBe(false);
  });

  it('fires StopFailure with the llm error payload on turn failure', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const failing: LoopLlmRequester = {
      with: () => failing,
      request: (part) => part as unknown as LlmRequest,
      generate: async () => {
        throw { kind: 'rate_limit', message: 'slow down' };
      },
    };
    const t = await startApp({ host: fake.host, requester: failing });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'StopFailure', command: 'rec fail' }], 'memory');
    const outcome = await t.runTurn('boom');
    expect(outcome.type).toBe('failed');
    await waitFor(() => fake.spawns.some((spawn) => spawn.args[1] === 'rec fail'));
    const spawn = fake.spawns.find((entry) => entry.args[1] === 'rec fail')!;
    expect(spawnPayload(spawn)).toMatchObject({
      hook_event_name: 'StopFailure',
      error_type: 'rate_limit',
      error_message: 'slow down',
    });
  });

  it('fires Interrupt with reason cancelled when the turn is aborted', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const hanging: LoopLlmRequester = {
      with: () => hanging,
      request: (part) => part as unknown as LlmRequest,
      generate: async () => {
        await new Promise<void>(() => {});
      },
    };
    const t = await startApp({ host: fake.host, requester: hanging });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'Interrupt', command: 'rec int' }], 'memory');
    const started = new Promise<void>((resolve) => {
      const off = t.main.loop.subscribe((event) => {
        if (event.type !== 'turn.started') return;
        off();
        resolve();
      });
    });
    const running = t.runTurn('long work');
    await started;
    t.main.loop.abort();
    const outcome = await running;
    expect(outcome.type).toBe('aborted');
    await waitFor(() => fake.spawns.some((spawn) => spawn.args[1] === 'rec int'));
    const spawn = fake.spawns.find((entry) => entry.args[1] === 'rec int')!;
    expect(spawnPayload(spawn)).toMatchObject({
      hook_event_name: 'Interrupt',
      reason: 'cancelled',
      turn_id: 0,
    });
  });

  it('fires UserPromptQueued with the prompt text and prompt id', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host: fake.host });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'UserPromptQueued', command: 'rec prompt' }], 'memory');
    await t.runTurn('queued text', { promptId: 'p-1' });
    await waitFor(() => fake.spawns.some((spawn) => spawn.args[1] === 'rec prompt'));
    const spawn = fake.spawns.find((entry) => entry.args[1] === 'rec prompt')!;
    expect(spawnPayload(spawn)).toMatchObject({
      hook_event_name: 'UserPromptQueued',
      prompt_id: 'p-1',
      prompt: 'queued text',
    });
  });

  it('fires SessionHeartbeat on the interval with title and uptime and gates on hooks', async () => {
    vi.useFakeTimers();
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host: fake.host });
    await t.harness.app.update('sess', { title: 'Heart Session' });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'SessionHeartbeat', command: 'rec hb' }], 'memory');
    await vi.advanceTimersByTimeAsync(60_000);
    const beats = (): SpawnRecord[] => fake.spawns.filter((spawn) => spawn.args[1] === 'rec hb');
    expect(beats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats()).toHaveLength(2);
    expect(spawnPayload(beats()[0]!)).toMatchObject({
      hook_event_name: 'SessionHeartbeat',
      session_id: 'sess',
      session_title: 'Heart Session',
    });
    expect(spawnPayload(beats()[0]!)['uptime_ms']).toBeGreaterThanOrEqual(60_000);
  });

  it('skips SessionHeartbeat ticks while no hook is registered for the event', async () => {
    vi.useFakeTimers();
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    await startApp({ host: fake.host });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fake.spawns).toHaveLength(0);
  });

  it('translates task.started node events into TaskStarted hook payloads', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    let fireProbe: ((event: { type: string } & Record<string, unknown>) => void) | undefined;
    const probe = createFeature('task-probe', {
      agent() {
        const fire = useFire();
        fireProbe = fire;
      },
    });
    const t = await startApp({ host: fake.host, extraFeatures: [probe] });
    const config = t.capture.config?.value;
    await config?.set('hooks', [{ event: 'TaskStarted', command: 'rec task' }], 'memory');
    fireProbe?.({
      type: 'task.started',
      record: {
        taskId: 'task-1',
        toolName: 'Bash',
        description: 'npm test',
        status: 'running',
        startedAt: 123,
      },
    });
    await waitFor(() => fake.spawns.some((spawn) => spawn.args[1] === 'rec task'));
    const spawn = fake.spawns.find((entry) => entry.args[1] === 'rec task')!;
    expect(spawnPayload(spawn)).toMatchObject({
      hook_event_name: 'TaskStarted',
      task_id: 'task-1',
      kind: 'Bash',
      description: 'npm test',
      status: 'running',
      detached: true,
      started_at: 123,
      session_id: 'sess',
    });
  });

  it('translates permission approval node events into PermissionRequest and PermissionResult payloads', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    let fireProbe: ((event: { type: string } & Record<string, unknown>) => void) | undefined;
    const probe = createFeature('permission-probe', {
      agent() {
        const fire = useFire();
        fireProbe = fire;
      },
    });
    const t = await startApp({ host: fake.host, extraFeatures: [probe] });
    const config = t.capture.config?.value;
    await config?.set(
      'hooks',
      [
        { event: 'PermissionRequest', command: 'perm ask' },
        { event: 'PermissionResult', command: 'perm result' },
      ],
      'memory',
    );
    const base = {
      id: 'approval_1',
      sessionId: 'sess',
      agentId: MAIN_AGENT_ID,
      toolCallId: 'call-1',
      toolName: 'Bash',
      action: 'Approve Bash',
      display: { kind: 'generic', summary: 'Approve Bash', detail: {} },
      toolInput: { command: 'ls' },
    };
    fireProbe?.({ type: 'permission.approval.requested', ...base });
    fireProbe?.({ type: 'permission.approval.resolved', ...base, decision: 'approved' });
    await waitFor(
      () =>
        fake.spawns.some((spawn) => spawn.args[1] === 'perm ask') &&
        fake.spawns.some((spawn) => spawn.args[1] === 'perm result'),
    );
    const asked = fake.spawns.find((spawn) => spawn.args[1] === 'perm ask')!;
    expect(spawnPayload(asked)).toMatchObject({
      hook_event_name: 'PermissionRequest',
      id: 'approval_1',
      session_id: 'sess',
      agent_id: MAIN_AGENT_ID,
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      action: 'Approve Bash',
    });
    const resolved = fake.spawns.find((spawn) => spawn.args[1] === 'perm result')!;
    expect(spawnPayload(resolved)).toMatchObject({
      hook_event_name: 'PermissionResult',
      id: 'approval_1',
      tool_name: 'Bash',
      decision: 'approved',
    });
  });

  it('translates compaction node events into PreCompact and PostCompact payloads', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    let fireProbe: ((event: { type: string } & Record<string, unknown>) => void) | undefined;
    const probe = createFeature('compaction-probe', {
      agent() {
        const fire = useFire();
        fireProbe = fire;
      },
    });
    const t = await startApp({ host: fake.host, extraFeatures: [probe] });
    const config = t.capture.config?.value;
    await config?.set(
      'hooks',
      [
        { event: 'PreCompact', command: 'rec pre' },
        { event: 'PostCompact', command: 'rec post' },
      ],
      'memory',
    );
    fireProbe?.({ type: 'compaction.started', reason: 'manual', instruction: undefined });
    fireProbe?.({
      type: 'compaction.completed',
      reason: 'manual',
      stats: { compactedCount: 3, tokensBefore: 100, tokensAfter: 42 },
      durationMs: 5,
    });
    await waitFor(
      () =>
        fake.spawns.some((spawn) => spawn.args[1] === 'rec pre') &&
        fake.spawns.some((spawn) => spawn.args[1] === 'rec post'),
    );
    const pre = fake.spawns.find((spawn) => spawn.args[1] === 'rec pre')!;
    expect(spawnPayload(pre)).toMatchObject({
      hook_event_name: 'PreCompact',
      session_id: 'sess',
      trigger: 'manual',
    });
    const post = fake.spawns.find((spawn) => spawn.args[1] === 'rec post')!;
    expect(spawnPayload(post)).toMatchObject({
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      estimated_token_count: 42,
    });
  });

  it('merges plugin-sourced hooks through useHookSource and reloads them on change', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    let pluginHooks: HookDef[] = [];
    const listeners = new Set<() => void>();
    const source = createFeature('plugin-hook-source', {
      app() {
        useHookSource({
          id: 'plugin',
          load: async () => pluginHooks,
          onDidChange: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        });
      },
    });
    const t = await startApp({ host, extraFeatures: [source] });
    const runner = t.capture.runner?.value;
    expect(runner?.hasHooksFor('PreToolUse')).toBe(false);
    pluginHooks = [{ event: 'PreToolUse', matcher: 'Bash', command: 'plugin gate' }];
    for (const listener of listeners) listener();
    await waitFor(() => runner?.hasHooksFor('PreToolUse') === true);
    expect(runner?.summary).toEqual({ PreToolUse: 1 });
    await runner?.trigger('PreToolUse', { matcherValue: 'Bash' });
    await waitFor(() => spawns.some((spawn) => spawn.args[1] === 'plugin gate'));
    pluginHooks = [];
    for (const listener of listeners) listener();
    await waitFor(() => runner?.hasHooksFor('PreToolUse') === false);
  });

  it('derives SubagentStart and SubagentStop from roster identity and subagent-origin turns', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const requester = createMockRequester([{ text: 'done' }]);
    const t = await startApp({ host: fake.host });
    const config = t.capture.config?.value;
    await config?.set(
      'hooks',
      [
        { event: 'SubagentStart', command: 'rec start' },
        { event: 'SubagentStop', command: 'rec sub' },
      ],
      'memory',
    );
    const internals = harnessInternals(t.harness.app);
    let perSession = internals.agents.get(t.session);
    if (perSession === undefined) {
      perSession = new Map();
      internals.agents.set(t.session, perSession);
    }
    const runtime = createAgentRuntime('sub-1');
    runtime.requester = requester;
    perSession.set('sub-1', runtime);
    const child = await t.session.open('sub-1', agentCaps(runtime), { source: 'spawn:main:coder' });
    await tick();
    const outcome = await child.loop.runTurn(user('do it', { origin: { kind: 'subagent' } }));
    expect(outcome.type).toBe('done');
    const starts = (): SpawnRecord[] => fake.spawns.filter((spawn) => spawn.args[1] === 'rec start');
    const stops = (): SpawnRecord[] => fake.spawns.filter((spawn) => spawn.args[1] === 'rec sub');
    await waitFor(() => starts().length === 1 && stops().length === 1);
    expect(spawnPayload(starts()[0]!)).toMatchObject({
      hook_event_name: 'SubagentStart',
      session_id: 'sess',
      agent_name: 'coder',
      prompt: 'do it',
    });
    expect(spawnPayload(stops()[0]!)).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_name: 'coder',
      response: 'done',
    });

    await child.loop.runTurn(user('user turn', {}));
    await settle();
    expect(starts()).toHaveLength(1);
    expect(stops()).toHaveLength(1);

    const btwInternals = harnessInternals(t.harness.app).agents.get(t.session)!;
    const btwRuntime = createAgentRuntime('btw-1');
    btwRuntime.requester = requester;
    btwInternals.set('btw-1', btwRuntime);
    const btw = await t.session.open('btw-1', agentCaps(btwRuntime), { source: 'btw' });
    await tick();
    await btw.loop.runTurn(user('do it', { origin: { kind: 'subagent' } }));
    await settle();
    expect(starts()).toHaveLength(1);
    expect(stops()).toHaveLength(1);
  });

  it('fires SessionOpened with source, model, and profile in the payload and honors matchers', async () => {
    const gated = createGatedHost();
    const t = await startSessionApp({
      host: gated.host,
      hooks: [
        { event: 'SessionOpened', matcher: 'startup', command: 'rec start' },
        { event: 'SessionOpened', matcher: 'resume', command: 'rec resume' },
      ],
      model: 'test-alias',
      profile: 'coder',
    });
    const session = await t.harness.app.create({});
    await waitFor(() => gated.spawns.length === 1);
    expect(gated.spawns[0]!.args[1]).toBe('rec start');
    gated.releaseAll();
    await waitFor(() => gated.spawns[0]!.stdin !== undefined);
    expect(spawnPayload(gated.spawns[0]!)).toMatchObject({
      hook_event_name: 'SessionOpened',
      session_id: session.id,
      source: 'startup',
      model: 'test-alias',
      profile: 'coder',
      client_type: 'test_client',
    });
    expect(gated.spawns.map((spawn) => spawn.args[1])).toEqual(['rec start']);
  });

  it('skips SessionOpened for forks, fires it with resume source on reopen, and fires SessionClosed on close and delete', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startSessionApp({
      host: fake.host,
      hooks: [
        { event: 'SessionOpened', command: 'rec start' },
        { event: 'SessionClosed', command: 'rec end' },
      ],
    });
    const starts = (): SpawnRecord[] => fake.spawns.filter((spawn) => spawn.args[1] === 'rec start');
    const ends = (): SpawnRecord[] => fake.spawns.filter((spawn) => spawn.args[1] === 'rec end');

    const first = await t.harness.app.create({ title: 'First' });
    await tick();
    await waitFor(() => starts().length === 1);
    expect(spawnPayload(starts()[0]!)).toMatchObject({ source: 'startup' });

    const forked = await t.harness.app.create({ from: first.id });
    await tick();
    await settle();
    expect(starts()).toHaveLength(1);
    await t.harness.app.close(forked.id);
    expect(ends()).toHaveLength(1);
    expect(spawnPayload(ends()[0]!)).toMatchObject({
      hook_event_name: 'SessionClosed',
      session_id: forked.id,
      reason: 'exit',
      session_title: 'First',
    });

    await t.harness.app.close(first.id);
    expect(ends()).toHaveLength(2);
    const resumed = await t.harness.app.create({ sessionId: first.id });
    await tick();
    await waitFor(() => starts().length === 2);
    expect(spawnPayload(starts()[1]!)).toMatchObject({
      source: 'resume',
      session_title: 'First',
    });

    await t.harness.app.delete(resumed.id);
    expect(ends()).toHaveLength(3);
  });

  it('awaits SessionClosed hooks before resolving close and fires SessionClosed on app shutdown', async () => {
    const gated = createGatedHost();
    const t = await startSessionApp({
      host: gated.host,
      hooks: [{ event: 'SessionClosed', command: 'rec end' }],
    });
    const first = await t.harness.app.create({});
    await tick();
    let closeResolved = false;
    const closing = t.harness.app.close(first.id).then(() => {
      closeResolved = true;
    });
    await waitFor(() => gated.spawns.length === 1);
    await settle(20);
    expect(closeResolved).toBe(false);
    gated.releaseAll();
    await closing;
    expect(closeResolved).toBe(true);

    const lingering = await t.harness.app.create({});
    await tick();
    let disposed = false;
    const disposing = t.harness.close().then(() => {
      disposed = true;
    });
    await waitFor(() => gated.spawns.length === 2);
    await settle(20);
    expect(disposed).toBe(false);
    gated.releaseAll();
    await disposing;
    expect(spawnPayload(gated.spawns[1]!)).toMatchObject({
      hook_event_name: 'SessionClosed',
      session_id: lingering.id,
      reason: 'exit',
    });
  });
});
