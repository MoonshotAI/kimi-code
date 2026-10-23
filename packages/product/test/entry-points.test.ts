import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const resolve = createRequire(import.meta.url).resolve;
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const testRoot = import.meta.dirname;
const tscBinPath = join(dirname(resolve('typescript/package.json')), 'bin/tsc');

const baseCompilerOptions = {
  target: 'ES2024',
  module: 'Preserve',
  moduleResolution: 'Bundler',
  lib: ['es2024', 'dom'],
  strict: true,
  skipLibCheck: false,
  noEmit: true,
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(directory, name));
}

interface CheckResult {
  diagnostics: string[];
  files: string[];
}

function runTsc(configPath: string): CheckResult {
  const result = spawnSync(process.execPath, [tscBinPath, '-p', configPath, '--listFiles'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    diagnostics: lines.filter((line) => line.includes('error TS')),
    files: lines.filter((line) => line.startsWith('/') || /^[A-Za-z]:[\\/]/.test(line)),
  };
}

function productSources(files: string[]): string[] {
  return files
    .map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))
    .filter((path) => !path.startsWith('../'))
    .toSorted();
}

describe('product entry points', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(testRoot, '.tmp-entry-points-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(name: string, files: string[], types: string[]): string {
    const configPath = join(tempDir, name);
    writeFileSync(configPath, JSON.stringify({
      compilerOptions: { ...baseCompilerOptions, types },
      files,
    }));
    return configPath;
  }

  it.each([
    ['client-configs/node', 'client-configs/node/index.ts'],
    ['session-rating', 'session-rating/common/index.ts'],
    ['session-rating/node', 'session-rating/node/index.ts'],
  ])('resolves the %s public entry', (subpath, source) => {
    expect(resolve(`@moonshot-ai/kimi-code-product/${subpath}`)).toBe(join(sourceRoot, source));
  });

  it('typechecks the public contract and all common modules without Node types', { timeout: 60_000 }, () => {
    const consumerPath = join(tempDir, 'common-consumer.ts');
    writeFileSync(consumerPath, `
      import type {
        RatingOffer, RatingReport, RatingResponse, SurveyKind, SurveyResponse,
      } from '@moonshot-ai/kimi-code-product/session-rating';
      const survey: SurveyKind = 'session';
      const response: RatingResponse = 'good';
      export const dismissed: SurveyResponse = 'dismissed';
      export const offer: RatingOffer = { appearanceId: 'example', survey };
      export const report: RatingReport = {
        type: 'respond', appearanceId: offer.appearanceId, response,
      };
    `);
    const configPath = writeConfig('tsconfig.contract.json', [
      ...sourceFiles(join(sourceRoot, 'session-rating/common')),
      consumerPath,
    ], []);
    const { diagnostics, files } = runTsc(configPath);

    expect(diagnostics).toEqual([]);
    expect(productSources(files).filter((path) =>
      !path.startsWith('session-rating/common/') && !path.startsWith('shared/common/'),
    )).toEqual([]);
    expect(files.filter((file) => file.replaceAll('\\', '/').includes('/@types/node/'))).toEqual([]);
  });

  it('keeps shared helpers independent of product domains', { timeout: 60_000 }, () => {
    const configPath = writeConfig(
      'tsconfig.shared-node.json',
      sourceFiles(join(sourceRoot, 'shared/node')),
      ['node'],
    );
    const { diagnostics, files } = runTsc(configPath);

    expect(diagnostics).toEqual([]);
    expect(productSources(files).filter((path) => !path.startsWith('shared/'))).toEqual([]);
  });
});
