import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLegacySession } from '../../src/sessions/classify.js';
import { listBucketSessions, type LegacySessionRef } from '../../src/sessions/source.js';

let bucket: string;
beforeEach(async () => {
  bucket = await mkdtemp(join(tmpdir(), 'classify-'));
});
afterEach(async () => {
  await rm(bucket, { recursive: true, force: true });
});

async function makeSession(name: string, files: Record<string, string>): Promise<void> {
  const path = join(bucket, name);
  await mkdir(path, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await writeFile(join(path, k), v, 'utf-8');
  }
}

async function classify(name: string): Promise<string> {
  const refs = await listBucketSessions(bucket);
  const ref = refs.find((r) => r.uuid === name);
  expect(ref).toBeDefined();
  return classifyLegacySession(ref as LegacySessionRef);
}

describe('classifyLegacySession', () => {
  it('placeholder: dir contains only a `test` file', async () => {
    await makeSession('uuid1', { test: 'test' });
    expect(await classify('uuid1')).toBe('placeholder');
  });

  it('empty: dir has zero files', async () => {
    await mkdir(join(bucket, 'uuid2'), { recursive: true });
    expect(await classify('uuid2')).toBe('empty');
  });

  it('malformed: dir missing both context.jsonl and state.json', async () => {
    await makeSession('uuid3', { 'wire.jsonl': '{}\n' });
    expect(await classify('uuid3')).toBe('malformed');
  });

  it('real: context.jsonl carries a user/assistant/tool message', async () => {
    await makeSession('uuid4', {
      'state.json': '{}',
      'context.jsonl': '{"role":"_system_prompt","content":"hi"}\n{"role":"user","content":"hello"}\n',
      'wire.jsonl': '',
    });
    expect(await classify('uuid4')).toBe('real');
  });

  it('malformed: state.json only (no context.jsonl) is not migratable', async () => {
    const path = join(bucket, 'uuid5');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'state.json'), '{}', 'utf-8');
    expect(await classify('uuid5')).toBe('malformed');
  });

  it('real: context.jsonl alone is enough when it has a real message', async () => {
    await makeSession('uuid6', {
      'context.jsonl': '{"role":"assistant","content":[{"type":"text","text":"hi"}]}\n',
    });
    expect(await classify('uuid6')).toBe('real');
  });

  it('empty: context.jsonl is a zero-byte file', async () => {
    await makeSession('uuid7', { 'context.jsonl': '' });
    expect(await classify('uuid7')).toBe('empty');
  });

  it('empty: context.jsonl holds only a _system_prompt marker', async () => {
    await makeSession('uuid8', {
      'context.jsonl': '{"role":"_system_prompt","content":"You are ..."}\n',
    });
    expect(await classify('uuid8')).toBe('empty');
  });

  it('empty: context.jsonl holds only _checkpoint / _usage markers', async () => {
    await makeSession('uuid9', {
      'context.jsonl': '{"role":"_checkpoint","id":0}\n{"role":"_usage","token_count":12}\n',
    });
    expect(await classify('uuid9')).toBe('empty');
  });

  it('real: context.jsonl is corrupt — migrateOneSession surfaces it as a failure', async () => {
    await makeSession('uuid10', {
      'context.jsonl': 'not-json\n{broken\n}}}\n',
    });
    expect(await classify('uuid10')).toBe('real');
  });

  it('real: a title-only session (empty context + custom title) stays listed', async () => {
    await makeSession('uuid11', {
      'context.jsonl': '',
      'state.json': JSON.stringify({ custom_title: 'My named session' }),
    });
    expect(await classify('uuid11')).toBe('real');
  });

  it('real: title from legacy metadata.json counts when state.json has none', async () => {
    await makeSession('uuid12', {
      'context.jsonl': '{"role":"_checkpoint","id":0}\n',
      'state.json': '{}',
      'metadata.json': JSON.stringify({ title: 'Legacy Title', title_generated: true }),
    });
    expect(await classify('uuid12')).toBe('real');
  });

  it('empty: metadata.json title "Untitled" does not promote a session', async () => {
    await makeSession('uuid13', {
      'context.jsonl': '',
      'metadata.json': JSON.stringify({ title: 'Untitled' }),
    });
    expect(await classify('uuid13')).toBe('empty');
  });

  it('real: a historical flat <uuid>.jsonl session with real messages', async () => {
    await writeFile(
      join(bucket, 'uuid14.jsonl'),
      '{"role":"user","content":"hello from the flat era"}\n',
      'utf-8',
    );
    expect(await classify('uuid14')).toBe('real');
  });

  it('empty: a flat <uuid>.jsonl with only markers and no title', async () => {
    await writeFile(join(bucket, 'uuid15.jsonl'), '{"role":"_checkpoint","id":0}\n', 'utf-8');
    expect(await classify('uuid15')).toBe('empty');
  });

  it('real: dir context wins over a paired flat file', async () => {
    await makeSession('uuid16', {
      'context.jsonl': '{"role":"user","content":"dir wins"}\n',
    });
    await writeFile(join(bucket, 'uuid16.jsonl'), '{"role":"user","content":"flat"}\n', 'utf-8');
    const refs = await listBucketSessions(bucket);
    const ref = refs.find((r) => r.uuid === 'uuid16') as LegacySessionRef;
    expect(ref.contextPath).toBe(join(bucket, 'uuid16', 'context.jsonl'));
    expect(await classifyLegacySession(ref)).toBe('real');
  });

  it('real: a dir without context.jsonl falls back to the paired flat file', async () => {
    const path = join(bucket, 'uuid17');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'state.json'), JSON.stringify({ custom_title: 'x' }), 'utf-8');
    await writeFile(join(bucket, 'uuid17.jsonl'), '{"role":"user","content":"flat"}\n', 'utf-8');
    const refs = await listBucketSessions(bucket);
    const ref = refs.find((r) => r.uuid === 'uuid17') as LegacySessionRef;
    expect(ref.contextPath).toBe(join(bucket, 'uuid17.jsonl'));
    expect(await classifyLegacySession(ref)).toBe('real');
  });

  it('ignores non-.jsonl files in the bucket', async () => {
    await writeFile(join(bucket, '.DS_Store'), 'junk', 'utf-8');
    await writeFile(join(bucket, 'notes.txt'), 'junk', 'utf-8');
    await makeSession('uuid18', {
      'context.jsonl': '{"role":"user","content":"hi"}\n',
    });
    const refs = await listBucketSessions(bucket);
    expect(refs.map((r) => r.uuid)).toEqual(['uuid18']);
  });
});
