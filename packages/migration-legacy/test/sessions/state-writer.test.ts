import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSessionState } from '../../src/sessions/state-writer.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeSessionState', () => {
  it('uses custom_title when present', async () => {
    await writeSessionState(dir, {
      oldState: { custom_title: 'My chat', title_generated: false, wire_mtime: 1.5 },
      lastUserPrompt: 'irrelevant',
      sourcePath: '/Users/me/.kimi/sessions/x/y',
      oldSessionUuid: 'old-uuid',
      wireProtocolFromOld: '1.10',
      createdAtMs: 1000,
    });
    const meta = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    expect(meta.title).toBe('My chat');
    expect(meta.isCustomTitle).toBe(true);
    // `agents.main.homedir` must be the agent's record directory under the
    // session dir — kimi-core reads `wire.jsonl` from here on resume.
    expect(meta.agents.main.homedir).toBe(join(dir, 'agents', 'main'));
    expect(meta.custom.imported_from_kimi_cli).toBe(true);
    expect(meta.custom.kimi_cli_session_id).toBe('old-uuid');
  });

  it('falls back to lastUserPrompt prefix when no custom_title', async () => {
    await writeSessionState(dir, {
      oldState: { wire_mtime: 1 },
      lastUserPrompt: 'help me write a haiku about a duck swimming under the bridge',
      sourcePath: '/a',
      oldSessionUuid: 'u',
      wireProtocolFromOld: null,
      createdAtMs: 1,
    });
    const meta = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    expect(meta.title.length).toBeLessThanOrEqual(50);
    expect(meta.title).toContain('haiku');
    expect(meta.isCustomTitle).toBe(false);
  });

  it('treats a blank/whitespace-only custom_title as absent and falls back', async () => {
    await writeSessionState(dir, {
      oldState: { custom_title: '   ', title_generated: false, wire_mtime: 1 },
      lastUserPrompt: 'a real prompt here',
      sourcePath: '/a',
      oldSessionUuid: 'u',
      wireProtocolFromOld: null,
      createdAtMs: 1,
    });
    const meta = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    expect(meta.title).toBe('a real prompt here');
    expect(meta.isCustomTitle).toBe(false);
  });

  it('trims surrounding whitespace from a custom_title', async () => {
    await writeSessionState(dir, {
      oldState: { custom_title: '  My chat  ', title_generated: false, wire_mtime: 1 },
      lastUserPrompt: 'irrelevant',
      sourcePath: '/a',
      oldSessionUuid: 'u',
      wireProtocolFromOld: null,
      createdAtMs: 1,
    });
    const meta = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    expect(meta.title).toBe('My chat');
    expect(meta.isCustomTitle).toBe(true);
  });

  it('uses Imported session as fallback when no title source', async () => {
    await writeSessionState(dir, {
      oldState: { wire_mtime: 1 },
      lastUserPrompt: '',
      sourcePath: '/a',
      oldSessionUuid: 'u',
      wireProtocolFromOld: null,
      createdAtMs: 1,
    });
    const meta = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    expect(meta.title).toBe('Imported session');
  });

  it('archived flag is preserved in custom', async () => {
    await writeSessionState(dir, {
      oldState: { archived: true, wire_mtime: 1 },
      lastUserPrompt: 'x',
      sourcePath: '/a',
      oldSessionUuid: 'u',
      wireProtocolFromOld: null,
      createdAtMs: 1,
    });
    const meta = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'));
    expect(meta.custom.archived).toBe(true);
  });
});
