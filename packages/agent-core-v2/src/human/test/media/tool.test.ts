import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActor, waitFor } from '#/xstate2';

import { createAgentMachine } from '#/agent/machine';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import { createTurnMachine } from '#/agent/turn';
import { createEventStore } from '#/eventStore/eventStore';
import { journalFromBranch } from '#/eventStore/journal';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { ModelCapability } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type VideoURLPart,
} from '#/llm/message';
import { createMemoryMediaUploadCache } from '#/llm/media/cache';
import { createMediaRefResolver } from '#/llm/media/resolver';
import { createMemoryMediaStore } from '#/llm/media/store';
import type { LlmModel } from '#/llm/model';
import { createProvider } from '#/llm/provider/definition';
import type { LlmRequester } from '#/llm/requester/requester';
import { openAIBase, planOpenAIRequest } from '#/llm/requester/bases/openai/requester';
import { createReadMediaFileTool } from '#/media/tool';

const CAPABILITY: ModelCapability = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: false,
  tool_use: true,
};

const tmpDirs: string[] = [];

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-tool-'));
  tmpDirs.push(dir);
  return dir;
}

function toolCall(id: string, name: string, args: string): ToolCall {
  return { type: 'function', id, name, arguments: args };
}

async function testStore(): Promise<AgentEventStore> {
  const backend = new MemoryBackend();
  const store = await TreeStore.open(backend, {});
  const tree = await store.tree('test');
  tree.createBranch('main');
  return createEventStore({ journal: journalFromBranch(tree.openBranch('main'), tree), slices: agentSlices });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ReadMediaFile tool', () => {
  it('stores the file bytes and returns a media ref part', async () => {
    const workspaceDir = tmpWorkspace();
    fs.writeFileSync(path.join(workspaceDir, 'pic.png'), new Uint8Array([1, 2, 3]));
    const store = createMemoryMediaStore();
    const tool = createReadMediaFileTool({ store, workspaceDir, capability: CAPABILITY });

    const result = await tool.execute({
      toolCall: toolCall('call-1', 'ReadMediaFile', '{"path":"pic.png"}'),
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    const mediaPart = result.content[1];
    if (mediaPart?.type !== 'image_url') throw new Error('expected an image part');
    expect(mediaPart.imageUrl.url.startsWith('media://')).toBe(true);
    const ref = mediaPart.imageUrl.url.slice('media://'.length);
    const stored = await store.get(ref);
    expect(stored?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(stored?.mimeType).toBe('image/png');
    expect(result.content[0]).toEqual({
      type: 'text',
      text: `<image path="${path.join(workspaceDir, 'pic.png')}">`,
    });
  });

  it('returns an error for a missing file', async () => {
    const workspaceDir = tmpWorkspace();
    const tool = createReadMediaFileTool({
      store: createMemoryMediaStore(),
      workspaceDir,
      capability: CAPABILITY,
    });

    const result = await tool.execute({
      toolCall: toolCall('call-1', 'ReadMediaFile', '{"path":"no-such.png"}'),
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Failed to read') }]);
  });

  it('rejects a video when the model lacks video input capability', async () => {
    const workspaceDir = tmpWorkspace();
    fs.writeFileSync(path.join(workspaceDir, 'movie.mp4'), new Uint8Array([1, 2, 3]));
    const tool = createReadMediaFileTool({
      store: createMemoryMediaStore(),
      workspaceDir,
      capability: { ...CAPABILITY, video_in: false },
    });

    const result = await tool.execute({
      toolCall: toolCall('call-1', 'ReadMediaFile', '{"path":"movie.mp4"}'),
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('does not support video input') },
    ]);
  });
});

describe('media stack wiring', () => {
  it('resolves the tool message media ref into an uploaded part before generate', async () => {
    const workspaceDir = tmpWorkspace();
    fs.writeFileSync(path.join(workspaceDir, 'movie.mp4'), new Uint8Array([1, 2, 3]));
    const model: LlmModel = { provider: 'test-media', model: 'test-model', capability: CAPABILITY };
    const uploadedPart: VideoURLPart = {
      type: 'video_url',
      videoUrl: { url: 'ms://file-1', id: 'file-1' },
    };
    const uploadVideo = vi.fn(async () => uploadedPart);
    const provider = createProvider({
      id: 'test-media',
      protocols: { openai: { base: openAIBase } },
      media: { uploadVideo },
    });
    const store = createMemoryMediaStore();
    const capability = CAPABILITY;
    const tools =
      capability.image_in || capability.video_in
        ? [createReadMediaFileTool({ store, workspaceDir, capability })]
        : [];
    expect(tools).toHaveLength(1);

    const seenMessages: (readonly Message[])[] = [];
    const responses: readonly AssistantMessage[] = [
      createAssistantMessage(
        [],
        [toolCall('call-1', 'ReadMediaFile', '{"path":"movie.mp4"}')],
      ),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ];
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        seenMessages.push(messages);
        const message = responses[Math.min(call, responses.length - 1)] as AssistantMessage;
        call += 1;
        for (const part of [...message.content, ...message.toolCalls]) {
          onEvent?.({ type: 'llm.streaming.part', part });
        }
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };

    const agentStore = await testStore();
    const actor = createActor(
      createAgentMachine({
        tools,
        turnActor: createTurnMachine(requester, {
          messageResolvers: [
            createMediaRefResolver({
              providers: [provider],
              source: store,
              cache: createMemoryMediaUploadCache(),
            }),
          ],
        }),
      }),
      { input: { request: { model }, store: agentStore } },
    );
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('watch this') });
    await waitFor(actor, (s) => s.matches('idle') && agentStore.getState().history.length > 1, {
      timeout: 5000,
    });

    expect(seenMessages).toHaveLength(2);
    const toolMessage = seenMessages[1]?.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toEqual([
      { type: 'text', text: `<video path="${path.join(workspaceDir, 'movie.mp4')}">` },
      uploadedPart,
      { type: 'text', text: '</video>' },
    ]);
    expect(uploadVideo).toHaveBeenCalledTimes(1);

    const wire = planOpenAIRequest({
      model,
      messages: seenMessages[1] as readonly Message[],
      tools: [],
    });
    const wireMessages = wire.params.messages as unknown as Record<string, unknown>[];
    const toolWire = wireMessages.find((message) => message['role'] === 'tool');
    expect(String(toolWire?.['content'])).not.toContain('video omitted');
    const mediaUser = wireMessages.find(
      (message) => message['role'] === 'user' && Array.isArray(message['content']),
    );
    expect(mediaUser?.['content']).toContainEqual({
      type: 'video_url',
      video_url: { url: 'ms://file-1', id: 'file-1' },
    });
  });
});
