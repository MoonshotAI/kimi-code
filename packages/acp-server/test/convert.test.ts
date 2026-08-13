import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@agentclientprotocol/sdk';
import type { ContentPart } from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acpBlocksToContentParts,
  acpMcpServersToConfigRecord,
  compressPromptImageParts,
} from '../src/convert';
import { solidPng, solidPngBase64 } from './_helpers/png';

describe('acpMcpServersToConfigRecord', () => {
  it('returns undefined for an absent or empty list', () => {
    expect(acpMcpServersToConfigRecord(undefined)).toBeUndefined();
    expect(acpMcpServersToConfigRecord([])).toBeUndefined();
  });

  it('maps stdio servers (no `type` discriminator) with env pairs as a record', () => {
    const servers: McpServer[] = [
      {
        name: 'fs',
        command: '/usr/local/bin/mcp-fs',
        args: ['--root', '/tmp'],
        env: [
          { name: 'API_KEY', value: 'secret' },
          { name: 'DEBUG', value: '1' },
        ],
      },
    ];
    expect(acpMcpServersToConfigRecord(servers)).toEqual({
      fs: {
        transport: 'stdio',
        command: '/usr/local/bin/mcp-fs',
        args: ['--root', '/tmp'],
        env: { API_KEY: 'secret', DEBUG: '1' },
      },
    });
  });

  it('maps http and sse servers with header pairs as a record', () => {
    const servers: McpServer[] = [
      {
        type: 'http',
        name: 'web',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer x' }],
      },
      { type: 'sse', name: 'events', url: 'https://example.com/sse', headers: [] },
    ];
    expect(acpMcpServersToConfigRecord(servers)).toEqual({
      web: {
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
      events: { transport: 'sse', url: 'https://example.com/sse', headers: undefined },
    });
  });

  it('drops the unstable acp transport and returns undefined when nothing survives', () => {
    const servers = [{ type: 'acp', name: 'nested', serverId: 'srv-1' } as unknown as McpServer];
    expect(acpMcpServersToConfigRecord(servers)).toBeUndefined();
  });
});

describe('acpBlocksToContentParts', () => {
  it('projects file links and embedded text resources with provenance', () => {
    const parts = acpBlocksToContentParts([
      { type: 'resource_link', uri: 'file:///tmp/example.ts#L2-L4', name: 'example.ts' },
      { type: 'resource_link', uri: 'https://example.test/doc', name: 'remote doc' },
      {
        type: 'resource',
        resource: { uri: 'memory://note/1', text: 'remember this' },
      },
    ] as never);

    expect(parts).toEqual([
      { type: 'text', text: '/tmp/example.ts:2-4' },
      {
        type: 'text',
        text: '<resource_link uri="https://example.test/doc" name="remote doc" />',
      },
      { type: 'text', text: '<resource uri="memory://note/1">remember this</resource>' },
    ]);
  });
});

describe('compressPromptImageParts', () => {
  const trash: string[] = [];

  afterEach(async () => {
    await Promise.all(trash.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  async function tempOriginalsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'acp-originals-'));
    trash.push(dir);
    return dir;
  }

  function imagePart(url: string): ContentPart {
    return { type: 'image_url', imageUrl: { url } };
  }

  it('drops an unsupported image format and stands a text notice in', async () => {
    // Zero bytes carry no magic number, so the declared MIME wins the
    // effective-MIME resolution and the gate rejects it.
    const heic = `data:image/heic;base64,${Buffer.alloc(32).toString('base64')}`;
    const out = await compressPromptImageParts([{ type: 'text', text: 'look' }, imagePart(heic)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: 'text', text: 'look' });
    const notice = out[1];
    expect(notice?.type).toBe('text');
    expect((notice as { text: string }).text).toContain('unsupported image format image/heic');
  });

  it('rewrites accepted MIME aliases to the canonical form', async () => {
    const base64 = solidPngBase64(8, 8);
    const out = await compressPromptImageParts([imagePart(`data:IMAGE/PNG;base64,${base64}`)]);
    expect(out).toHaveLength(1);
    const part = out[0];
    expect(part?.type).toBe('image_url');
    expect((part as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/png;base64,${base64}`,
    );
  });

  it('passes an under-limit image through unchanged and persists nothing', async () => {
    const originalsDir = await tempOriginalsDir();
    const url = `data:image/png;base64,${solidPngBase64(32, 32)}`;
    const out = await compressPromptImageParts([imagePart(url)], {
      originalsDir,
      maxImageEdgePx: 64,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(imagePart(url));
    // No compression happened, so no original was persisted.
    expect(await readdir(originalsDir)).toEqual([]);
  });

  it('compresses an over-edge image, prefixes a caption, and persists the original', async () => {
    const originalsDir = await tempOriginalsDir();
    const original = solidPng(128, 128);
    const url = `data:image/png;base64,${original.toString('base64')}`;
    const out = await compressPromptImageParts([imagePart(url)], {
      originalsDir,
      maxImageEdgePx: 64,
    });

    // caption text part immediately precedes the re-encoded image part.
    expect(out).toHaveLength(2);
    const caption = out[0] as { text: string };
    const image = out[1] as { imageUrl: { url: string } };
    expect(caption.text).toContain('Image compressed to fit model limits');
    expect(caption.text).toContain('128x128');
    expect(caption.text).toContain(originalsDir);
    expect(image.imageUrl.url).not.toBe(url);
    expect(image.imageUrl.url.startsWith('data:image/')).toBe(true);

    // The original bytes landed in the session media-originals dir so the
    // model can read fine detail back from the captioned path.
    const files = await readdir(originalsDir);
    expect(files).toHaveLength(1);
    expect(caption.text).toContain(files[0]!);
    expect(await readFile(join(originalsDir, files[0]!))).toEqual(original);
  });
});
