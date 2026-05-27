import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isBlobRef,
  offloadRecordBlobs,
  rehydrateRecordBlobs,
  rehydrateMessagesBlobs,
} from '../../../src/agent/records/blobref';
import type { AgentRecord } from '../../../src/agent/records';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeBlobsDir(): Promise<string> {
  const dir = join(tmpdir(), `blobref-test-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

describe('blobref', () => {
  it('offloads large data URIs and replaces with blobref', async () => {
    const blobsDir = await makeBlobsDir();
    const payload = 'A'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    await offloadRecordBlobs(record, { blobsDir, threshold: 4096 });

    const url = (record.input as unknown as [{ imageUrl: { url: string } }])[0].imageUrl.url;
    expect(isBlobRef(url)).toBe(true);
    expect(url.startsWith('blobref:')).toBe(true);
    expect(url.startsWith('blobref:image/png;')).toBe(true);

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
    expect(await readFile(join(blobsDir, files[0]!), 'utf8')).toBe(payload);
  });

  it('skips small data URIs below threshold', async () => {
    const blobsDir = await makeBlobsDir();
    const payload = 'short';
    const dataUri = `data:image/png;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    await offloadRecordBlobs(record, { blobsDir, threshold: 4096 });

    const url = (record.input as unknown as [{ imageUrl: { url: string } }])[0].imageUrl.url;
    expect(url).toBe(dataUri);
    const files = await readdir(blobsDir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it('skips existing blobrefs during offload', async () => {
    const blobsDir = await makeBlobsDir();
    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: 'blobref:image/png;abc' } }],
      origin: { kind: 'user' },
    };

    await offloadRecordBlobs(record, { blobsDir, threshold: 4096 });

    const url = (record.input as unknown as [{ imageUrl: { url: string } }])[0].imageUrl.url;
    expect(url).toBe('blobref:image/png;abc');
  });

  it('rehydrates blobrefs back to data URIs', async () => {
    const blobsDir = await makeBlobsDir();
    const payload = 'B'.repeat(5000);
    const dataUri = `data:image/jpeg;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    await offloadRecordBlobs(record, { blobsDir, threshold: 4096 });
    await rehydrateRecordBlobs(record, blobsDir);

    const url = (record.input as unknown as [{ imageUrl: { url: string } }])[0].imageUrl.url;
    expect(url).toBe(dataUri);
  });

  it('replaces missing blobs with placeholder text', async () => {
    const blobsDir = await makeBlobsDir();
    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: 'blobref:image/png;deadbeef' } }],
      origin: { kind: 'user' },
    };

    await rehydrateRecordBlobs(record, blobsDir);

    const url = (record.input as unknown as [{ imageUrl: { url: string } }])[0].imageUrl.url;
    expect(url).toBe('[media missing]');
  });

  it('deduplicates identical payloads by hash', async () => {
    const blobsDir = await makeBlobsDir();
    const payload = 'C'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    const record1: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };
    const record2: AgentRecord = {
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    };

    await offloadRecordBlobs(record1, { blobsDir, threshold: 4096 });
    await offloadRecordBlobs(record2, { blobsDir, threshold: 4096 });

    const files = await readdir(blobsDir);
    expect(files).toHaveLength(1);
  });

  it('rehydrates messages with media parts only', async () => {
    const blobsDir = await makeBlobsDir();
    const payload = 'D'.repeat(5000);
    const dataUri = `data:audio/wav;base64,${payload}`;

    const record: AgentRecord = {
      type: 'turn.prompt',
      input: [
        { type: 'text', text: 'hello' },
        { type: 'audio_url', audioUrl: { url: dataUri } },
      ],
      origin: { kind: 'user' },
    };

    await offloadRecordBlobs(record, { blobsDir, threshold: 4096 });

    const messages = [
      {
        role: 'user' as const,
        content: [...record.input],
        toolCalls: [],
      },
    ];

    const hydrated = await rehydrateMessagesBlobs(messages, blobsDir);
    const firstMsg = hydrated[0]!;
    expect(firstMsg.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect((firstMsg.content[1]! as { audioUrl: { url: string } }).audioUrl.url).toBe(dataUri);
  });

  it('degrades missing blob in messages to text placeholder', async () => {
    const blobsDir = await makeBlobsDir();
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'image_url' as const, imageUrl: { url: 'blobref:image/png;missing' } }],
        toolCalls: [],
      },
    ];

    const hydrated = await rehydrateMessagesBlobs(messages, blobsDir);
    const firstMsg = hydrated[0]!;
    expect(firstMsg.content[0]).toEqual({ type: 'text', text: '[media missing]' });
  });
});
