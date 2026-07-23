import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleDoctor,
  registerDoctorCommand,
  type DoctorDeps,
} from '#/cli/sub/doctor';
import type { UpdateCache } from '#/cli/update/types';

let dir: string;

const CURRENT_VERSION = '1.0.0';

function upToDateCache(latest = CURRENT_VERSION): Promise<UpdateCache> {
  return Promise.resolve({
    source: 'cdn',
    checkedAt: new Date(0).toISOString(),
    latest,
    manifest: null,
  });
}

beforeEach(async () => {
  dir = join(tmpdir(), `kimi-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeDeps(): {
  deps: DoctorDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    deps: {
      cwd: () => dir,
      defaultConfigPath: () => join(dir, 'config.toml'),
      defaultTuiConfigPath: () => join(dir, 'tui.toml'),
      stdout: { write: (chunk) => stdout.push(chunk) > 0 },
      stderr: { write: (chunk) => stderr.push(chunk) > 0 },
      exit: (code) => {
        exitCodes.push(code);
        throw new Error(`exit ${String(code)}`);
      },
      refreshUpdateCache: upToDateCache,
    },
    stdout,
    stderr,
    exitCodes,
  };
}

async function writeValidConfig(path = join(dir, 'config.toml')): Promise<void> {
  await writeFile(
    path,
    `
[providers.kimi]
type = "kimi"
base_url = "https://api.example.com/v1"
api_key = "YOUR_API_KEY"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = 262144
`,
    'utf-8',
  );
}

async function writeValidTuiConfig(path = join(dir, 'tui.toml')): Promise<void> {
  await writeFile(
    path,
    `
theme = "dark"

[editor]
command = "code --wait"

[notifications]
enabled = true
notification_condition = "unfocused"

[upgrade]
auto_install = true
`,
    'utf-8',
  );
}

describe('kimi doctor', () => {
  it('skips missing default config files without failing', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {}, CURRENT_VERSION);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP config.toml');
    expect(out).toContain('SKIP tui.toml');
    expect(out).toContain('built-in defaults will apply');
  });

  it('checks only config.toml when the config target is selected', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' }, CURRENT_VERSION);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP config.toml');
    expect(out).not.toContain('tui.toml');
  });

  it('checks only tui.toml when the tui target is selected', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'tui' }, CURRENT_VERSION);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP tui.toml');
    expect(out).not.toContain('config.toml');
  });

  it('treats a missing explicit target path as an error', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config', path: './missing.toml' }, CURRENT_VERSION);

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('Kimi doctor found 1 issue.');
    expect(err).toContain(`ERROR config.toml  ${resolve(dir, 'missing.toml')}`);
    expect(err).toContain('File does not exist.');
    expect(err).not.toContain('tui.toml');
  });

  it('checks a valid explicit config path routed through commander', async () => {
    const configPath = join(dir, 'candidate-config.toml');
    await writeValidConfig(configPath);
    const { deps, stdout, stderr, exitCodes } = makeDeps();
    const program = new Command('kimi');
    registerDoctorCommand(program, CURRENT_VERSION, deps);

    await program.parseAsync(['node', 'kimi', 'doctor', 'config', './candidate-config.toml']);

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK config.toml  ${configPath}`);
    expect(out).not.toContain('tui.toml');
    expect(out).toContain('No configuration issues found.');
  });

  it('does not resolve the default config path when an explicit config path is provided', async () => {
    const configPath = join(dir, 'candidate-config.toml');
    await writeValidConfig(configPath);
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(
      {
        ...deps,
        defaultConfigPath: () => {
          throw new Error('default config path should not be resolved');
        },
      },
      { target: 'config', path: './candidate-config.toml' },
      CURRENT_VERSION,
    );

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(`OK config.toml  ${configPath}`);
  });

  it('checks a valid explicit tui path routed through commander', async () => {
    const tuiConfigPath = join(dir, 'candidate-tui.toml');
    await writeValidTuiConfig(tuiConfigPath);
    const { deps, stdout, stderr, exitCodes } = makeDeps();
    const program = new Command('kimi');
    registerDoctorCommand(program, CURRENT_VERSION, deps);

    await program.parseAsync(['node', 'kimi', 'doctor', 'tui', './candidate-tui.toml']);

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK tui.toml     ${tuiConfigPath}`);
    expect(out).not.toContain('config.toml');
    expect(out).toContain('No configuration issues found.');
  });

  it('aggregates config.toml and tui.toml parse errors', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = 0
`,
      'utf-8',
    );
    await writeFile(join(dir, 'tui.toml'), 'editor = 123\n', 'utf-8');
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {}, CURRENT_VERSION);

    expect(code).toBe(1);
    expect(stdout.join('')).toBe('');
    const err = stderr.join('');
    expect(err).toContain('Kimi doctor found 2 issues.');
    expect(err).toContain(`ERROR config.toml  ${join(dir, 'config.toml')}`);
    expect(err).toContain('max_context_size');
    expect(err).toContain(`ERROR tui.toml     ${join(dir, 'tui.toml')}`);
    expect(err).toContain('editor');
  });

  it('formats Zod validation issues with field paths for tui.toml', async () => {
    await writeFile(
      join(dir, 'tui.toml'),
      `
editor = 123

[notifications]
enabled = "yes"
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'tui' }, CURRENT_VERSION);

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('editor:');
    expect(err).toContain('notifications.enabled:');
  });

  it('formats wrapped Zod validation issues with TOML-style field paths for config.toml', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' }, CURRENT_VERSION);

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('models.kimi.max_context_size:');
  });

  it('reports an up-to-date version as OK in the default run', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, {}, CURRENT_VERSION);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(`OK version      v${CURRENT_VERSION} (up to date)`);
  });

  it('warns about a newer version without failing', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(
      { ...deps, refreshUpdateCache: () => upToDateCache('1.1.0') },
      {},
      CURRENT_VERSION,
    );

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`WARN version      v${CURRENT_VERSION} → v1.1.0 available`);
    expect(out).toContain('Run `kimi update` to upgrade.');
    expect(out).toContain('No configuration issues found.');
  });

  it('warns instead of failing when the update check fails', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(
      {
        ...deps,
        refreshUpdateCache: () => Promise.reject(new Error('CDN unreachable')),
      },
      {},
      CURRENT_VERSION,
    );

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`WARN version      v${CURRENT_VERSION}`);
    expect(out).toContain('Failed to check for updates: CDN unreachable');
  });

  it('warns instead of comparing when the current version is not valid semver', async () => {
    const { deps, stdout } = makeDeps();

    const code = await handleDoctor(deps, {}, 'dev');

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('WARN version      vdev');
    expect(out).toContain('comparison skipped');
  });

  it('does not run the version check for targeted runs', async () => {
    const { deps, stdout } = makeDeps();

    const code = await handleDoctor(
      {
        ...deps,
        refreshUpdateCache: () => {
          throw new Error('version check should not run');
        },
      },
      { target: 'config' },
      CURRENT_VERSION,
    );

    expect(code).toBe(0);
    expect(stdout.join('')).not.toContain('version');
  });

  it('counts only config errors as issues when the version check warns', async () => {
    await writeFile(
      join(dir, 'config.toml'),
      `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = 0
`,
      'utf-8',
    );
    const { deps, stderr } = makeDeps();

    const code = await handleDoctor(
      {
        ...deps,
        refreshUpdateCache: () => upToDateCache('1.1.0'),
      },
      {},
      CURRENT_VERSION,
    );

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Kimi doctor found 1 issue.');
    expect(err).toContain('ERROR config.toml');
    expect(err).toContain('WARN version');
  });
});
