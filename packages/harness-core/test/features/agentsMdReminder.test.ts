import { dirname, normalize } from 'pathe';
import { describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type ToolCall,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import {
  AGENTS_MD_CHANGE_REMIND_KEY,
  AGENTS_MD_DISCOVERY_REMIND_KEY,
  AgentsMdReminderRef,
  createAgentsMdReminder,
  type AgentsMdReminderFace,
} from '#/features/agentsMdReminder/index';
import type { OsFsPort, OsHost } from '#/features/os/host/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

const WORK_DIR = '/ws';
const HOME_DIR = '/home/user';

type FakeFs = OsFsPort & {
  readonly set: (path: string, content: string) => void;
  readonly drop: (path: string) => void;
};

function createFakeFs(): FakeFs {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const dirs = new Set<string>(['/']);
  let clock = 0;
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const key = (path: string): string => normalize(path);
  const addDir = (dir: string): void => {
    let current = dir;
    for (;;) {
      dirs.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  const read = (path: string): { content: string; mtimeMs: number } => {
    const file = files.get(key(path));
    if (file === undefined) throw enoent();
    return file;
  };
  const stat = (path: string) => {
    const p = key(path);
    const file = files.get(p);
    if (file !== undefined) {
      return { isFile: true, isDirectory: false, size: file.content.length, mtimeMs: file.mtimeMs };
    }
    if (dirs.has(p)) return { isFile: false, isDirectory: true };
    throw enoent();
  };
  return {
    set: (path, content) => {
      addDir(dirname(key(path)));
      clock += 1;
      files.set(key(path), { content, mtimeMs: clock });
    },
    drop: (path) => {
      files.delete(key(path));
    },
    readText: async (path) => read(path).content,
    writeText: async (path, data) => {
      addDir(dirname(key(path)));
      clock += 1;
      files.set(key(path), { content: data, mtimeMs: clock });
    },
    appendText: async (path, data) => {
      const file = read(path);
      clock += 1;
      files.set(key(path), { content: `${file.content}${data}`, mtimeMs: clock });
    },
    readBytes: async (path) => new TextEncoder().encode(read(path).content),
    writeBytes: async (path, data) => {
      addDir(dirname(key(path)));
      clock += 1;
      files.set(key(path), { content: new TextDecoder().decode(data), mtimeMs: clock });
    },
    readLines: async function* (path) {
      yield* read(path).content.split('\n');
    },
    createExclusive: async (path, data) => {
      if (files.has(key(path))) return false;
      addDir(dirname(key(path)));
      clock += 1;
      files.set(key(path), { content: new TextDecoder().decode(data), mtimeMs: clock });
      return true;
    },
    stat: async (path) => stat(path),
    lstat: async (path) => stat(path),
    readdir: async () => [],
    mkdir: async (path) => {
      addDir(key(path));
    },
    remove: async (path) => {
      files.delete(key(path));
    },
    rename: async (from, to) => {
      const file = read(from);
      files.delete(key(from));
      files.set(key(to), file);
    },
    realpath: async (path) => key(path),
  };
}

function createFakeHost(fs: OsFsPort): OsHost {
  return {
    fs,
    process: {
      spawn: () => Promise.reject(new Error('spawn not supported')),
    },
    environment: {
      osKind: 'linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: HOME_DIR,
      ready: Promise.resolve(),
    },
  };
}

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function readScriptRequester(script: readonly (string | null)[]): LoopLlmRequester {
  let index = 0;
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (_rest: GenerateRest, _control) => {
      const action = script[Math.min(index, script.length - 1)];
      index += 1;
      if (action === null) return textOutcome('plain');
      return textOutcome('reading', [
        {
          type: 'function',
          id: `read-${index}`,
          name: 'Read',
          arguments: JSON.stringify({ file_path: action }),
        },
      ]);
    },
  };
  return self;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(
  harness: Harness,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function captureFacade(): { feature: Feature<void>; face: () => AgentsMdReminderFace | undefined } {
  let exposed: Readonly<ShallowRef<AgentsMdReminderFace | undefined>> | undefined;
  const feature = createFeature('agents-md-reminder-probe', {
    agent: () => {
      exposed = useInject(AgentsMdReminderRef);
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'Read ok' }] }),
      });
    },
  });
  return { feature, face: () => exposed?.value };
}

describe('agentsMdReminder feature', () => {
  it('discovers AGENTS.md near tool targets, reminds once and stays silent on later access', async () => {
    const fs = createFakeFs();
    fs.set('/ws/sub/AGENTS.md', 'sub instructions');
    fs.set('/ws/sub/code.ts', 'code');
    fs.set('/ws/sub/more.ts', 'more');
    const harness = createHarness({ space: memoryHarnessSpace() });
    const probe = captureFacade();
    await harness.app.features.add(createAgentsMdReminder({ workDir: WORK_DIR, host: createFakeHost(fs) }));
    await harness.app.features.add(probe.feature);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', readScriptRequester([
      '/ws/sub/code.ts',
      null,
      '/ws/sub/AGENTS.md',
      null,
      '/ws/sub/more.ts',
      null,
    ]));
    const discovered: string[] = [];
    const changed: string[] = [];
    agent.loop.subscribe((event) => {
      if (event.type !== 'prompt.reminded') return;
      if (event.entry.meta?.key === AGENTS_MD_DISCOVERY_REMIND_KEY) {
        discovered.push(extractText(event.entry.message));
      }
      if (event.entry.meta?.key === AGENTS_MD_CHANGE_REMIND_KEY) {
        changed.push(extractText(event.entry.message));
      }
    });

    await agent.loop.runTurn(user('start'));
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toContain('/ws/sub/AGENTS.md');
    expect(discovered[0]).toContain('were not included in your system prompt');

    await agent.loop.runTurn(user('read the instructions file itself'));
    expect(discovered).toHaveLength(1);

    await agent.loop.runTurn(user('read more in the same dir'));
    expect(discovered).toHaveLength(1);
    expect(changed).toHaveLength(0);

    await agent.flush();
    const entries = agent.view
      .getState()
      .messages.filter((entry) => entry.meta?.key === AGENTS_MD_DISCOVERY_REMIND_KEY);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message.role).toBe('user');
    expect(extractText(entries[0]!.message)).toContain('- /ws/sub/AGENTS.md');
    await harness.close();
  });

  it('reminds when a seeded AGENTS.md changes on disk, dedupes polls and reports deletion', async () => {
    const fs = createFakeFs();
    fs.set('/ws/AGENTS.md', 'root instructions v1');
    const harness = createHarness({ space: memoryHarnessSpace() });
    const probe = captureFacade();
    await harness.app.features.add(createAgentsMdReminder({ workDir: WORK_DIR, host: createFakeHost(fs) }));
    await harness.app.features.add(probe.feature);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', readScriptRequester([null, null, null, null]));
    const reminded: string[] = [];
    agent.loop.subscribe((event) => {
      if (event.type !== 'prompt.reminded') return;
      if (event.entry.meta?.key === AGENTS_MD_CHANGE_REMIND_KEY) {
        reminded.push(extractText(event.entry.message));
      }
    });

    probe.face()?.seed(['/ws/AGENTS.md']);
    await tick();

    fs.set('/ws/AGENTS.md', 'root instructions v2');
    await agent.loop.runTurn(user('first'));
    expect(reminded).toHaveLength(1);
    expect(reminded[0]).toContain('/ws/AGENTS.md');
    expect(reminded[0]).toContain('changed on disk');
    expect(reminded[0]).not.toContain('(deleted)');

    await agent.loop.runTurn(user('second'));
    expect(reminded).toHaveLength(1);

    fs.drop('/ws/AGENTS.md');
    await agent.loop.runTurn(user('third'));
    expect(reminded).toHaveLength(2);
    expect(reminded[1]).toContain('- /ws/AGENTS.md (deleted)');

    await agent.loop.runTurn(user('fourth'));
    await agent.flush();
    const entries = agent.view
      .getState()
      .messages.filter((entry) => entry.meta?.key === AGENTS_MD_CHANGE_REMIND_KEY);
    expect(entries).toHaveLength(2);
    await harness.close();
  });
});
