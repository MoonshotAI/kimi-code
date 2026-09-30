import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Jimp } from 'jimp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigRef,
  UNKNOWN_CAPABILITY,
  createConfig,
  createFeature,
  createMediaLowerer,
  createMemoryMediaStore,
  createMemoryMediaUploadCache,
  createUserMessage,
  dataUrlOf,
  isMediaPart,
  MAIN_AGENT_ID,
  mediaContextOf,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  type AgentHandle,
  type ConfigPersist,
  type ContentPart,
  type FeatureSpec,
  type HistoryMessage,
  type LlmModel,
  type LlmRequestContent,
  type LlmRequester,
  type MediaContent,
  type MediaPart,
  type MediaStore,
  type Message,
  type SessionStores,
  type ToolDescription,
  type ToolMessage,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { createMedia, IMAGE_CONFIG_SECTION, type ImageConfig } from '#/features/media/index';
import { createNodeOsHost } from '#/features/os/host/index';

const visionModel: LlmModel = {
  provider: 'test',
  model: 'vision-model',
  capability: { ...UNKNOWN_CAPABILITY, image_in: true, video_in: true },
};

const plainModel: LlmModel = { provider: 'test', model: 'plain-model', capability: UNKNOWN_CAPABILITY };

interface LlmCall {
  readonly messages: readonly Message[];
  readonly wire: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function withMediaUrl(part: MediaPart, url: string): ContentPart {
  if (part.type === 'image_url') return { ...part, imageUrl: { ...part.imageUrl, url } };
  if (part.type === 'video_url') return { ...part, videoUrl: { ...part.videoUrl, url } };
  return { ...part, audioUrl: { ...part.audioUrl, url } };
}

async function lowerForWire(
  messages: readonly Message[],
  content: LlmRequestContent,
  model: LlmModel,
): Promise<readonly Message[]> {
  if (content.media === undefined) return messages;
  const materialize = createMediaLowerer(mediaContextOf({ model, media: content.media }));
  const out: Message[] = [];
  for (const message of messages) {
    let changed = false;
    const parts: ContentPart[] = [];
    for (const part of message.content) {
      if (!isMediaPart(part)) {
        parts.push(part);
        continue;
      }
      const media = await materialize(part);
      changed = true;
      if (media.form === 'inline') {
        parts.push(withMediaUrl(part, dataUrlOf(media.mimeType, media.data)));
      } else if (media.form === 'file') {
        parts.push(withMediaUrl(part, media.url));
      } else {
        parts.push({ type: 'text', text: media.text });
      }
    }
    out.push(changed ? { ...message, content: parts } : message);
  }
  return out;
}

function createMockRequester(script: LlmScript): { requester: LlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: {
      generate: async (config, content, { onEvent }) => {
        const call: LlmCall = {
          messages: content.messages,
          wire: await lowerForWire(content.messages, content, config.model),
          tools: content.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        if ('toolCall' in out) {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
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
    },
  };
}

function readMediaScript(...argsList: Record<string, unknown>[]): LlmScript {
  let index = 0;
  return (call) => {
    if (call.messages.at(-1)?.role === 'tool') return { text: 'done' };
    const args = argsList[Math.min(index, argsList.length - 1)];
    index += 1;
    return { toolCall: { name: 'ReadMediaFile', arguments: JSON.stringify(args) } };
  };
}

function fakePersist(initial?: string): ConfigPersist {
  let text = initial;
  return {
    load: () => Promise.resolve(text),
    save: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

function recordingStore(): { store: MediaStore; puts: MediaContent[] } {
  const inner = createMemoryMediaStore();
  const puts: MediaContent[] = [];
  return {
    puts,
    store: {
      get: (ref) => inner.get(ref),
      put: async (content) => {
        puts.push(content);
        return inner.put(content);
      },
    },
  };
}

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface StartedApp {
  readonly app: Awaited<ReturnType<typeof createHarness>>;
  readonly main: AgentHandle;
  readonly calls: LlmCall[];
  readonly store: MediaStore;
  readonly puts: MediaContent[];
  readonly workDir: string;
  readonly stores: SessionStores;
  readonly dispose: () => Promise<void>;
}

async function startApp(opts: {
  readonly script: LlmScript;
  readonly model?: LlmModel;
  readonly toml?: string;
  readonly withConfig?: boolean;
  readonly originalsDir?: string;
}): Promise<StartedApp> {
  const workDir = await mkdtemp(join(tmpdir(), 'media-work-'));
  tmpDirs.push(workDir);
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const { requester, calls } = createMockRequester(opts.script);
  const { store, puts } = recordingStore();
  const bindLlm = createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model: opts.model ?? visionModel });
      agent.setRequester(requester);
    },
  });
  const features: FeatureSpec[] = [];
  if (opts.withConfig !== false) features.push(createConfig({ persist: fakePersist(opts.toml) }));
  features.push(
    createMedia({
      workDir,
      store,
      cache: createMemoryMediaUploadCache(),
      host: createNodeOsHost(),
      originalsDir: opts.originalsDir,
    }),
    bindLlm,
  );
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return {
    app,
    main,
    calls,
    store,
    puts,
    workDir,
    stores,
    dispose: async () => {
      await app.disposeAsync();
      await stores.dispose();
    },
  };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

async function runToolTurn(main: AgentHandle, calls: LlmCall[]): Promise<ToolMessage> {
  const done = nextTurnDone(main);
  main.submit(createUserMessage('read it'));
  await done;
  const toolMessage = calls.at(-1)?.messages.find((message) => message.role === 'tool');
  if (toolMessage === undefined) throw new Error('no tool message captured');
  return toolMessage;
}

function textsOf(message: ToolMessage): string[] {
  return message.content.filter((part) => part.type === 'text').map((part) => part.text);
}

function lastToolEntry(stores: SessionStores): HistoryMessage {
  const entry = (stores.get(MAIN_AGENT_ID)?.getState().history ?? []).findLast(
    (historyEntry) => historyEntry.message.role === 'tool',
  );
  if (entry === undefined) throw new Error('no tool entry recorded');
  return entry;
}

function noisePngBytes(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height });
  const data = image.bitmap.data;
  let seed = 42;
  for (let i = 0; i < data.length; i += 1) {
    if (i % 4 === 3) {
      data[i] = 255;
      continue;
    }
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed >>> 23;
  }
  return image.getBuffer('image/png');
}

function solidPngBytes(width: number, height: number): Promise<Buffer> {
  return new Jimp({ width, height, color: 0xff3366ff }).getBuffer('image/png');
}

describe('media feature', () => {
  it('registers ReadMediaFile and the image config section, and mounts without the config feature', async () => {
    const configured = await startApp({
      script: () => ({ text: 'ok' }),
      toml: '[image]\nmax_edge_px = 123\nread_byte_budget = 4096\n',
    });
    let done = nextTurnDone(configured.main);
    configured.main.submit(createUserMessage('hi'));
    await done;
    const names = configured.calls[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain('ReadMediaFile');
    const section = configured.app.resolve(ConfigRef).get<ImageConfig>(IMAGE_CONFIG_SECTION);
    expect(section.maxEdgePx).toBe(123);
    expect(section.readByteBudget).toBe(4096);
    await configured.dispose();

    const bare = await startApp({ script: () => ({ text: 'ok' }), withConfig: false });
    done = nextTurnDone(bare.main);
    bare.main.submit(createUserMessage('hi'));
    await done;
    expect(bare.calls[0]?.tools.map((tool) => tool.name)).toContain('ReadMediaFile');
    await bare.dispose();
  }, 30_000);

  it('reads an image, downsamples it into the store, and wraps it with image tags and a system note', async () => {
    const started = await startApp({ script: readMediaScript({ path: 'noise.png' }) });
    const png = await noisePngBytes(1200, 900);
    await writeFile(join(started.workDir, 'noise.png'), png);
    const toolMessage = await runToolTurn(started.main, started.calls);
    const [open, mediaPart, close, note] = toolMessage.content;
    expect(open).toEqual({ type: 'text', text: `<image path="${join(started.workDir, 'noise.png')}">` });
    expect(close).toEqual({ type: 'text', text: '</image>' });
    if (mediaPart?.type !== 'image_url') throw new Error('expected an image_url part');
    expect(mediaPart.imageUrl.url.startsWith('media://')).toBe(true);
    const ref = mediaPart.imageUrl.url.slice('media://'.length);
    const stored = await started.store.get(ref);
    expect(stored?.mimeType).toBe('image/jpeg');
    expect(stored?.bytes.length ?? 0).toBeGreaterThan(0);
    expect(stored?.bytes.length ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(256 * 1024);
    if (note?.type !== 'text') throw new Error('expected a text note');
    expect(note.text).toContain('<system>');
    expect(note.text).toContain('Read image file.');
    expect(note.text).toContain('Mime type: image/png.');
    expect(note.text).toContain(`Size: ${String(png.length)} bytes.`);
    expect(note.text).toContain('Original dimensions: 1200x900 pixels.');
    expect(note.text).toContain('downsampled');
    expect(note.text).toContain('read the result back immediately before continuing.');
    await started.dispose();
  }, 60_000);

  it('crops a region of an image at full fidelity', async () => {
    const started = await startApp({
      script: readMediaScript({ path: 'noise.png', region: { x: 100, y: 50, width: 200, height: 120 } }),
    });
    await writeFile(join(started.workDir, 'noise.png'), await noisePngBytes(1200, 900));
    const toolMessage = await runToolTurn(started.main, started.calls);
    const mediaPart = toolMessage.content.find((part) => part.type === 'image_url');
    if (mediaPart?.type !== 'image_url') throw new Error('expected an image_url part');
    const stored = await started.store.get(mediaPart.imageUrl.url.slice('media://'.length));
    expect(stored?.mimeType).toBe('image/png');
    expect(stored?.bytes.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const texts = textsOf(toolMessage);
    expect(
      texts.some((text) =>
        text.includes(
          'Showing region (x=100, y=50, width=200, height=120) of the original image at native resolution.',
        ),
      ),
    ).toBe(true);
    expect(texts.some((text) => text.includes('the region offset (x=100, y=50).'))).toBe(true);
    await started.dispose();
  }, 60_000);

  it('delivers full_resolution images untouched when they fit the inline budget', async () => {
    const started = await startApp({
      script: readMediaScript({ path: 'small.png', full_resolution: true }),
    });
    const png = await solidPngBytes(64, 48);
    await writeFile(join(started.workDir, 'small.png'), png);
    const toolMessage = await runToolTurn(started.main, started.calls);
    const mediaPart = toolMessage.content.find((part) => part.type === 'image_url');
    if (mediaPart?.type !== 'image_url') throw new Error('expected an image_url part');
    const stored = await started.store.get(mediaPart.imageUrl.url.slice('media://'.length));
    expect(stored?.mimeType).toBe('image/png');
    expect(Buffer.from(stored?.bytes ?? []).equals(png)).toBe(true);
    expect(
      textsOf(toolMessage).some((text) =>
        text.includes('Shown at native resolution; no downscaling applied.'),
      ),
    ).toBe(true);
    await started.dispose();
  }, 30_000);

  it('rejects image reads when the model lacks image input capability', async () => {
    const started = await startApp({
      script: readMediaScript({ path: 'small.png' }),
      model: plainModel,
    });
    await writeFile(join(started.workDir, 'small.png'), await solidPngBytes(64, 48));
    await runToolTurn(started.main, started.calls);
    const entry = lastToolEntry(started.stores);
    expect((entry.meta as ToolMeta | undefined)?.isError).toBe(true);
    expect(entry.message.content).toEqual([
      {
        type: 'text',
        text:
          'The current model does not support image input. ' +
          'Tell the user to use a model with image input capability.',
      },
    ]);
    await started.dispose();
  }, 30_000);

  it('reports text files and unsupported binaries with guidance', async () => {
    const started = await startApp({
      script: readMediaScript({ path: 'notes.txt' }, { path: 'data.bin' }),
    });
    await writeFile(join(started.workDir, 'notes.txt'), 'hello world');
    await writeFile(join(started.workDir, 'data.bin'), new Uint8Array([1, 2, 3, 4, 5]));
    await runToolTurn(started.main, started.calls);
    const textEntry = lastToolEntry(started.stores);
    expect((textEntry.meta as ToolMeta | undefined)?.isError).toBe(true);
    expect(textEntry.message.content).toEqual([
      {
        type: 'text',
        text: '"notes.txt" is a text file. Use Read to read text files.',
      },
    ]);
    const done = nextTurnDone(started.main);
    started.main.submit(createUserMessage('read the bin'));
    await done;
    const binEntry = lastToolEntry(started.stores);
    expect((binEntry.meta as ToolMeta | undefined)?.isError).toBe(true);
    expect(binEntry.message.content).toEqual([
      {
        type: 'text',
        text:
          '"data.bin" is not a supported image or video file. ' +
          'Use Read for text files, or Bash or an MCP tool for other binary formats.',
      },
    ]);
    await started.dispose();
  }, 30_000);

  it('rewrites large inline prompt images to media refs and keeps small ones inline', async () => {
    const started = await startApp({ script: () => ({ text: 'ok' }) });
    const noise = await noisePngBytes(1200, 900);
    const small = await solidPngBytes(64, 48);
    const bigDataUrl = `data:image/png;base64,${noise.toString('base64')}`;
    const smallDataUrl = `data:image/png;base64,${small.toString('base64')}`;
    const done = nextTurnDone(started.main);
    started.main.submit({
      role: 'user',
      content: [
        { type: 'text', text: 'look at these' },
        { type: 'image_url', imageUrl: { url: bigDataUrl } },
        { type: 'image_url', imageUrl: { url: smallDataUrl } },
      ],
    });
    await done;
    const userMessage = started.calls[0]?.wire.findLast((message) => message.role === 'user');
    if (userMessage === undefined) throw new Error('no user message captured');
    const parts: ContentPart[] = userMessage.content;
    expect(parts[0]).toEqual({ type: 'text', text: 'look at these' });
    const texts = parts.filter((part) => part.type === 'text').map((part) => part.text);
    expect(texts.some((text) => text.includes('Image compressed to fit model limits:'))).toBe(true);
    expect(texts.some((text) => text.includes('The uncompressed original was not preserved.'))).toBe(true);
    const images = parts.filter((part) => part.type === 'image_url');
    expect(images).toHaveLength(2);
    const lowered = images.find(
      (part) => part.type === 'image_url' && part.imageUrl.url.startsWith('data:image/jpeg;base64,'),
    );
    expect(lowered).toBeDefined();
    expect(
      images.some(
        (part) => part.type === 'image_url' && part.imageUrl.url === smallDataUrl,
      ),
    ).toBe(true);
    expect(images.every((part) => part.type === 'image_url' && part.imageUrl.url !== bigDataUrl)).toBe(true);
    expect(started.puts.some((put) => put.mimeType === 'image/jpeg')).toBe(true);
    await started.dispose();
  }, 60_000);

  it('drops the oldest inline images when a request exceeds the media budget', async () => {
    const started = await startApp({ script: () => ({ text: 'ok' }) });
    const filler = (marker: string) =>
      `data:image/png;base64,${marker}${'A'.repeat(8 * 1024 * 1024)}`;
    const urls = [filler('a'), filler('b'), filler('c')];
    const done = nextTurnDone(started.main);
    started.main.submit({
      role: 'user',
      content: urls.map((url) => ({ type: 'image_url' as const, imageUrl: { url } })),
    });
    await done;
    const userMessage = started.calls.at(-1)?.wire.findLast((message) => message.role === 'user');
    if (userMessage === undefined) throw new Error('no user message captured');
    const placeholder = '[image omitted: dropped to fit the request media budget]';
    expect(userMessage.content[0]).toEqual({ type: 'text', text: placeholder });
    expect(userMessage.content[1]).toEqual({ type: 'text', text: placeholder });
    expect(userMessage.content[2]).toEqual({ type: 'image_url', imageUrl: { url: urls[2] } });
    await started.dispose();
  }, 60_000);

  it('materializes media refs to inline base64 by the time the requester sees them', async () => {
    const started = await startApp({ script: () => ({ text: 'ok' }) });
    const png = await solidPngBytes(64, 48);
    const ref = await started.store.put({ bytes: new Uint8Array(png), mimeType: 'image/png', filename: 'small.png' });
    const done = nextTurnDone(started.main);
    started.main.submit({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: `media://${ref}` } }],
    });
    await done;
    const userMessage = started.calls.at(-1)?.wire.findLast((message) => message.role === 'user');
    if (userMessage === undefined) throw new Error('no user message captured');
    expect(userMessage.content).toEqual([
      {
        type: 'image_url',
        imageUrl: { url: `data:image/png;base64,${png.toString('base64')}` },
      },
    ]);
    await started.dispose();
  }, 30_000);
});
