/**
 * Scenario: per-agent prompt scheduling and launch-failure settlement.
 *
 * Exercises `IAgentPromptService` through DI with controlled context, loop,
 * wire, compaction, and tool-execution collaborators.
 * Run: `pnpm exec vitest run packages/agent-core-v2/test/agent/prompt/promptService.test.ts`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type Step, type StepAssignment } from '#/agent/loop/loop';
import type { StepRequest } from '#/agent/loop/stepRequest';
import { buildDaemonFileUrl, foldMediaPathTagRefs } from '#/agent/media/mediaRef';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentPromptService } from '#/agent/prompt/promptService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { type GetResult, IFileService } from '#/app/file/fileService';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { IWireService } from '#/wire/wire';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire } from '../loop/stubs';
import { registerStateServices } from '../../state/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function stubFileService(
  files: Map<string, { name: string; bytes: Buffer; mime?: string; stream?: () => Readable }>,
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
          media_type: file.mime ?? 'image/png',
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
    homeDir?: string;
    files?: Map<string, { name: string; bytes: Buffer; mime?: string; stream?: () => Readable }>;
    fullCompaction?: IAgentFullCompactionService;
  } = {},
) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const loop = stubLoopWithHooks({ pendingTurnResult: true });
  const fullCompaction = opts.fullCompaction ?? ({
    _serviceBrand: undefined,
    compacting: null,
    begin: () => false,
    hooks: createHooks(['onWillCompact']),
    onDidFinishCompaction: Event.None,
  } as unknown as IAgentFullCompactionService);
  const sessionDir = opts.sessionDir ?? '/nonexistent-session';
  const homeDir = opts.homeDir ?? dirname(sessionDir);
  const sessionScope = opts.homeDir === undefined ? basename(sessionDir) : relative(homeDir, sessionDir);
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
      reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
      reg.defineInstance(ISessionContext, makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir,
        sessionScope,
        cwd: '/tmp',
      }));
      reg.defineInstance(IFileSystemStorageService, new FileStorageService(homeDir));
      reg.define(ISessionMediaStore, SessionMediaStoreService);
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

  it('seeds the launched turn with the prompt record id', async () => {
    const { prompt, loop, context } = harness();
    const handle = await prompt.enqueue({ id: 'prompt-1', message: message('hello') });
    await handle.launched;
    const batch = loop.drainNextBatch(context);
    expect(batch?.driver.turnSeed?.promptId).toBe('prompt-1');
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

  it('drains queued prompts before an agent scope is disposed', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('queued') });

    await prompt.drain(new Error('agent removed'));

    await expect(queued.completion).resolves.toMatchObject({ state: 'cancelled' });
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

  it('materializes a bare daemon reference into the session media dir and authors its paired tag', async () => {
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
    await handle.launched;

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expect(handle.message.content).toEqual([
      { type: 'text', text: `<image path="${target}"></image>` },
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
    const fold = foldMediaPathTagRefs(handle.message.content);
    expect(fold.parts).toEqual([
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
    expect(fold.media).toEqual([{ kind: 'image', ref: { fileId: 'f_1', path: target }, path: target }]);
  });

  it('authors a paired video tag for a bare video daemon reference', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_v', { name: 'clip.mp4', bytes: PNG_BYTES, mime: 'video/mp4' }]]);
    const { prompt } = harness({ sessionDir, files });

    const handle = await prompt.enqueue({
      id: 'prompt-video',
      message: {
        role: 'user',
        content: [{ type: 'video_url', videoUrl: { url: buildDaemonFileUrl('f_v') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;

    const target = join(sessionDir, 'media', 'f_v.mp4');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expect(handle.message.content).toEqual([
      { type: 'text', text: `<video path="${target}"></video>` },
      { type: 'video_url', videoUrl: { url: buildDaemonFileUrl('f_v', target) } },
    ]);
  });

  it('falls back to the shared cache dir when the session media store cannot write', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'prompt-intake-home-'));
    onTestFinished(() => rm(homeDir, { recursive: true, force: true }));
    const sessionDir = join(homeDir, 'sessions', 's1');
    await mkdir(sessionDir, { recursive: true });
    // A regular file squatting on the media dir name fails the canonical write.
    await writeFile(join(sessionDir, 'media'), 'occupied');
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, homeDir, files });

    const handle = await prompt.enqueue({
      id: 'prompt-fallback',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;

    const target = join(homeDir, 'cache', 'f_1.png');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expect(handle.message.content).toEqual([
      { type: 'text', text: `<image path="${target}"></image>` },
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
  });

  it('returns the first idle media prompt before intake resolves', async () => {
    const sessionDir = await tmpSessionDir();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const files = new Map([
      ['f_slow', {
        name: 'slow.png',
        bytes: PNG_BYTES,
        stream: () => Readable.from((async function* () {
          await gate;
          yield PNG_BYTES;
        })()),
      }],
    ]);
    const { prompt } = harness({ sessionDir, files });

    const handle = await prompt.enqueue({
      id: 'media-idle-first',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_slow') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    expect(handle.state).toBe('pending');
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
    open();
    await expect(handle.launched).resolves.toBeDefined();
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
    await handle.launched;

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(handle.message.content).toEqual([
      { type: 'text', text: `<image path="${target}"></image>` },
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
  });

  it('keeps an already-normalized pair untouched when intake runs over it again', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });
    const target = join(sessionDir, 'media', 'f_1.png');

    const first = await prompt.enqueue({
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await first.launched;
    const second = await prompt.enqueue({
      message: {
        role: 'user',
        content: [...first.message.content],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    const normalized = [
      { type: 'text', text: `<image path="${target}"></image>` },
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ];
    expect(first.message.content).toEqual(normalized);
    expect(second.message.content).toEqual(normalized);
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

  it('keeps arrival order without making a queued text prompt wait for a slow media intake', async () => {
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
    const textRecord = await textHandle;
    expect(textRecord.state).toBe('pending');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['text-second']);
    open();

    const mediaRecord = await mediaHandle;
    await mediaRecord.launched;
    expect(prompt.list().active?.id).toBe('media-first');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['text-second']);
  });

  it('settles and stops an abort that lands while media intake is running', async () => {
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

    const handlePromise = prompt.enqueue({
      id: 'media-abort',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_slow') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    expect(prompt.abort('media-abort')).toBe(true);
    const handle = await handlePromise;
    expect(handle.state).toBe('cancelled');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    open();
    await prompt.drain();
    await expect(readFile(join(sessionDir, 'media', 'f_slow.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('normalizes a queued daemon reference before a steer consumes it', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt, context, loop } = harness({ sessionDir, files });

    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-media',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await prompt.steer([queued.id]);
    loop.drainNextBatch(context);

    const target = join(sessionDir, 'media', 'f_1.png');
    const parts = context.get().flatMap((entry) => entry.content);
    const images = parts.filter((part) => part.type === 'image_url');
    expect(images).toEqual([
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1', target) } },
    ]);
  });

  it('does not write context or launch when an abort lands during the before-submit hook', async () => {
    const { prompt, context, loop, eventBus } = harness();
    let hookEntered!: () => void;
    let releaseHook!: () => void;
    const hookRunning = new Promise<void>((resolve) => { hookEntered = resolve; });
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
    prompt.hooks.onBeforeSubmitPrompt.register('gate', async (_ctx, next) => {
      hookEntered();
      await hookGate;
      await next();
    });
    const events: string[] = [];
    eventBus.subscribe('prompt.completed', () => events.push('completed'));
    eventBus.subscribe('prompt.aborted', () => events.push('aborted'));

    const handlePromise = prompt.enqueue({ id: 'hooked', message: message('hi') });
    await hookRunning;
    expect(prompt.abort('hooked')).toBe(true);
    releaseHook();

    const handle = await handlePromise;
    expect(handle.state).toBe('cancelled');
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(loop.launches).toEqual([]);
    expect(context.get()).toEqual([]);
    expect(events).toEqual(['aborted']);
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('requeues once while compaction runs and launches when compaction finishes', async () => {
    const sessionDir = await tmpSessionDir();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
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
    const finishListeners: Array<() => void> = [];
    const compactionState: { current: unknown } = { current: null };
    const compaction = {
      _serviceBrand: undefined,
      get compacting() { return compactionState.current; },
      begin: () => false,
      hooks: createHooks(['onWillCompact']),
      onDidFinishCompaction: (listener: () => void) => {
        finishListeners.push(listener);
        return { dispose: () => undefined };
      },
    } as unknown as IAgentFullCompactionService;
    const { prompt, loop } = harness({ sessionDir, files, fullCompaction: compaction });

    const handlePromise = prompt.enqueue({
      id: 'media-compacted',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_slow') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    compactionState.current = { pass: 'manual' };
    open();
    await vi.waitFor(() => {
      expect(prompt.list().pending.map((item) => item.id)).toEqual(['media-compacted']);
    });
    expect(loop.launches).toEqual([]);

    compactionState.current = null;
    for (const listener of finishListeners) listener();
    const handle = await handlePromise;
    await handle.launched;
    expect(handle.state).toBe('running');
    expect(prompt.list().active?.id).toBe('media-compacted');
  });

  it('frees the launch slot for the next prompt when an abort lands during a hung intake', async () => {
    const sessionDir = await tmpSessionDir();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const hungStream = () =>
      Readable.from(
        (async function* () {
          await gate;
          yield PNG_BYTES;
        })(),
      );
    const files = new Map([
      ['f_hung', { name: 'hung.png', bytes: PNG_BYTES, stream: hungStream }],
    ]);
    const { prompt } = harness({ sessionDir, files });

    const mediaPromise = prompt.enqueue({
      id: 'media-hung',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_hung') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    expect(prompt.abort('media-hung')).toBe(true);
    await mediaPromise;

    const textHandle = await prompt.enqueue({ id: 'text-after', message: message('plain') });
    await textHandle.launched;
    expect(textHandle.state).toBe('running');
    expect(prompt.list().active?.id).toBe('text-after');

    open();
    await prompt.drain();
    await expect(readFile(join(sessionDir, 'media', 'f_hung.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cancels a reserved steer when its active turn finishes during intake', async () => {
    const sessionDir = await tmpSessionDir();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const files = new Map([
      ['f_slow', {
        name: 'slow.png',
        bytes: PNG_BYTES,
        stream: () => Readable.from((async function* () {
          await gate;
          yield PNG_BYTES;
        })()),
      }],
    ]);
    const { prompt, loop } = harness({ sessionDir, files });

    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'reserved-steer',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_slow') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const steerPromise = prompt.steer([queued.id]);
    expect(prompt.list().pending).toEqual([]);
    loop.finishActive();
    open();

    await expect(steerPromise).rejects.toThrow(/cancelled/);
    await expect(queued.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(loop.launches).toEqual([0]);
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('rejects a steer whose prompt was cleared while its intake was still running', async () => {
    const sessionDir = await tmpSessionDir();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
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

    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'steered-away',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_slow') } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const steerPromise = prompt.steer([queued.id]);
    void steerPromise.catch(() => undefined);
    prompt.clear();
    open();

    await expect(steerPromise).rejects.toThrow(/cancelled/);
    expect(queued.state).toBe('cancelled');
    await expect(queued.completion).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('keeps an abort that lands while a steer awaits its step assignment', async () => {
    const { prompt, loop, eventBus } = harness();
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    const activeTurn = await active.launched;
    const queued = await prompt.enqueue({ id: 'steer-me', message: message('steer me') });

    // Hold the steer request's step assignment so the abort lands mid-flight.
    let assign!: (assignment: StepAssignment) => void;
    let steerRequest!: StepRequest;
    const originalEnqueue = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request.kind !== 'steer') return originalEnqueue(request, options);
      steerRequest = request;
      const assigned = new Promise<StepAssignment>((resolve) => { assign = resolve; });
      void assigned.catch(() => undefined);
      return { assigned, abort: () => request.abort() };
    });
    const events: string[] = [];
    eventBus.subscribe('prompt.steered', () => events.push('steered'));
    eventBus.subscribe('prompt.aborted', () => events.push('aborted'));

    const steerPromise = prompt.steer([queued.id]);
    void steerPromise.catch(() => undefined);
    await vi.waitFor(() => expect(steerRequest).toBeDefined());

    // The abort settles the prompt as cancelled inside the assignment window;
    // the steer must not flip it back to 'steered', and the undispatched
    // request must be discarded so its content never reaches the context.
    expect(prompt.abort(queued.id)).toBe(true);
    const step: Step = {
      id: steerRequest.id,
      turnId: activeTurn!.id,
      state: 'queued',
      signal: new AbortController().signal,
      result: Promise.resolve({ type: 'completed' }),
      cancel: () => steerRequest.abort(),
    };
    assign({ turn: activeTurn!, step });

    await expect(steerPromise).rejects.toThrow(/steer was cancelled/);
    expect(queued.state).toBe('cancelled');
    await expect(queued.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(steerRequest.aborted).toBe(true);
    expect(events).toEqual(['aborted']);
  });
});
