import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  expandCommandArguments,
  loadPluginCommand,
  parseCommandText,
} from '#/app/plugin/commands';

describe('plugin command parser', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-command-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses frontmatter name and description', () => {
    const commandPath = join(dir, 'deploy.md');
    const result = parseCommandText({
      text: '---\nname: deploy\ndescription: Deploy the app\n---\n\nRun deploy.',
      commandPath,
      pluginId: 'demo',
    });

    expect(result).toEqual({
      pluginId: 'demo',
      name: 'deploy',
      description: 'Deploy the app',
      body: 'Run deploy.',
      path: commandPath,
    });
  });

  it('falls back to the file name and first body line', () => {
    const commandPath = join(dir, 'frontend/component.md');
    const result = parseCommandText({
      text: 'Build the component\n\nMore detail.',
      commandPath,
      pluginId: 'demo',
      fallbackName: 'frontend/component',
    });

    expect(result.name).toBe('frontend/component');
    expect(result.description).toBe('Build the component');
    expect(result.body).toBe('Build the component\n\nMore detail.');
  });

  it('loads a command file and returns undefined for missing files', async () => {
    const commandPath = join(dir, 'deploy.md');
    await writeFile(commandPath, '---\ndescription: Deploy\n---\n\nBody', 'utf8');

    await expect(loadPluginCommand({ commandPath, pluginId: 'demo' })).resolves.toMatchObject({
      pluginId: 'demo',
      name: 'deploy',
      description: 'Deploy',
      body: 'Body',
    });
    await expect(loadPluginCommand({ commandPath: join(dir, 'missing.md'), pluginId: 'demo' })).resolves.toBeUndefined();
  });

  it('expands $ARGUMENTS and appends args when no placeholder exists', () => {
    expect(expandCommandArguments('deploy $ARGUMENTS now', 'prod')).toBe('deploy prod now');
    expect(expandCommandArguments('deploy now', 'prod')).toBe('deploy now\n\nARGUMENTS: prod');
    expect(expandCommandArguments('deploy now', '')).toBe('deploy now');
  });
});
