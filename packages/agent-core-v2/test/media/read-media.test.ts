/**
 * ReadMediaFileTool tests for the v2 output/capability contract.
 *
 * Self-contained: builds minimal fake `ISessionAgentFileSystem` and `IKaos` inline
 * so the tool can be exercised without the missing composition root.
 */

import type { ContentPart, ModelCapability } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { ISessionAgentFileSystem } from '#/session/agentFs';
import type { IHostEnvironment } from '#/app/hostEnvironment';
import {
  ReadMediaFileInputSchema,
  ReadMediaFileTool,
  type VideoUploader,
} from '#/agent/media/tools/read-media';
import { registerMediaTools } from '#/agent/media/registerMediaTools';
import { AgentToolRegistryService } from '#/agent/toolRegistry';
import { ToolAccesses } from '#/agent/tool';
import type { WorkspaceConfig } from '../../src/_base/tools/support/workspace';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/agent/tool';

const WORKSPACE: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };

const PNG_WIDTH = 1920;
const PNG_HEIGHT = 1080;

function pngBuffer(): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) + 'IHDR'
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(PNG_WIDTH, 16);
  buf.writeUInt32BE(PNG_HEIGHT, 20);
  return buf;
}

function mp4Buffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from('mp42'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mp42isom'),
  ]);
}

function capabilities(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 0,
    ...overrides,
  };
}

interface FakeFile {
  readonly data: Buffer;
  readonly size?: number;
}

function createTestFs(files: Record<string, FakeFile>): ISessionAgentFileSystem {
  const lookup = (path: string): FakeFile | undefined => files[path];
  return {
    cwd: '/workspace',
    readBytes: vi.fn(async (path: string, _n?: number) => lookup(path)?.data ?? Buffer.alloc(0)),
    stat: vi.fn(async (path: string) => {
      const file = lookup(path);
      return {
        isFile: true,
        isDirectory: false,
        size: file?.size ?? file?.data.length ?? 0,
      };
    }),
  } as unknown as ISessionAgentFileSystem;
}

function createTestEnv(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  };
}

function makeTool(
  files: Record<string, FakeFile>,
  caps: ModelCapability = capabilities(),
  videoUploader?: VideoUploader,
): ReadMediaFileTool {
  return new ReadMediaFileTool(createTestFs(files), createTestEnv(), WORKSPACE, caps, videoUploader);
}

async function execute(
  tool: ReadMediaFileTool,
  args: { path: string },
): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(args);
  // `resolveExecution` may return a validation error result directly (e.g. an
  // empty path) instead of a runnable execution.
  if (!('execute' in execution)) {
    return execution;
  }
  const ctx: ExecutableToolContext = {
    turnId: 't1',
    toolCallId: 'call_media',
    signal: new AbortController().signal,
  };
  return execution.execute(ctx);
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
}

describe('ReadMediaFileTool', () => {
  it('has name, parameters, and a path-scoped read access', () => {
    const tool = makeTool({ '/workspace/sample.png': { data: pngBuffer() } });

    expect(tool.name).toBe('ReadMediaFile');
    expect(ReadMediaFileInputSchema.safeParse({ path: '/workspace/sample.png' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
    });

    const execution = tool.resolveExecution({ path: '/workspace/sample.png' }) as Extract<
      ToolExecution,
      { execute: unknown }
    >;
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/sample.png'));
    expect(execution.approvalRule).toBe('ReadMediaFile(/workspace/sample.png)');
  });

  it('reflects model capabilities in its description', () => {
    expect(makeTool({}, capabilities({ image_in: true, video_in: true })).description).toContain(
      'image and video files',
    );
    expect(makeTool({}, capabilities({ image_in: true, video_in: false })).description).toContain(
      'Video files are not supported',
    );
    expect(makeTool({}, capabilities({ image_in: false, video_in: true })).description).toContain(
      'Image files are not supported',
    );
    expect(makeTool({}, capabilities({ image_in: false, video_in: false })).description).toContain(
      'does not support image or video input',
    );
  });

  it('rejects empty paths', async () => {
    const result = await execute(makeTool({}), { path: '' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('File path cannot be empty');
  });

  it('redirects text files to the Read tool', async () => {
    const result = await execute(
      makeTool({ '/workspace/note.txt': { data: Buffer.from('hello world') } }),
      { path: '/workspace/note.txt' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Use Read');
  });

  it('rejects unsupported binary formats', async () => {
    const result = await execute(
      makeTool({ '/workspace/archive.zip': { data: Buffer.from([0x50, 0x4b, 0x03, 0x04]) } }),
      { path: '/workspace/archive.zip' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not a supported image or video file');
  });

  it('wraps an image as a data URL with a system summary and dimensions', async () => {
    const result = await execute(makeTool({ '/workspace/sample.png': { data: pngBuffer() } }), {
      path: '/workspace/sample.png',
    });
    const parts = outputParts(result);

    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatchObject({ type: 'text' });
    const systemText = (parts[0] as { type: 'text'; text: string }).text;
    expect(systemText).toContain('Mime type: image/png');
    expect(systemText).toContain(`Original dimensions: ${PNG_WIDTH}x${PNG_HEIGHT}`);
    expect(parts[1]).toEqual({ type: 'text', text: '<image path="/workspace/sample.png">' });
    expect(parts[2]).toMatchObject({
      type: 'image_url',
      imageUrl: { url: expect.stringContaining('data:image/png;base64,') },
    });
    expect(parts[3]).toEqual({ type: 'text', text: '</image>' });
  });

  it('errors when reading an image without image input capability', async () => {
    const result = await execute(
      makeTool(
        { '/workspace/sample.png': { data: pngBuffer() } },
        capabilities({ image_in: false, video_in: true }),
      ),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not support image input');
  });

  it('wraps a video as a data URL when no uploader is provided', async () => {
    const result = await execute(makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }), {
      path: '/workspace/clip.mp4',
    });
    const parts = outputParts(result);
    expect(parts[1]).toEqual({ type: 'text', text: '<video path="/workspace/clip.mp4">' });
    expect(parts[2]).toMatchObject({
      type: 'video_url',
      videoUrl: { url: expect.stringContaining('data:video/mp4;base64,') },
    });
  });

  it('uses the video uploader when provided', async () => {
    const uploadResult = {
      type: 'video_url' as const,
      videoUrl: { url: 'https://example.com/uploaded.mp4' },
    };
    const videoUploader = vi.fn<VideoUploader>().mockResolvedValue(uploadResult);
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/clip.mp4' },
    );
    const parts = outputParts(result);
    expect(videoUploader).toHaveBeenCalledOnce();
    expect(videoUploader).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', filename: 'clip.mp4' }),
    );
    expect(parts[2]).toEqual(uploadResult);
  });

  it('rejects empty files', async () => {
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer(), size: 0 } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('is empty');
  });

  it('rejects files larger than the media limit', async () => {
    const oversized = 101 * 1024 * 1024;
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer(), size: oversized } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('exceeds the maximum');
  });
});

describe('registerMediaTools', () => {
  const fs = createTestFs({});
  const env = createTestEnv();

  it('registers ReadMediaFile when the model supports image input', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      fs,
      env,
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: true, video_in: false }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
    disposable.dispose();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('registers ReadMediaFile when the model supports video input', () => {
    const registry = new AgentToolRegistryService();
    registerMediaTools(registry, {
      fs,
      env,
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: true }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it('does not register anything when the model lacks media capability', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      fs,
      env,
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: false }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
    // Disposing the no-op registration is safe.
    expect(() => disposable.dispose()).not.toThrow();
  });
});
