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
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type Step, type StepAssignment } from '#/agent/loop/loop';
import type { StepRequest } from '#/agent/loop/stepRequest';
import { buildDaemonFileUrl } from '#/agent/media/mediaRef';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { IAgentPromptService, reservePrompt } from '#/agent/prompt/prompt';
import { promptAccepted, PromptAdmissionModel } from '#/agent/prompt/promptOps';
import { AgentPromptService } from '#/agent/prompt/promptService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { EventBusService } from '#/app/event/eventBusService';
import { type GetResult, IFileService } from '#/app/file/fileService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ContentPart } from '#/kosong/contract/message';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IWireService } from '#/wire/wire';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire } from '../loop/stubs';
import { registerStateServices } from '../../state/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import {
  recordingWireLog,
  registerTestAgentWire,
  restoreTestAgentWire,
  testWireScope,
} from '../../wire/stubs';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function stubFileService(
  files: Map<string, { name: string; bytes: Buffer; mime?: string; stream?: () => Readable }>,
  onGet?: (fileId: string) => void,
): IFileService {
  return {
    _serviceBrand: undefined,
    save: async () => {
      throw new Error('unused');
    },
    delete: async () => {},
    get: async (fileId): Promise<GetResult> => {
      onGet?.(fileId);
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
    fileGets?: string[];
    fullCompaction?: IAgentFullCompactionService;
    wire?: IWireService;
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
      reg.defineInstance(IWireService, opts.wire ?? stubWire());
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
      reg.definePartialInstance(IAgentToolPolicyService, {
        setSessionDisabledTools: async () => {},
      });
      reg.defineInstance(IAgentFullCompactionService, fullCompaction);
      reg.define(IEventBus, EventBusService);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.defineInstance(
        IFileService,
        stubFileService(opts.files ?? new Map(), (fileId) => opts.fileGets?.push(fileId)),
      );
      reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
      reg.defineInstance(ISessionContext, makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir,
        sessionScope,
        cwd: '/tmp',
      }));
      reg.defineInstance(IFileSystemStorageService, new FileStorageService(homeDir));
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
      reg.define(ISessionMediaStore, SessionMediaStoreService);
      reg.define(IAgentPromptService, AgentPromptService);
      reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
      reg.definePartialInstance(ISessionMetadata, {
        read: async () => ({ id: 'test-session', createdAt: 0, updatedAt: 0, archived: false }),
        update: async () => {},
      });
      reg.definePartialInstance(IEventService, { publish: () => {} });
      reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
    }
  });
  return { prompt: ix.get(IAgentPromptService), loop, context, fullCompaction, eventBus: ix.get(IEventBus) };
}

describe('AgentPromptService', () => {
  it('rejects an empty caller-chosen id before queue admission', async () => {
    const { prompt } = harness();

    await expect(prompt.enqueue({ id: '', message: message('hello') })).rejects.toMatchObject({
      code: 'request.invalid',
    });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('atomically rejects a second live reservation for the same id', () => {
    const { prompt } = harness();
    const first = reservePrompt(prompt, 'submission-1');

    expect(() => reservePrompt(prompt, 'submission-1')).toThrowError(
      expect.objectContaining({ code: 'prompt.id_conflict' }),
    );

    first.dispose();
    expect(reservePrompt(prompt, 'submission-1').id).toBe('submission-1');
  });

  it('rejects a duplicate id before daemon media intake or queue events', async () => {
    const fileGets: string[] = [];
    const files = new Map([['f_duplicate', { name: 'duplicate.png', bytes: Buffer.from('png') }]]);
    const { prompt, eventBus } = harness({ files, fileGets });
    const queued: string[] = [];
    eventBus.subscribe('prompt.queued', (event) => queued.push(event.promptId));
    await prompt.enqueue({ id: 'submission-1', message: message('first') });

    await expect(
      prompt.enqueue({
        id: 'submission-1',
        message: {
          role: 'user',
          content: [{ type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_duplicate') } }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
    ).rejects.toMatchObject({ code: 'prompt.id_conflict' });

    expect(fileGets).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('rejects reuse after the original prompt reaches a terminal state', async () => {
    const { prompt, loop } = harness();
    const first = await prompt.enqueue({ id: 'submission-1', message: message('first') });
    loop.finishActive();
    await first.completion;

    await expect(
      prompt.enqueue({ id: 'submission-1', message: message('retry') }),
    ).rejects.toMatchObject({ code: 'prompt.id_conflict' });
  });

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

  it('delivers a blocked prompt’s compression captions right after their host message', async () => {
    const { prompt, context } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({
      id: 'prompt-caption',
      message: message(
        '<system>Image compressed to fit model limits: 800x600</system>look at this',
      ),
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });

    const history = context.get();
    expect(history).toHaveLength(2);
    expect(history[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'image_compression',
      ownerPromptId: 'prompt-caption',
    });
    expect(history[1]?.origin).toEqual({ kind: 'user' });
    expect(history[1]?.content).toEqual([{ type: 'text', text: 'look at this' }]);
    const captionPart = history[0]?.content[0];
    expect(captionPart?.type).toBe('text');
    expect((captionPart as { text: string }).text).toContain(
      'Image compressed to fit model limits: 800x600',
    );
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

describe('prompt admission wire model', () => {
  it('restores accepted ids from the persisted journal', async () => {
    const disposables = new DisposableStore();
    onTestFinished(() => {
      disposables.dispose();
    });
    const records: Array<{ type: string; [key: string]: unknown }> = [];
    const sourceIx = disposables.add(new TestInstantiationService());
    const source = registerTestAgentWire(sourceIx, testWireScope('prompt', 'source'), {
      log: recordingWireLog(records),
    });
    source.dispatch(promptAccepted({ promptId: 'persisted-submission' }));

    const replayRecords = records.map((record) => ({ ...record }));
    const replayLog = recordingWireLog([]);
    const replayIx = disposables.add(new TestInstantiationService());
    const replay = registerTestAgentWire(replayIx, testWireScope('prompt', 'replay'), {
      log: replayLog,
    });
    await restoreTestAgentWire(
      replay,
      replayLog,
      testWireScope('prompt', 'replay'),
      replayRecords,
    );

    expect(replay.getModel(PromptAdmissionModel).has('persisted-submission')).toBe(true);
  });
});

describe('AgentPromptService daemon media intake', () => {
  const PNG_BYTES = Buffer.from('fake png bytes');

  async function tmpSessionDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'prompt-intake-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  function mediaMessage(...content: ContentPart[]): ContextMessage {
    return { role: 'user', content, toolCalls: [], origin: { kind: 'user' } };
  }

  function enqueueMedia(
    prompt: IAgentPromptService,
    opts: { id?: string; fileId: string; kind?: 'image' | 'video'; path?: string; withTag?: boolean },
  ) {
    const kind = opts.kind ?? 'image';
    const url = buildDaemonFileUrl(opts.fileId);
    const ref: ContentPart =
      kind === 'video'
        ? { type: 'video_url', videoUrl: { url } }
        : { type: 'image_url', imageUrl: { url } };
    const content: ContentPart[] =
      opts.withTag === true && opts.path !== undefined
        ? [{ type: 'text', text: `<${kind} path="${opts.path}"></${kind}>` }, ref]
        : [ref];
    return prompt.enqueue({ id: opts.id, message: mediaMessage(...content) });
  }

  function gatedImage(fileId = 'f_slow') {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const files = new Map([
      [
        fileId,
        {
          name: `${fileId}.png`,
          bytes: PNG_BYTES,
          stream: () =>
            Readable.from(
              (async function* () {
                await gate;
                yield PNG_BYTES;
              })(),
            ),
        },
      ],
    ]);
    return { files, open };
  }

  function expectMediaRef(
    content: readonly ContentPart[],
    fileId: string,
    kind: 'image' | 'video' = 'image',
  ): void {
    expect(content).toEqual([
      kind === 'video'
        ? { type: 'video_url', videoUrl: { url: buildDaemonFileUrl(fileId) } }
        : { type: 'image_url', imageUrl: { url: buildDaemonFileUrl(fileId) } },
    ]);
  }

  it('materializes a bare daemon reference into the session media dir', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });

    const handle = await enqueueMedia(prompt, { id: 'prompt-media', fileId: 'f_1' });
    await handle.launched;

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expectMediaRef(handle.message.content, 'f_1');
  });

  it('materializes a bare video daemon reference into the session media dir', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_v', { name: 'clip.mp4', bytes: PNG_BYTES, mime: 'video/mp4' }]]);
    const { prompt } = harness({ sessionDir, files });

    const handle = await enqueueMedia(prompt, { id: 'prompt-video', fileId: 'f_v', kind: 'video' });
    await handle.launched;

    const target = join(sessionDir, 'media', 'f_v.mp4');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expectMediaRef(handle.message.content, 'f_v', 'video');
  });

  it('keeps the upload-backed reference when the session media store cannot write', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'prompt-intake-home-'));
    onTestFinished(() => rm(homeDir, { recursive: true, force: true }));
    const sessionDir = join(homeDir, 'sessions', 's1');
    await mkdir(sessionDir, { recursive: true });
    // A regular file squatting on the media dir name fails the canonical write.
    await writeFile(join(sessionDir, 'media'), 'occupied');
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, homeDir, files });

    const handle = await enqueueMedia(prompt, { id: 'prompt-unwritable', fileId: 'f_1' });
    await handle.launched;

    // No fallback copy: the reference stays bare, so the request-time
    // resolver keeps serving the bytes from the daemon upload while it lives.
    expect(handle.message.content).toEqual([
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } },
    ]);
    await expect(readFile(join(homeDir, 'cache', 'f_1.png'))).rejects.toThrow();
  });

  it('returns the first idle media prompt before intake resolves', async () => {
    const sessionDir = await tmpSessionDir();
    const { files, open } = gatedImage();
    const { prompt } = harness({ sessionDir, files });

    const handle = await enqueueMedia(prompt, { id: 'media-idle-first', fileId: 'f_slow' });

    expect(handle.state).toBe('pending');
    // Launching but not yet active: the record stays listed as queued during
    // the intake window so `list()` never loses an accepted submission.
    expect(prompt.list().active).toBeUndefined();
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['media-idle-first']);
    open();
    await expect(handle.launched).resolves.toBeDefined();
  });

  it('counts a launching media prompt as queued in the prompt.queued event', async () => {
    const sessionDir = await tmpSessionDir();
    const { files, open } = gatedImage();
    const { prompt, eventBus } = harness({ sessionDir, files });
    const queued: Array<{ promptId: string; queueLength: number }> = [];
    eventBus.subscribe('prompt.queued', (e) => {
      queued.push({ promptId: e.promptId, queueLength: e.queueLength });
    });

    // startNext shifts the record into `launchingItem` before the event is
    // published — the count must still include it.
    const handlePromise = enqueueMedia(prompt, { id: 'media-launching', fileId: 'f_slow' });
    expect(queued).toEqual([{ promptId: 'media-launching', queueLength: 1 }]);

    open();
    await (await handlePromise).launched;
  });

  it('keeps a client-submitted tag+ref pair as-is while materializing the bytes', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });
    const clientPath = '/client-cache/f_1.png';

    const handle = await enqueueMedia(prompt, {
      id: 'prompt-pair',
      fileId: 'f_1',
      path: clientPath,
      withTag: true,
    });
    await handle.launched;

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    expect(handle.message.content).toEqual([
      { type: 'text', text: `<image path="${clientPath}"></image>` },
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } },
    ]);
  });

  it('keeps an already-materialized reference untouched when intake runs over it again', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt } = harness({ sessionDir, files });
    const target = join(sessionDir, 'media', 'f_1.png');

    const first = await enqueueMedia(prompt, { fileId: 'f_1' });
    await first.launched;
    const second = await prompt.enqueue({ message: mediaMessage(...first.message.content) });

    expectMediaRef(first.message.content, 'f_1');
    expectMediaRef(second.message.content, 'f_1');
    expect((await readFile(target)).length).toBe(PNG_BYTES.length);
  });

  it('keeps the original reference when the upload cannot be read', async () => {
    const sessionDir = await tmpSessionDir();
    const { prompt } = harness({ sessionDir, files: new Map() });

    const handle = await enqueueMedia(prompt, { fileId: 'f_missing' });

    expect(handle.message.content).toEqual([
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_missing') } },
    ]);
  });

  it('keeps arrival order without making a queued text prompt wait for a slow media intake', async () => {
    const sessionDir = await tmpSessionDir();
    const { files, open } = gatedImage();
    const { prompt } = harness({ sessionDir, files });

    const mediaHandle = enqueueMedia(prompt, { id: 'media-first', fileId: 'f_slow' });
    const textHandle = prompt.enqueue({ id: 'text-second', message: message('plain') });
    const textRecord = await textHandle;
    expect(textRecord.state).toBe('pending');
    // The media record is launching through its slow intake: still queued in
    // the snapshot, ahead of the text prompt.
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['media-first', 'text-second']);
    open();

    const mediaRecord = await mediaHandle;
    await mediaRecord.launched;
    expect(prompt.list().active?.id).toBe('media-first');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['text-second']);
  });

  it('settles an abort that lands during a hung intake, freeing the launch slot', async () => {
    const sessionDir = await tmpSessionDir();
    const { files, open } = gatedImage();
    const { prompt } = harness({ sessionDir, files });

    const handlePromise = enqueueMedia(prompt, { id: 'media-abort', fileId: 'f_slow' });
    expect(prompt.abort('media-abort')).toBe(true);
    const handle = await handlePromise;
    expect(handle.state).toBe('cancelled');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });

    const textHandle = await prompt.enqueue({ id: 'text-after', message: message('plain') });
    await textHandle.launched;
    expect(textHandle.state).toBe('running');
    expect(prompt.list().active?.id).toBe('text-after');

    open();
    await prompt.drain();
    await expect(readFile(join(sessionDir, 'media', 'f_slow.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(prompt.list().pending).toEqual([]);
  });

  it('materializes a queued daemon reference before a steer consumes it', async () => {
    const sessionDir = await tmpSessionDir();
    const files = new Map([['f_1', { name: 'pic.png', bytes: PNG_BYTES }]]);
    const { prompt, context, loop } = harness({ sessionDir, files });

    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await enqueueMedia(prompt, { id: 'prompt-steer-media', fileId: 'f_1' });
    await prompt.steer([queued.id]);
    loop.drainNextBatch(context);

    const target = join(sessionDir, 'media', 'f_1.png');
    expect(await readFile(target)).toEqual(PNG_BYTES);
    const parts = context.get().flatMap((entry) => entry.content);
    const images = parts.filter((part) => part.type === 'image_url');
    expect(images).toEqual([
      { type: 'image_url', imageUrl: { url: buildDaemonFileUrl('f_1') } },
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
    const { files, open } = gatedImage();
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

    const handlePromise = enqueueMedia(prompt, { id: 'media-compacted', fileId: 'f_slow' });
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

  it('rejects a steer whose prompt was cleared while its intake was still running', async () => {
    const sessionDir = await tmpSessionDir();
    const { files, open } = gatedImage();
    const { prompt } = harness({ sessionDir, files });

    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await enqueueMedia(prompt, { id: 'steered-away', fileId: 'f_slow' });
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
    await vi.waitFor(() => {
      expect(steerRequest).toBeDefined();
    });

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
