import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { parseConfigString, resolveConfigPath } from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';
import { z } from 'zod';

import { getTuiConfigPath, parseTuiConfig } from '#/tui/config';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface DoctorDeps {
  readonly cwd: () => string;
  readonly defaultConfigPath: () => string;
  readonly defaultTuiConfigPath: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly fileExists?: (path: string) => boolean;
  readonly readTextFile?: (path: string) => Promise<string>;
}

export interface DoctorOptions {
  readonly target?: 'config' | 'tui';
  readonly path?: string;
}

interface CheckSpec {
  readonly label: 'config.toml' | 'tui.toml';
  readonly path: string;
  readonly explicit: boolean;
  readonly parse: (text: string, path: string) => void;
}

interface CheckResult {
  readonly label: CheckSpec['label'];
  readonly path: string;
  readonly status: 'OK' | 'SKIP' | 'ERROR';
  readonly message?: string;
}

interface ResolvedDoctorDeps {
  readonly cwd: () => string;
  readonly defaultConfigPath: () => string;
  readonly defaultTuiConfigPath: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly fileExists: (path: string) => boolean;
  readonly readTextFile: (path: string) => Promise<string>;
}

export async function handleDoctor(deps: DoctorDeps, options: DoctorOptions): Promise<number> {
  const resolved = resolveDeps(deps);
  const cwd = resolved.cwd();
  const results = await Promise.all(buildCheckSpecs(resolved, options, cwd).map((spec) => checkTomlFile(resolved, spec)));

  const issueCount = results.filter((result) => result.status === 'ERROR').length;
  const text = issueCount === 0 ? formatSuccess(results) : formatFailure(results, issueCount);
  if (issueCount === 0) {
    resolved.stdout.write(text);
  } else {
    resolved.stderr.write(text);
  }
  return issueCount === 0 ? 0 : 1;
}

export function registerDoctorCommand(parent: Command, deps?: Partial<DoctorDeps>): void {
  const doctor = parent
    .command('doctor')
    .description('Validate Kimi Code configuration files.')
    .action(async () => {
      await runDoctorCommand(deps, {});
    });

  doctor
    .command('config')
    .description('Validate config.toml.')
    .argument('[path]', 'Validate this file as config.toml instead of the default path.')
    .action(async (path: string | undefined) => {
      await runDoctorCommand(deps, { target: 'config', path });
    });

  doctor
    .command('tui')
    .description('Validate tui.toml.')
    .argument('[path]', 'Validate this file as tui.toml instead of the default path.')
    .action(async (path: string | undefined) => {
      await runDoctorCommand(deps, { target: 'tui', path });
    });
}

async function runDoctorCommand(
  deps: Partial<DoctorDeps> | undefined,
  options: DoctorOptions,
): Promise<void> {
  const resolved = resolveDeps(deps);
  const code = await handleDoctor(resolved, options);
  if (code !== 0) resolved.exit(code);
}

function resolveDeps(deps: Partial<DoctorDeps> | DoctorDeps | undefined): ResolvedDoctorDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    defaultConfigPath: deps?.defaultConfigPath ?? (() => resolveConfigPath({})),
    defaultTuiConfigPath: deps?.defaultTuiConfigPath ?? getTuiConfigPath,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: deps?.exit ?? ((code) => process.exit(code)),
    fileExists: deps?.fileExists ?? existsSync,
    readTextFile: deps?.readTextFile ?? ((path) => readFile(path, 'utf-8')),
  };
}

function buildCheckSpecs(
  deps: ResolvedDoctorDeps,
  options: DoctorOptions,
  cwd: string,
): CheckSpec[] {
  if (options.target === 'config') {
    return [
      makeConfigSpec(resolveInputPath(options.path, deps.defaultConfigPath(), cwd), options.path !== undefined),
    ];
  }

  if (options.target === 'tui') {
    return [
      makeTuiSpec(resolveInputPath(options.path, deps.defaultTuiConfigPath(), cwd), options.path !== undefined),
    ];
  }

  return [
    makeConfigSpec(deps.defaultConfigPath(), false),
    makeTuiSpec(deps.defaultTuiConfigPath(), false),
  ];
}

function makeConfigSpec(path: string, explicit: boolean): CheckSpec {
  return {
    label: 'config.toml',
    path,
    explicit,
    parse: (text, filePath) => {
      parseConfigString(text, filePath);
    },
  };
}

function makeTuiSpec(path: string, explicit: boolean): CheckSpec {
  return {
    label: 'tui.toml',
    path,
    explicit,
    parse: (text) => {
      parseTuiConfig(text);
    },
  };
}

async function checkTomlFile(deps: ResolvedDoctorDeps, spec: CheckSpec): Promise<CheckResult> {
  if (!deps.fileExists(spec.path)) {
    return {
      label: spec.label,
      path: spec.path,
      status: spec.explicit ? 'ERROR' : 'SKIP',
      message: spec.explicit
        ? 'File does not exist.'
        : 'File does not exist; built-in defaults will apply.',
    };
  }

  try {
    const text = await deps.readTextFile(spec.path);
    spec.parse(text, spec.path);
    return { label: spec.label, path: spec.path, status: 'OK' };
  } catch (error) {
    return {
      label: spec.label,
      path: spec.path,
      status: 'ERROR',
      message: formatErrorMessage(error, spec.path),
    };
  }
}

function resolveInputPath(input: string | undefined, defaultPath: string, cwd: string): string {
  if (input === undefined) return defaultPath;
  return isAbsolute(input) ? input : resolve(cwd, input);
}

function formatSuccess(results: readonly CheckResult[]): string {
  return [
    'Kimi doctor',
    '',
    ...formatResults(results),
    '',
    'All checked config files are valid.',
    '',
  ].join('\n');
}

function formatFailure(results: readonly CheckResult[], issueCount: number): string {
  return [
    `Kimi doctor found ${String(issueCount)} ${issueCount === 1 ? 'issue' : 'issues'}.`,
    '',
    ...formatResults(results),
    '',
  ].join('\n');
}

function formatResults(results: readonly CheckResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.status} ${result.label.padEnd(12)} ${result.path}`);
    if (result.message !== undefined) {
      for (const line of result.message.split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }
  return lines;
}

function formatErrorMessage(error: unknown, filePath: string): string {
  const zodError = findZodError(error);
  if (zodError !== undefined) {
    return [
      `Invalid configuration in ${filePath}.`,
      'Validation issues:',
      ...zodError.issues.map((issue) => `  ${formatIssuePath(issue.path)}: ${issue.message}`),
    ].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<root>';

  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${String(segment)}]`;
    } else if (out.length === 0) {
      out = camelToSnake(String(segment));
    } else {
      out += `.${camelToSnake(String(segment))}`;
    }
  }
  return out;
}

function camelToSnake(value: string): string {
  return value.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
