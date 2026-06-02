import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  BlobStore,
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../src/agent/records';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeWirePath(): Promise<string> {
  const dir = join(tmpdir(), `wire-jsonl-test-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return join(dir, 'wire.jsonl');
}

async function readLines(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('FileSystemAgentRecordPersistence', () => {
  it('writes only the appended record', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('turn.prompt');
  });

  it('appends to an existing file without injecting records', async () => {
    const wirePath = await makeWirePath();

    const first = new FileSystemAgentRecordPersistence(wirePath);
    first.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    await first.close();

    const second = new FileSystemAgentRecordPersistence(wirePath);
    second.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'two' }],
      origin: { kind: 'user' },
    });
    await second.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'turn.prompt',
      'turn.prompt',
    ]);
  });

  it('returns appended metadata records from read() output', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    persistence.append({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    });
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hi' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const reader = new FileSystemAgentRecordPersistence(wirePath);
    const records: AgentRecord[] = [];
    for await (const r of reader.read()) records.push(r);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(records[1]!.type).toBe('turn.prompt');
  });

  it('rewrites records from the beginning and then appends after them', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old' }],
      origin: { kind: 'user' },
    });
    persistence.rewrite([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'new' }],
        origin: { kind: 'user' },
      },
    ]);
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'later' }],
      origin: { kind: 'user' },
    });
    await persistence.flush();

    const lines = await readLines(wirePath);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'metadata',
      'turn.prompt',
      'turn.prompt',
    ]);
    expect(JSON.parse(lines[1]!)['input'][0]['text']).toBe('new');
    expect(JSON.parse(lines[2]!)['input'][0]['text']).toBe('later');
  });

  it('rewrites already flushed records from the beginning', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old' }],
      origin: { kind: 'user' },
    });
    await persistence.flush();

    persistence.rewrite([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'new' }],
        origin: { kind: 'user' },
      },
    ]);
    await persistence.flush();

    const lines = await readLines(wirePath);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'metadata',
      'turn.prompt',
    ]);
    expect(JSON.parse(lines[1]!)['input'][0]['text']).toBe('new');
  });

  it('flushes pending records on close', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'late' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('turn.prompt');
  });

  it('enters error state after a write failure', async () => {
    const wirePath = await makeWirePath();
    await mkdir(wirePath);
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'first' }],
      origin: { kind: 'user' },
    });
    await expect(persistence.flush()).rejects.toBeInstanceOf(Error);

    expect(() => {
      persistence.append({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'second' }],
        origin: { kind: 'user' },
      });
    }).toThrow();
    expect(() => {
      persistence.rewrite([
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'rewrite' }],
          origin: { kind: 'user' },
        },
      ]);
    }).toThrow();
    await expect(persistence.flush()).rejects.toBeInstanceOf(Error);
  });

  it('offloads large data URIs to blobsDir during append', async () => {
    const dir = join(tmpdir(), `wire-blob-test-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    cleanups.push(dir);

    const wirePath = join(dir, 'wire.jsonl');
    const blobsDir = join(dir, 'blobs');
    const persistence = new FileSystemAgentRecordPersistence(wirePath, {
      blobStore: new BlobStore({ blobsDir }),
    });

    const payload = 'X'.repeat(5000);
    const dataUri = `data:image/png;base64,${payload}`;

    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'image_url', imageUrl: { url: dataUri } }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as unknown as Record<string, unknown>;
    const url = ((record['input'] as unknown[])[0] as { imageUrl: { url: string } }).imageUrl.url;
    expect(url.startsWith('blobref:')).toBe(true);

    const blobFiles = await readdir(blobsDir);
    expect(blobFiles).toHaveLength(1);
    expect((await readFile(join(blobsDir, blobFiles[0]!))).toString('base64')).toBe(payload);
  });
});

describe('InMemoryAgentRecordPersistence', () => {
  it('stores appended records and replaces them on rewrite', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    persistence.rewrite([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
    ]);

    const records: AgentRecord[] = [];
    for await (const record of persistence.read()) records.push(record);

    expect(records).toEqual([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
    ]);
    expect(persistence.records).toEqual(records);
  });
});
