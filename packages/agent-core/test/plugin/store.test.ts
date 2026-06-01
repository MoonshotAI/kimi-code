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
});
