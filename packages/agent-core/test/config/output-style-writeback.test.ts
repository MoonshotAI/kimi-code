import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfigString, writeConfigFile } from '../../src/config';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-os-cfg-'));
  tempDirs.push(dir);
  return dir;
}

describe('outputStyle config write-back', () => {
  it('persists output_style through writeConfigFile and reparses it', async () => {
    const configPath = join(makeTempDir(), 'config.toml');
    await writeConfigFile(configPath, { providers: {}, outputStyle: 'concise' });
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('output_style = "concise"');
    expect(parseConfigString(text, configPath).outputStyle).toBe('concise');
  });
});
