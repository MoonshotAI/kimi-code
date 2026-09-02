import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type InstalledFile,
  readInstalled,
  writeInstalled,
} from '../../src/plugin/store';

async function makeKimiHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

describe('plugin store', () => {
  it('returns an empty list when the file does not exist', async () => {
    const home = await makeKimiHome();
    const result = await readInstalled(home);
    expect(result.plugins).toEqual([]);
    expect(result.version).toBe(1);
  });

  it('writes and reads installed.json round-trip', async () => {
    const home = await makeKimiHome();
    const data: InstalledFile = {
      version: 1,
      plugins: [
        {
          id: 'demo',
          root: '/tmp/demo',
          source: 'local-path',
          enabled: true,
          installedAt: '2026-05-25T09:00:00Z',
          updatedAt: '2026-05-25T10:00:00Z',
          originalSource: '/tmp/demo',
          capabilities: {
            mcpServers: {
              finance: { enabled: true },
            },
          },
        },
      ],
    };
    await writeInstalled(home, data);
    const result = await readInstalled(home);
    expect(result).toEqual(data);
  });

  it('writes atomically (no .tmp left after success)', async () => {
    const home = await makeKimiHome();
    await writeInstalled(home, { version: 1, plugins: [] });
    const after = await readFile(path.join(home, 'plugins', 'installed.json'), 'utf8');
    expect(after).toContain('"version": 1');
  });

  it('throws on a corrupt installed.json instead of silently dropping it', async () => {
    const home = await makeKimiHome();
    await writeInstalled(home, { version: 1, plugins: [] });
    await writeFile(path.join(home, 'plugins', 'installed.json'), '{ not json', 'utf8');
    await expect(readInstalled(home)).rejects.toThrow(/parse/i);
  });

  it('round-trips a github-sourced record', async () => {
    const home = await makeKimiHome();
    const data: InstalledFile = {
      version: 1,
      plugins: [
        {
          id: 'superpowers',
          root: '/tmp/superpowers',
          source: 'github',
          enabled: true,
          installedAt: '2026-05-29T12:00:00Z',
          updatedAt: '2026-05-29T12:00:00Z',
          originalSource: 'https://github.com/wbxl2000/superpowers/tree/main',
          github: {
            owner: 'wbxl2000',
            repo: 'superpowers',
            ref: { kind: 'branch', value: 'main' },
            installedSha: '45b441d62b81b5f27d3bfd8700e04436cd4de5b3',
          },
        },
      ],
    };
    await writeInstalled(home, data);
    const result = await readInstalled(home);
    expect(result).toEqual(data);
  });

  it('reads a legacy record without github field unchanged', async () => {
    const home = await makeKimiHome();
    await writeInstalled(home, { version: 1, plugins: [] });
    await writeFile(
      path.join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root: '/tmp/demo',
            source: 'zip-url',
            enabled: true,
            installedAt: '2026-05-01T00:00:00Z',
            originalSource: 'https://example.com/demo.zip',
          },
        ],
      }),
      'utf8',
    );
    const result = await readInstalled(home);
    expect(result.plugins).toHaveLength(1);
    const record = result.plugins[0];
    expect(record).toBeDefined();
    expect(record?.id).toBe('demo');
    expect(record?.source).toBe('zip-url');
    expect((record as { github?: unknown } | undefined)?.github).toBeUndefined();
  });

  async function writeRaw(home: string, file: unknown): Promise<void> {
    await writeInstalled(home, { version: 1, plugins: [] });
    await writeFile(
      path.join(home, 'plugins', 'installed.json'),
      JSON.stringify(file),
      'utf8',
    );
  }

  const VALID_RECORD = {
    id: 'demo',
    root: '/tmp/demo',
    source: 'local-path',
    enabled: true,
    installedAt: '2026-05-25T09:00:00Z',
  };

  it.each([
    ['a null entry', null],
    ['a non-object entry', 'demo'],
    ['a record with no id', { ...VALID_RECORD, id: undefined }],
    ['a record with a non-string root', { ...VALID_RECORD, root: 42 }],
    ['a record with an unknown source', { ...VALID_RECORD, source: 'ftp' }],
    ['a record with a non-boolean enabled', { ...VALID_RECORD, enabled: 'yes' }],
    ['a record with a non-string installedAt', { ...VALID_RECORD, installedAt: 5 }],
    [
      'a github record with no ref',
      { ...VALID_RECORD, source: 'github', github: { owner: 'a', repo: 'b' } },
    ],
    [
      'a github record with an unknown ref kind',
      {
        ...VALID_RECORD,
        source: 'github',
        github: { owner: 'a', repo: 'b', ref: { kind: 'commit', value: 'abc' } },
      },
    ],
  ])('rejects %s instead of returning it as an InstalledRecord', async (_label, entry) => {
    const home = await makeKimiHome();
    await writeRaw(home, { version: 1, plugins: [entry] });
    await expect(readInstalled(home)).rejects.toThrow(/plugins\[0\]/);
  });

  it('names the offending index so the user can find the bad record', async () => {
    const home = await makeKimiHome();
    await writeRaw(home, {
      version: 1,
      plugins: [VALID_RECORD, { ...VALID_RECORD, id: 'other', enabled: 'yes' }],
    });
    await expect(readInstalled(home)).rejects.toThrow(/plugins\[1\]/);
  });

  it('keeps unknown keys so a record from a newer version round-trips', async () => {
    const home = await makeKimiHome();
    await writeRaw(home, {
      version: 1,
      plugins: [{ ...VALID_RECORD, futureField: { nested: true } }],
    });
    const result = await readInstalled(home);
    expect(result.plugins).toHaveLength(1);
    expect((result.plugins[0] as { futureField?: unknown }).futureField).toEqual({
      nested: true,
    });
  });

  // A top-level unknown key is not enough: `readInstalled` returns what the next
  // `writeInstalled` persists, so any level that strips loses the field for good.
  it('keeps unknown keys nested inside github and capabilities, and survives a rewrite', async () => {
    const home = await makeKimiHome();
    const fromNewerVersion = {
      ...VALID_RECORD,
      futureTopLevel: 'kept',
      github: {
        owner: 'wbxl2000',
        repo: 'superpowers',
        ref: { kind: 'tag', value: 'v1.2.0', resolvedAt: '2026-07-28T00:00:00Z' },
        installedSha: '45b441d62b81b5f27d3bfd8700e04436cd4de5b3',
        signature: 'ed25519:abc',
      },
      capabilities: {
        mcpServers: { finance: { enabled: true, transport: 'stdio' } },
      },
    };
    await writeRaw(home, { version: 1, plugins: [fromNewerVersion] });

    const read = await readInstalled(home);
    expect(read.plugins[0]).toEqual(fromNewerVersion);

    // The load-edit-save path an older client actually takes.
    await writeInstalled(home, read);
    const reread = await readInstalled(home);
    expect(reread.plugins[0]).toEqual(fromNewerVersion);
  });
});
