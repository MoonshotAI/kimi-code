/**
 * Scenario: per-agent prompt scheduling and launch-failure settlement.
 *
 * Exercises `IAgentPromptService` through DI with controlled context, loop,
 * wire, compaction, and tool-execution collaborators.
 * Run: `pnpm exec vitest run packages/agent-core-v2/test/agent/prompt/promptService.test.ts`.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { buildDaemonFileUrl } from '#/agent/media/mediaRef';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { type GetResult, IFileService } from '#/app/file/fileService';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService } from '#/wire/wire';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire } from '../loop/stubs';
import { registerStateServices } from '../../state/stubs';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function stubFileService(
  files: Map<string, { name: string; bytes: Buffer; stream?: () => Readable }>,
): IFileService {
  return {
    _serviceBrand: undefined,
    save: async () => {
      throw new Error('unused');
    },
    delete: async () => {},
    get: async (fileId): Promise<GetResult> => {
      const file = files.get(fileId);
      if (file === undefined) throw new Error(`file not found: ${fileId}`);
      return {
        meta: {
          id: fileId,
          name: file.name,
          media_type: 'image/png',
          size: file.bytes.length,
          created_at: new Date(0).toISOString(),
        },
        stream: file.stream ?? (() => Readable.from([file.bytes])),
      };
    },
  };
}

function harness(
  opts: {
    sessionDir?: string;
    files?: Map<string, { name: string; bytes: Buffer; stream?: () => Readable }>;
  } = {},
) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const loop = stubLoopWithHooks({ pendingTurnResult: true });
  const fullCompaction = {
    _serviceBrand: undefined,
    compacting: null,
    begin: () => false,
    hooks: createHooks(['onWillCompact']),
    onDidFinishCompaction: Event.None,
  } as unknown as IAgentFullCompactionService;
  const ix = createServices(disposables, {
    strict: true, additionalServices: (reg) => {
      registerStateServices(reg);
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentLoopService, loop);
      reg.defineInstance(IWireService, stubWire());
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
      reg.defineInstance(IAgentFullCompactionService, fullCompaction);
      reg.define(IEventBus, EventBusService);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.defineInstance(IFileService, stubFileService(opts.files ?? new Map()));
      reg.defineInstance(
        ISessionMediaStore,
        new SessionMediaStoreService(
          makeSessionContext({
            sessionId: 's1',
            workspaceId: 'w1',
            sessionDir: opts.sessionDir ?? '/nonexistent-session',
            sessionScope: 'sessions/w1/s1',
            cwd: '/tmp',
          }),
        ),
      );
      reg.define(IAgentPromptService, AgentPromptService);
    }
  });
  return { prompt: ix.get(IAgentPromptService), loop, context, fullCompaction, eventBus: ix.get(IEventBus) };
}

describe('AgentPromptService', () => {
  it('assigns stable identity and launches an idle prompt', async () => {
    const { prompt } = harness();
    const handle = await prompt.enqueue({ id: 'prompt-1', message: message('hello') });
    expect(handle.id).toBe('prompt-1');
    expect(handle.userMessageId).toBe('prompt-1');
    expect((await handle.launched)?.id).toBe(0);
  });

  it('keeps later prompts in FIFO order while active', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const first = await prompt.enqueue({ message: message('one') });
    const second = await prompt.enqueue({ message: message('two') });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('publishes prompt.queued only for prompts that cannot launch immediately', async () => {
    const { prompt, eventBus } = harness();
    const queued: Array<{ promptId: string; queueLength: number }> = [];
    eventBus.subscribe('prompt.queued', (e) => {
      queued.push({ promptId: e.promptId, queueLength: e.queueLength });
    });

    await prompt.enqueue({ id: 'active', message: message('active') });
    expect(queued).toEqual([]);

    await prompt.enqueue({ id: 'waiting', message: message('waiting') });
    expect(queued).toEqual([{ promptId: 'waiting', queueLength: 1 }]);
  });

  it('atomically rejects steer when any id is not pending', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('one') });
    await expect(prompt.steer([queued.id, 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([queued.id]);
  });

  it('steers selected prompts in FIFO order', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: message('one') });
    const two = await prompt.enqueue({ message: message('two') });
    const handles = await prompt.steer([two.id, one.id]);
    expect(handles.map((item) => item.id)).toEqual([one.id, two.id]);
    loop.drainNextBatch(context);
  });

  it('aborts pending prompts and settles completion', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const handle = await prompt.enqueue({ message: message('queued') });
    expect(prompt.abort(handle.id)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(prompt.list().pending).toEqual([]);
  });

  it('keeps injections outside the prompt queue', async () => {
    const { prompt } = harness();
    await prompt.inject({ ...message('system'), origin: { kind: 'injection', variant: 'test' } });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('settles blocked prompts', async () => {
    const { prompt } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({ message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
  });

  it('settles the prompt as failed when the loop throws on launch', async () => {
    const { prompt, loop } = harness();
    vi.spyOn(loop, 'enqueue').mockImplementation(() => {
      throw new Error2(ErrorCodes.TURN_AGENT_BUSY, 'Cannot launch a new turn while another turn is active');
    });
    const handle = await prompt.enqueue({ id: 'prompt-x', message: message('hello') });
    expect(handle.state).toBe('failed');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'failed', result: undefined });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('replaces an unsupported prompt image with a text notice at the history funnel', async () => {
    const { prompt, context, loop } = harness();
    const avifUrl = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const handle = await prompt.enqueue({
      id: 'prompt-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;
    loop.drainNextBatch(context);

    const appended = context.get();
    expect(appended).toHaveLength(1);
    const parts = appended[0]!.content;
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('image/avif');
  });

  it('gates steered prompt images too', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const avifUrl = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await prompt.steer([queued.id]);
    loop.drainNextBatch(context);

    const appended = context.get();
    const parts = appended.flatMap((entry) => entry.content);
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(
      parts.some((part) => part.type === 'text' && part.text.includes('image/avif')),
    ).toBe(true);
  });
});

describe('AgentPromptService daemon media intake', () => {
  const PNG_BYTES = Buffer.from('fake png bytes');

  async function tmpSessionDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'prompt-intake-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it('materializes a bare daemon reference into the session media dir and stamps its path', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });

    const handle = await prompt.enqueue({
      id: 'prompt-media',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expect(handle.message.content).toEqual([
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
  });

  it('rewrites a client-cache tag+reference pair to the session media dir', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });
    const clientPath = '/client-cache/f_1.png';

    const handle = await prompt.enqueue({
      id: 'prompt-pair',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `<image path="${clientPath}"></image>` },
          { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', clientPath) } },
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(handle.message.content).toEqual([
      { type: 'text', text: `<image path="${target}"></image>` },
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
  });

  it('keeps an already-canonical reference untouched', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });
    const target = join(sessionDir, 'media', 'f_1.png');
    const url = buildDaemonFileUrl('f_1', target);

    const first = await prompt.enqueue({
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const second = await prompt.enqueue({
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    expect(first.message.content).toEqual([{ type: 'image_url', imageUrl: { url } }]);
    expect(second.message.content).toEqual([{ type: 'image_url', imageUrl: { url } }]);
    expect((await readFile(target)).length).toBe(PNG_BYTES.length);
  });

  it('keeps the original reference when the upload cannot be read', async () => {
    const sessionDir = await tmpSessionDir();
    const { prompt } = harness({ sessionDir, files: new Map() });
    const url = buildDaemonFileUrl('f_missing', '/client-cache/x.png');

    const handle = await prompt.enqueue({
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    expect(handle.message.content).toEqual([{ type: 'image_url', imageUrl: { url } }]);
  });

  it('keeps arrival order while a slow media intake holds up the queue', async () => {
    const sessionDir = await tmpSessionDir();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slowStream = () =>
      Readable.from(
        (async function* () {
          await gate;
          yield PNG_BYTES;
        })(),
      );
    const files = new Map([
      ['f_slow', { name: 'slow.png', bytes: PNG_BYTES, stream: slowStream }],
    ]);
    const { prompt } = harness({ sessionDir, files });

    const mediaHandle = prompt.enqueue({
      id: 'media-first',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_slow') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const textHandle = prompt.enqueue({ id: 'text-second', message: message('plain') });
    open();

    await mediaHandle;
    await textHandle;
    expect(prompt.list().active?.id).toBe('media-first');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['text-second']);
  });
});
