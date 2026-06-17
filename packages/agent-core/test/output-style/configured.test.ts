import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfiguredOutputStyleBody } from '../../src/output-style';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'osc-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('loadConfiguredOutputStyleBody', () => {
  it('returns undefined when no name is configured', async () => {
    expect(await loadConfiguredOutputStyleBody({ name: undefined, userHomeDir: dir, workDir: dir })).toBeUndefined();
    expect(await loadConfiguredOutputStyleBody({ name: '   ', userHomeDir: dir, workDir: dir })).toBeUndefined();
  });
  it('resolves a built-in style body by name', async () => {
    const body = await loadConfiguredOutputStyleBody({ name: 'concise', userHomeDir: dir, workDir: dir });
    expect(body).toContain('Respond as briefly');
  });
  it('returns undefined for an unknown style name', async () => {
    expect(await loadConfiguredOutputStyleBody({ name: 'nope', userHomeDir: dir, workDir: dir })).toBeUndefined();
  });
  it('resolves a user-defined style that overrides a built-in', async () => {
    const styleDir = path.join(dir, 'output-styles');
    await mkdir(styleDir, { recursive: true });
    await writeFile(path.join(styleDir, 'concise.md'), '---\nname: concise\n---\nMY OVERRIDE');
    const body = await loadConfiguredOutputStyleBody({ name: 'concise', userHomeDir: dir, brandHomeDir: dir, workDir: dir });
    expect(body).toBe('MY OVERRIDE');
  });
});
