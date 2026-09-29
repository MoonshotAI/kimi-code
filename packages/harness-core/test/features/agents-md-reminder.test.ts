import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join, normalize } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  useAgentTools,
  useSystemPrompt,
  type AgentHandle,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
} from '@moonshot-ai/agent-core';
import { parse } from '@moonshot-ai/tree-sitter-bash';

import {
  AGENTS_MD_CHANGE_REMIND_KEY,
  AGENTS_MD_DISCOVERY_REMIND_KEY,
  AgentsMdReminderRef,
  createAgentsMdReminder,
  extractBashTargetDirs,
} from '#/features/agentsMdReminder/index';
import {
  createNodeOsHost,
  type HostFileStat,
  type OsFsPort,
  type OsHost,
} from '#/features/os/host/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

let home: string;
let workDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agents-md-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'agents-md-work-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(queue: ScriptStep[], calls: LlmCall[]): LlmRequester {
  return {
    generate: async (_config, content, { onEvent }) => {
      calls.push({
        systemPrompt: content.systemPrompt,
        messages: content.messages,
        tools: content.tools ?? [],
      });
      const out = queue.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        onEvent?.({
          type: 'llm.streaming.part',
          part: {
            type: 'function',
            id: `call-${calls.length}`,
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

const TEST_TOOL_NAMES = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      for (const name of TEST_TOOL_NAMES) {
        useAgentTools({
          name,
          description: `${name} tool`,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text' as const, text: `${name} ok` }] }),
        });
      }
    },
  });
}

function bindAgentsMdSection(text: string): FeatureSpec {
  return createFeature('test-agents-md-section', {
    agent() {
      useSystemPrompt({ id: 'agents-md', text });
    },
  });
}

function posixHost(homeDir: string): OsHost {
  const node = createNodeOsHost();
  return {
    process: node.process,
    fs: node.fs,
    environment: {
      ready: Promise.resolve(),
      osKind: 'Darwin',
      osArch: 'arm64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir,
    },
  };
}

interface StartOptions {
  readonly workDir?: string;
  readonly host?: OsHost;
  readonly noHost?: boolean;
  readonly brandHome?: string;
  readonly leadingFeatures?: readonly FeatureSpec[];
  readonly tools?: FeatureSpec;
}

async function startReminderTest(options: StartOptions = {}) {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const queue: ScriptStep[] = [];
  const calls: LlmCall[] = [];
  const app = createHarness({
    features: [
      ...(options.leadingFeatures ?? []),
      createAgentsMdReminder({
        workDir: options.workDir ?? workDir,
        host: options.noHost === true ? undefined : (options.host ?? posixHost(home)),
        brandHome: options.brandHome,
      }),
      options.tools ?? bindTestTools(),
      bindTestLlm(createMockRequester(queue, calls)),
    ],
  });
  const session = await app.create({ sessionId: 'sess', stores });
  let main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const runTurn = async (text = 'go'): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      main.on('turn.done', () => {
        resolve();
      });
    });
    main.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  const reminderTexts = (key: string): string[] =>
    (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
      .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === key)
      .map((entry) => extractText(entry.message));
  return {
    app,
    session,
    stores,
    queue,
    calls,
    runTurn,
    remount,
    dispose,
    discoveryTexts: (): string[] => reminderTexts(AGENTS_MD_DISCOVERY_REMIND_KEY),
    changeTexts: (): string[] => reminderTexts(AGENTS_MD_CHANGE_REMIND_KEY),
    lastRequestText: (): string =>
      (calls.at(-1)?.messages ?? []).map((message) => extractText(message)).join('\n'),
    get main(): AgentHandle {
      return main;
    },
  };
}

function reminderText(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

function discoveryText(paths: readonly string[]): string {
  return reminderText(
    'The following AGENTS.md file(s) apply to paths accessed by your recent tool call, but were not included in your system prompt:\n' +
      paths.map((path) => `- ${path}`).join('\n') +
      '\nRead them before making changes in those directories.',
  );
}

function readStep(path: string): ScriptStep {
  return { toolCall: { name: 'Read', arguments: JSON.stringify({ path }) } };
}

function bashStep(args: { command: string; cwd?: string }): ScriptStep {
  return { toolCall: { name: 'Bash', arguments: JSON.stringify(args) } };
}

async function writeAgentsMd(dir: string, content = 'instructions'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'AGENTS.md');
  await writeFile(path, content, 'utf-8');
  return normalize(path);
}

describe('agentsMdReminder discovery', () => {
  it('loads no service when the host injects no os-host', async () => {
    const env = await startReminderTest({ noHost: true });
    const subDir = join(workDir, 'packages', 'kap-server');
    await writeAgentsMd(subDir, 'package instructions');

    env.queue.push(readStep(join(subDir, 'src', 'index.ts')), { text: 'done' });
    await env.runTurn();

    expect(env.discoveryTexts()).toEqual([]);
    expect(env.lastRequestText()).not.toContain('AGENTS.md');
    await env.dispose();
  });

  it('reminds the AGENTS.md of an accessed subdirectory after lazy-seeding the injected chain', async () => {
    const env = await startReminderTest();
    const brandAgentsMd = await writeAgentsMd(join(home, '.kimi-code'), 'brand instructions');
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir, 'package instructions');

    env.queue.push(readStep(join(subDir, 'src', 'index.ts')), { text: 'done' });
    await env.runTurn();

    expect(env.discoveryTexts()).toEqual([discoveryText([subAgentsMd])]);
    const text = env.discoveryTexts().join('\n');
    expect(text).not.toContain(rootAgentsMd);
    expect(text).not.toContain(brandAgentsMd);
    expect(env.lastRequestText()).toContain(subAgentsMd);
    await env.dispose();
  });

  it('seeds known paths from <!-- From: --> annotations in the assembled system prompt at setup', async () => {
    const homePackage = join(home, 'pkg');
    const homeAgentsMd = await writeAgentsMd(homePackage, 'home package instructions');
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const env = await startReminderTest({
      leadingFeatures: [
        bindAgentsMdSection(`<!-- From: ${homeAgentsMd} -->\nhome package instructions`),
      ],
    });

    env.queue.push(readStep(join(homePackage, 'index.ts')), { text: 'done' });
    await env.runTurn();
    expect(env.discoveryTexts()).toHaveLength(0);

    env.queue.push(readStep(join(workDir, 'index.ts')), { text: 'done' });
    await env.runTurn();
    expect(env.discoveryTexts()).toEqual([discoveryText([rootAgentsMd])]);
    await env.dispose();
  });

  it('reminds at most once across a Read and an Edit of the same directory in separate steps', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(
      readStep(join(subDir, 'a.ts')),
      { toolCall: { name: 'Edit', arguments: JSON.stringify({ path: join(subDir, 'b.ts') }) } },
      { text: 'done' },
    );
    await env.runTurn();

    expect(env.discoveryTexts()).toEqual([discoveryText([subAgentsMd])]);
    await env.dispose();
  });

  it('suppresses the reminder when the AGENTS.md itself was read, then reminds on a later access', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(readStep(subAgentsMd), { text: 'done' });
    await env.runTurn();
    expect(env.discoveryTexts()).toHaveLength(0);

    env.queue.push(readStep(join(subDir, 'src', 'index.ts')), { text: 'done' });
    await env.runTurn();
    expect(env.discoveryTexts()).toEqual([discoveryText([subAgentsMd])]);
    await env.dispose();
  });

  it('reminds in the same turn when the direct AGENTS.md read failed with isError', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);
    const env = await startReminderTest({
      tools: createFeature('failing-read', {
        agent() {
          useAgentTools({
            name: 'Read',
            description: 'Read tool',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({
              content: [{ type: 'text' as const, text: 'read failed' }],
              isError: true,
            }),
          });
        },
      }),
    });
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(readStep(subAgentsMd), { text: 'done' });
    await env.runTurn();
    expect(env.discoveryTexts()).toEqual([discoveryText([subAgentsMd])]);
    await env.dispose();
  });

  it('anchors at the nearest existing ancestor when Write targets a not-yet-created directory', async () => {
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(
      {
        toolCall: {
          name: 'Write',
          arguments: JSON.stringify({
            path: join(workDir, 'new-pkg', 'src', 'index.ts'),
            content: 'x',
          }),
        },
      },
      { text: 'done' },
    );
    await env.runTurn();

    expect(env.discoveryTexts()).toEqual([discoveryText([rootAgentsMd])]);
    await env.dispose();
  });

  it('ignores a whitespace-only AGENTS.md', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'AGENTS.md'), '  \n\t \n', 'utf-8');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(readStep(join(subDir, 'index.ts')), { text: 'done' });
    await env.runTurn();

    expect(env.discoveryTexts()).toHaveLength(0);
    await env.dispose();
  });
});

describe('agentsMdReminder Bash probing', () => {
  it('discovers directories listed by ls and rebases operands across a literal cd', async () => {
    const dirA = join(workDir, 'packages', 'a');
    const dirB = join(workDir, 'packages', 'b');
    const agentsMdA = await writeAgentsMd(dirA, 'instructions a');
    const agentsMdB = await writeAgentsMd(dirB, 'instructions b');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(bashStep({ command: 'ls packages/a' }), { text: 'done' });
    await env.runTurn();
    env.queue.push(bashStep({ command: 'cd packages && ls b' }), { text: 'done' });
    await env.runTurn();

    const texts = env.discoveryTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(discoveryText([agentsMdA]));
    expect(texts[1]).toBe(discoveryText([agentsMdB]));
    await env.dispose();
  });

  it('probes the explicit cwd for a non-listing command and for an unparseable one', async () => {
    const dirA = join(workDir, 'packages', 'a');
    const dirB = join(workDir, 'packages', 'b');
    const agentsMdA = await writeAgentsMd(dirA, 'instructions a');
    const agentsMdB = await writeAgentsMd(dirB, 'instructions b');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(bashStep({ command: 'git status', cwd: 'packages/a' }), { text: 'done' });
    await env.runTurn();
    env.queue.push(bashStep({ command: "ls '", cwd: 'packages/b' }), { text: 'done' });
    await env.runTurn();

    const texts = env.discoveryTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(discoveryText([agentsMdA]));
    expect(texts[1]).toBe(discoveryText([agentsMdB]));
    await env.dispose();
  });

  it('skips unparseable commands without cwd and operands that are not statically resolvable', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    await writeAgentsMd(subDir);
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    for (const args of [
      { command: "ls '" },
      { command: 'ls $DIR' },
      { command: 'ls *.ts' },
      { command: 'echo packages/kap-server' },
    ]) {
      env.queue.push(bashStep(args), { text: 'done' });
      await env.runTurn();
    }

    expect(env.discoveryTexts()).toHaveLength(0);
    await env.dispose();
  });
});

describe('extractBashTargetDirs', () => {
  function targets(command: string, cwd = workDir): string[] {
    const parsed = parse(command);
    if (!parsed.ok) throw new Error(`parse aborted for: ${command}`);
    return extractBashTargetDirs(parsed.rootNode, cwd, home);
  }

  it('resolves relative and absolute operands, tracks cd chains, and falls back for bare commands', () => {
    expect(targets('ls packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('tree /opt /srv')).toEqual(['/opt', '/srv']);
    expect(targets('cd packages && cd kap-server && ls')).toEqual([
      normalize(join(workDir, 'packages', 'kap-server')),
    ]);
    expect(targets('cd && ls notes')).toEqual([normalize(join(home, 'notes'))]);
    expect(targets('ls')).toEqual([workDir]);
    expect(targets('find')).toEqual([workDir]);
  });

  it('drops the arguments of known argument-taking options', () => {
    expect(targets('ls -w 80 packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls --sort size packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls --sort=size packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('tree -L 2 packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('find -L packages -name x')).toEqual([normalize(join(workDir, 'packages'))]);
  });

  it('skips globs, dollar words, path-prefixed commands, and cd inside pipelines', () => {
    expect(targets('ls $DIR')).toEqual([]);
    expect(targets('ls *.ts')).toEqual([]);
    expect(targets("ls '*.ts'")).toEqual([]);
    expect(targets('/bin/ls packages')).toEqual([]);
    expect(targets('./ls packages')).toEqual([]);
    expect(targets('cd /tmp | ls packages')).toEqual([normalize(join(workDir, 'packages'))]);
  });
});

describe('agentsMdReminder probing boundaries', () => {
  it('re-roots probing at a nested repository', async () => {
    const nested = join(workDir, 'packages', 'nested');
    await mkdir(join(workDir, '.git'), { recursive: true });
    await mkdir(join(nested, '.git'), { recursive: true });
    const rootAgentsMd = await writeAgentsMd(workDir, 'outer instructions');
    const nestedAgentsMd = await writeAgentsMd(nested, 'nested instructions');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    env.queue.push(readStep(join(nested, 'index.ts')), { text: 'done' });
    await env.runTurn();

    const text = env.discoveryTexts().join('\n');
    expect(text).toContain(nestedAgentsMd);
    expect(text).not.toContain(rootAgentsMd);
    await env.dispose();
  });

  it('probes only the immediate directory outside any project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'agents-md-outside-'));
    const outerAgentsMd = await writeAgentsMd(outside, 'outer instructions');
    const leaf = join(outside, 'leaf');
    const leafAgentsMd = await writeAgentsMd(leaf, 'leaf instructions');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([]);

    try {
      env.queue.push(readStep(join(leaf, 'index.ts')), { text: 'done' });
      await env.runTurn();

      const text = env.discoveryTexts().join('\n');
      expect(text).toContain(leafAgentsMd);
      expect(text).not.toContain(outerAgentsMd);
    } finally {
      await env.dispose();
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('agentsMdReminder change announcements', () => {
  it('announces modified and deleted seeded files by polling, and re-discovers a recreated file', async () => {
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const env = await startReminderTest();
    env.main.resolve(AgentsMdReminderRef).seed([rootAgentsMd]);

    env.queue.push({ text: 'done' });
    await env.runTurn();
    expect(env.changeTexts()).toHaveLength(0);

    await writeFile(rootAgentsMd, 'root instructions v2', 'utf-8');
    await utimes(rootAgentsMd, new Date(), new Date(Date.now() + 10_000));
    env.queue.push(readStep(join(workDir, 'index.ts')), { text: 'done' });
    await env.runTurn();

    expect(env.changeTexts()).toEqual([
      reminderText(
        'The AGENTS.md instruction file(s) below changed on disk after they were injected into the system prompt:\n' +
          `- ${rootAgentsMd}\n` +
          'Read the current file(s) and follow the latest contents; the copies injected in the system prompt are stale.',
      ),
    ]);
    expect(env.lastRequestText()).toContain(rootAgentsMd);
    expect(env.lastRequestText()).toContain('stale');
    expect(env.discoveryTexts()).toHaveLength(0);

    await rm(rootAgentsMd);
    env.queue.push({ text: 'done' });
    await env.runTurn();
    expect(env.changeTexts()).toHaveLength(1);

    env.queue.push(readStep(join(workDir, 'index.ts')), { text: 'done' });
    await env.runTurn();
    const changes = env.changeTexts();
    expect(changes).toHaveLength(2);
    expect(changes[1]).toContain(`${rootAgentsMd} (deleted)`);
    expect(env.lastRequestText()).toContain('(deleted)');

    await writeAgentsMd(workDir, 'root instructions v3');
    env.queue.push(readStep(join(workDir, 'else.ts')), { text: 'done' });
    await env.runTurn();

    expect(env.changeTexts()).toHaveLength(3);
    expect(env.discoveryTexts()).toEqual([discoveryText([rootAgentsMd])]);
    await env.dispose();
  });

  it('does not duplicate a discovery reminder after a remount on the same stores', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);
    const env = await startReminderTest();

    env.queue.push(readStep(join(subDir, 'a.ts')), { text: 'done' });
    await env.runTurn();
    expect(env.discoveryTexts()).toEqual([discoveryText([subAgentsMd])]);

    await env.remount();
    env.queue.push(readStep(join(subDir, 'b.ts')), { text: 'done' });
    await env.runTurn();

    expect(env.discoveryTexts()).toHaveLength(1);
    await env.dispose();
  });
});

describe('agentsMdReminder win32 pathClass', () => {
  it('translates Git Bash drive paths before probing the host filesystem', async () => {
    const projectRoot = 'C:/repo';
    const targetDir = 'C:/repo/packages/app';
    const agentsMdPath = 'C:/repo/packages/app/AGENTS.md';
    const directory: HostFileStat = { isFile: false, isDirectory: true, size: 0 };
    const windowsHost = (): OsHost => ({
      process: {
        spawn: () => Promise.reject(new Error('spawn unavailable')),
      },
      fs: {
        stat: async (path: string): Promise<HostFileStat> => {
          if (path === targetDir || path === join(projectRoot, '.git')) return directory;
          throw new Error(`missing: ${path}`);
        },
        readText: async (path: string): Promise<string> => {
          if (path === agentsMdPath) return 'windows instructions';
          throw new Error(`missing: ${path}`);
        },
      } as unknown as OsFsPort,
      environment: {
        ready: Promise.resolve(),
        osKind: 'Windows',
        osArch: 'x64',
        osVersion: 'test',
        shellName: 'bash',
        shellPath: 'C:/Tools/Git/bin/bash.exe',
        pathClass: 'win32',
        homeDir: 'C:/home',
      },
    });

    for (const args of [
      { command: 'ls /cygdrive/c/repo/packages/app' },
      { command: 'true', cwd: '/c/repo/packages/app' },
    ]) {
      const env = await startReminderTest({ workDir: projectRoot, host: windowsHost() });
      env.main.resolve(AgentsMdReminderRef).seed([]);

      env.queue.push(bashStep(args), { text: 'done' });
      await env.runTurn();

      expect(env.discoveryTexts()).toEqual([discoveryText([agentsMdPath])]);
      await env.dispose();
    }
  });
});
