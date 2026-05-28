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
});
