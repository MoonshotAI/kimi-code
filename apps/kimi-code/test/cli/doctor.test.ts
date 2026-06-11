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

let dir: string;

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

    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP config.toml');
    expect(out).toContain('SKIP tui.toml');
    expect(out).toContain('built-in defaults will apply');
  });

  it('checks only config.toml when the config target is selected', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP config.toml');
    expect(out).not.toContain('tui.toml');
  });

  it('checks only tui.toml when the tui target is selected', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'tui' });

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain('SKIP tui.toml');
    expect(out).not.toContain('config.toml');
  });

  it('treats a missing explicit target path as an error', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await handleDoctor(deps, { target: 'config', path: './missing.toml' });

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
    registerDoctorCommand(program, deps);

    await program.parseAsync(['node', 'kimi', 'doctor', 'config', './candidate-config.toml']);

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK config.toml  ${configPath}`);
    expect(out).not.toContain('tui.toml');
    expect(out).toContain('All checked config files are valid.');
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
    registerDoctorCommand(program, deps);

    await program.parseAsync(['node', 'kimi', 'doctor', 'tui', './candidate-tui.toml']);

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const out = stdout.join('');
    expect(out).toContain(`OK tui.toml     ${tuiConfigPath}`);
    expect(out).not.toContain('config.toml');
    expect(out).toContain('All checked config files are valid.');
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

    const code = await handleDoctor(deps, {});

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

    const code = await handleDoctor(deps, { target: 'tui' });

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

    const code = await handleDoctor(deps, { target: 'config' });

    expect(code).toBe(1);
    const err = stderr.join('');
    expect(err).toContain('Validation issues:');
    expect(err).toContain('models.kimi.max_context_size:');
  });
});
