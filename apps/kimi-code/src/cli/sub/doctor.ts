import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  createKimiConfigRpc,
  type KimiConfigRpc,
  type KimiConfigValidationIssue,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';
import { z } from 'zod';

import { getTuiConfigPath, parseTuiConfig } from '#/tui/config';

interface WritableLike {
  write(chunk: string): boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface DoctorDeps {
  readonly cwd: () => string;
  readonly defaultConfigPath: () => MaybePromise<string>;
  readonly defaultTuiConfigPath: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly configRpc?: KimiConfigRpc;
  readonly fileExists?: (path: string) => boolean;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly validateConfigToml?: (text: string, path: string) => MaybePromise<void>;
}

export interface DoctorOptions {
  readonly target?: 'config' | 'tui';
  readonly path?: string;
}

interface CheckSpec {
  readonly label: 'config.toml' | 'tui.toml';
  readonly path: string;
  readonly explicit: boolean;
  readonly parse: (text: string, path: string) => MaybePromise<void>;
}

interface CheckResult {
  readonly label: CheckSpec['label'];
  readonly path: string;
  readonly status: 'OK' | 'SKIP' | 'ERROR';
  readonly message?: string;
}

interface ResolvedDoctorDeps {
  readonly cwd: () => string;
  readonly defaultConfigPath: () => MaybePromise<string>;
  readonly defaultTuiConfigPath: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly fileExists: (path: string) => boolean;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly validateConfigToml: (text: string, path: string) => MaybePromise<void>;
}

export async function handleDoctor(deps: DoctorDeps, options: DoctorOptions): Promise<number> {
  const resolved = resolveDeps(deps);
  const cwd = resolved.cwd();
  const specs = await buildCheckSpecs(resolved, options, cwd);
  const results = await Promise.all(specs.map((spec) => checkTomlFile(resolved, spec)));

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
  let configRpc = deps?.configRpc;
  const getConfigRpc = (): KimiConfigRpc => {
    configRpc ??= createKimiConfigRpc();
    return configRpc;
  };

  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    defaultConfigPath: deps?.defaultConfigPath ?? (() => getConfigRpc().resolveConfigPath()),
    defaultTuiConfigPath: deps?.defaultTuiConfigPath ?? getTuiConfigPath,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: deps?.exit ?? ((code) => process.exit(code)),
    fileExists: deps?.fileExists ?? existsSync,
    readTextFile: deps?.readTextFile ?? ((path) => readFile(path, 'utf-8')),
    validateConfigToml:
      deps?.validateConfigToml ??
      ((text, filePath) => getConfigRpc().validateConfigToml({ text, filePath })),
  };
}

async function buildCheckSpecs(
  deps: ResolvedDoctorDeps,
  options: DoctorOptions,
  cwd: string,
): Promise<CheckSpec[]> {
  if (options.target === 'config') {
    return [
      makeConfigSpec(
        await resolveConfigTargetPath(deps, options.path, cwd),
        options.path !== undefined,
        deps,
      ),
    ];
  }

  if (options.target === 'tui') {
    return [
      makeTuiSpec(
        resolveTuiTargetPath(deps, options.path, cwd),
        options.path !== undefined,
      ),
    ];
  }

  return [
    makeConfigSpec(await deps.defaultConfigPath(), false, deps),
    makeTuiSpec(deps.defaultTuiConfigPath(), false),
  ];
}

function makeConfigSpec(
  path: string,
  explicit: boolean,
  deps: ResolvedDoctorDeps,
): CheckSpec {
  return {
    label: 'config.toml',
    path,
    explicit,
    parse: (text, filePath) => {
      return deps.validateConfigToml(text, filePath);
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
    await spec.parse(text, spec.path);
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

async function resolveConfigTargetPath(
  deps: ResolvedDoctorDeps,
  input: string | undefined,
  cwd: string,
): Promise<string> {
  return input === undefined ? deps.defaultConfigPath() : resolveInputPath(input, cwd);
}

function resolveTuiTargetPath(
  deps: ResolvedDoctorDeps,
  input: string | undefined,
  cwd: string,
): string {
  return input === undefined ? deps.defaultTuiConfigPath() : resolveInputPath(input, cwd);
}

function resolveInputPath(input: string, cwd: string): string {
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
  const validationIssues = findValidationIssues(error);
  if (validationIssues !== undefined) {
    return [
      `Invalid configuration in ${filePath}.`,
      'Validation issues:',
      ...validationIssues.map((issue) => `  ${formatIssuePath(issue.path)}: ${issue.message}`),
    ].join('\n');
  }

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

function findValidationIssues(error: unknown): readonly KimiConfigValidationIssue[] | undefined {
  if (!(error instanceof Error)) return undefined;
  const details = 'details' in error ? error.details : undefined;
  if (!isRecord(details)) return undefined;
  const validationIssues = details['validationIssues'];
  return isValidationIssueArray(validationIssues) ? validationIssues : undefined;
}

function isValidationIssueArray(value: unknown): value is readonly KimiConfigValidationIssue[] {
  return Array.isArray(value) && value.every(isValidationIssue);
}

function isValidationIssue(value: unknown): value is KimiConfigValidationIssue {
  if (!isRecord(value) || typeof value['message'] !== 'string') return false;
  const path = value['path'];
  return (
    Array.isArray(path) &&
    path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
