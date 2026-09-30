import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigRef,
  createConfig,
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  memorySessionSpace,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  useAgentTools,
  type AgentHandle,
  type AppHandle,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type PromptOrigin,
  type SessionHandle,
  type SessionStores,
  type UserMeta,
} from '@moonshot-ai/agent-core';
import { shallowRef, useExpose } from '@moonshot-ai/agent-core/kernel/index';

import {
  createExternalHooks,
  createExternalHooksRunner,
  ExternalHooksRunnerRef,
  type HookDef,
} from '#/features/externalHooks/index';
import { indexHooks, runMatchedHooks } from '#/features/externalHooks/internal/match';
import { runHook } from '#/features/externalHooks/internal/run';
import type { OsHost, OsProcess, OsSpawnOptions } from '#/features/os/index';
import { ProfileCatalogRef, type AgentProfile } from '#/features/profiles/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

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

function createMockRequester(steps: readonly ScriptStep[] = []): LlmRequester {
  const pending = [...steps];
  let seq = 0;
  return {
    generate: async (_config, _content, { onEvent }) => {
      const out = pending.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        onEvent?.({
          type: 'llm.streaming.part',
          part: {
            type: 'function',
            id: `call-${(seq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        });
      } else {
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
      }
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      onEvent?.({ type: 'llm.done' });
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

interface ExecutedTool {
  readonly name: string;
  readonly arguments: string | null;
}

function bindTestTools(executed: ExecutedTool[]): FeatureSpec {
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

const tmpDirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (disposers.length > 0) await disposers.pop()!();
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface TestApp {
  readonly app: AppHandle;
  readonly session: SessionHandle;
  readonly main: AgentHandle;
  readonly stores: SessionStores;
  readonly workDir: string;
  readonly runTurn: (text?: string, meta?: UserMeta) => Promise<void>;
}

async function startApp(options?: {
  host?: OsHost;
  requester?: LlmRequester;
  executed?: ExecutedTool[];
  withConfig?: boolean;
  clientType?: string;
}): Promise<TestApp> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const workDir = await mkdtemp(join(tmpdir(), 'external-hooks-'));
  tmpDirs.push(workDir);
  const features: FeatureSpec[] = [
    ...(options?.withConfig === false ? [] : [createConfig({})]),
    createExternalHooks({
      host: options?.host,
      workDir,
      clientType: options?.clientType ?? 'test_client',
    }),
    ...(options?.executed === undefined ? [] : [bindTestTools(options.executed)]),
    bindTestLlm(options?.requester ?? createMockRequester()),
  ];
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const runTurn = async (text = 'go', meta?: UserMeta): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      main.on('turn.done', () => {
        resolve();
      });
    });
    main.submit(createUserMessage(text), meta);
    await done;
    await stores.flush();
  };
  disposers.push(async () => {
    await app.disposeAsync();
    await stores.dispose();
  });
  return { app, session, main, stores, workDir, runTurn };
}

function toolResultTexts(stores: SessionStores): string[] {
  return (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

interface SessionTestApp {
  readonly app: AppHandle;
  readonly workDir: string;
}

async function startSessionApp(options: {
  host: OsHost;
  hooks: readonly HookDef[];
  model?: string;
  profile?: string;
}): Promise<SessionTestApp> {
  const workDir = await mkdtemp(join(tmpdir(), 'external-hooks-'));
  tmpDirs.push(workDir);
  const features: FeatureSpec[] = [
    createConfig({}),
    createExternalHooks({ host: options.host, workDir, clientType: 'test_client' }),
    ...(options.profile === undefined ? [] : [stubProfileCatalog(options.profile)]),
  ];
  const app = createHarness({ features, space: memorySessionSpace() });
  await app.ready();
  const config = app.resolve(ConfigRef);
  await config.set('hooks', options.hooks, 'memory');
  if (options.model !== undefined) {
    await config.set('defaultModel', options.model, 'memory');
  }
  disposers.push(async () => {
    await app.disposeAsync();
  });
  return { app, workDir };
}

function stubProfileCatalog(name: string): FeatureSpec {
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
        { type: 'image_url', imageUrl: { url: 'file:///tmp/a.png' } },
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
    const runner = t.app.resolve(ExternalHooksRunnerRef);
    expect(runner.hasHooksFor('PreToolUse')).toBe(false);
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'PreToolUse', matcher: 'Bash', command: 'gate' }], 'memory');
    expect(runner.hasHooksFor('PreToolUse')).toBe(true);
    expect(runner.summary).toEqual({ PreToolUse: 1 });
    await expect(
      config.set('hooks', [{ event: 'Nope', command: 'x' }], 'memory'),
    ).rejects.toThrow();
  });

  it('keeps the runner usable with hooks empty when the config feature is absent', async () => {
    const { host, spawns } = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host, withConfig: false });
    const runner = t.app.resolve(ExternalHooksRunnerRef);
    expect(runner.hasHooksFor('PreToolUse')).toBe(false);
    await expect(runner.trigger('PreToolUse', { matcherValue: 'Bash' })).resolves.toEqual([]);
    expect(spawns).toHaveLength(0);
  });

  it('no-ops every slot when the host is not provided', async () => {
    const executed: ExecutedTool[] = [];
    const t = await startApp({
      requester: createMockRequester([{ toolCall: { name: 'Bash', arguments: '{}' } }]),
      executed,
    });
    expect(t.app.resolve(ExternalHooksRunnerRef)).toBeUndefined();
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'PreToolUse', command: 'gate' }], 'memory');
    expect(config.get('hooks')).toEqual([{ event: 'PreToolUse', command: 'gate' }]);
    await t.runTurn('run bash');
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
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'PreToolUse', matcher: 'Bash', command: 'deny bash' }], 'memory');
    await t.runTurn('run bash');
    expect(executed).toHaveLength(0);
    expect(toolResultTexts(t.stores).join('\n')).toContain('no bash today');
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
    await config.set('hooks', [{ event: 'PreToolUse', matcher: 'Write', command: 'deny write' }], 'memory');
    await t.runTurn('run bash again');
    expect(executed).toHaveLength(1);
  });

  it('fires TurnStarted with the origin payload for displayable and named origins', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    const t = await startApp({ host: fake.host });
    await t.stores.session.dispatch({
      type: 'session.meta_updated',
      meta: { id: 'sess', title: 'My Session' },
    });
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'TurnStarted', command: 'rec turn' }], 'memory');
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
      origin: { kind: 'system_trigger', name: 'goal' } as PromptOrigin,
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
    const failing: LlmRequester = {
      generate: async () => {
        throw { kind: 'rate_limit', message: 'slow down' };
      },
    };
    const t = await startApp({ host: fake.host, requester: failing });
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'StopFailure', command: 'rec fail' }], 'memory');
    await t.runTurn('boom');
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
    const hanging: LlmRequester = {
      generate: async () => {
        await new Promise<void>(() => {});
      },
    };
    const t = await startApp({ host: fake.host, requester: hanging });
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'Interrupt', command: 'rec int' }], 'memory');
    const started = new Promise<void>((resolve) => {
      t.main.on('turn.started', () => {
        resolve();
      });
    });
    const done = new Promise<void>((resolve) => {
      t.main.on('turn.done', () => {
        resolve();
      });
    });
    t.main.submit(createUserMessage('long work'));
    await started;
    t.main.abort();
    await done;
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
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'UserPromptQueued', command: 'rec prompt' }], 'memory');
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
    await t.stores.session.dispatch({
      type: 'session.meta_updated',
      meta: { id: 'sess', title: 'Heart Session' },
    });
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'SessionHeartbeat', command: 'rec hb' }], 'memory');
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
    const t = await startApp({ host: fake.host });
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'TaskStarted', command: 'rec task' }], 'memory');
    t.main.node.fire({
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

  it('derives SubagentStop from roster identity and subagent-origin turn completion', async () => {
    const fake = createFakeHost(() => ({ exitCode: 0 }));
    let failNext = false;
    const requester: LlmRequester = {
      generate: async (_config, _content, { onEvent }) => {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        onEvent?.({ type: 'llm.done' });
      },
    };
    const t = await startApp({ host: fake.host, requester });
    const config = t.app.resolve(ConfigRef);
    await config.set('hooks', [{ event: 'SubagentStop', command: 'rec sub' }], 'memory');
    const stops = (): SpawnRecord[] => fake.spawns.filter((spawn) => spawn.args[1] === 'rec sub');
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const child = await t.session.create({ agentId: 'sub-1', source: 'spawn:main:coder' });
    await child.run(createUserMessage('do it'), { meta: { origin: { kind: 'subagent' } } });
    await waitFor(() => stops().length === 1);
    expect(spawnPayload(stops()[0]!)).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_name: 'coder',
      response: 'done',
    });

    await child.run(createUserMessage('user turn'), {});
    await settle();
    expect(stops()).toHaveLength(1);

    failNext = true;
    await child
      .run(createUserMessage('explode'), { meta: { origin: { kind: 'subagent' } } })
      .catch(() => {});
    await settle();
    expect(stops()).toHaveLength(1);

    const btw = await t.session.create({ agentId: 'btw-1', source: 'btw' });
    await btw.run(createUserMessage('do it'), { meta: { origin: { kind: 'subagent' } } });
    await settle();
    expect(stops()).toHaveLength(1);
  });

  it('fires SessionOpened awaited by app.open with source, model, and profile in the payload', async () => {
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
    let openResolved = false;
    const opening = t.app.open({}).then((session) => {
      openResolved = true;
      return session;
    });
    await waitFor(() => gated.spawns.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openResolved).toBe(false);
    expect(gated.spawns[0]!.args[1]).toBe('rec start');
    gated.releaseAll();
    const session = await opening;
    expect(openResolved).toBe(true);
    expect(spawnPayload(gated.spawns[0]!)).toMatchObject({
      hook_event_name: 'SessionOpened',
      session_id: session.sessionId,
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

    const first = await t.app.open({ title: 'First' });
    expect(starts()).toHaveLength(1);
    expect(spawnPayload(starts()[0]!)).toMatchObject({ source: 'startup' });

    const forked = await t.app.open({ from: first.sessionId });
    expect(starts()).toHaveLength(1);
    await t.app.close(forked.sessionId);
    expect(ends()).toHaveLength(1);
    expect(spawnPayload(ends()[0]!)).toMatchObject({
      hook_event_name: 'SessionClosed',
      session_id: forked.sessionId,
      reason: 'exit',
      session_title: 'First',
    });

    await t.app.close(first.sessionId);
    expect(ends()).toHaveLength(2);
    const resumed = await t.app.open({ sessionId: first.sessionId });
    expect(starts()).toHaveLength(2);
    expect(spawnPayload(starts()[1]!)).toMatchObject({
      source: 'resume',
      session_title: 'First',
    });

    await t.app.delete(resumed.sessionId);
    expect(ends()).toHaveLength(3);
  });

  it('awaits SessionClosed hooks before resolving close and fires SessionClosed on app shutdown', async () => {
    const gated = createGatedHost();
    const t = await startSessionApp({
      host: gated.host,
      hooks: [{ event: 'SessionClosed', command: 'rec end' }],
    });
    const first = await t.app.open({});
    let closeResolved = false;
    const closing = t.app.close(first.sessionId).then(() => {
      closeResolved = true;
    });
    await waitFor(() => gated.spawns.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeResolved).toBe(false);
    gated.releaseAll();
    await closing;
    expect(closeResolved).toBe(true);

    const lingering = await t.app.open({});
    const disposing = t.app.disposeAsync();
    await waitFor(() => gated.spawns.length === 2);
    gated.releaseAll();
    await disposing;
    expect(spawnPayload(gated.spawns[1]!)).toMatchObject({
      hook_event_name: 'SessionClosed',
      session_id: lingering.sessionId,
      reason: 'exit',
    });
  });
});
