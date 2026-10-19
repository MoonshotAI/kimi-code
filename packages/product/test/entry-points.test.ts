import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const resolve = createRequire(import.meta.url).resolve;
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
  types: [],
  strict: true,
  skipLibCheck: false,
  noEmit: true,
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(directory, name));
}

function productDependencies(program: ts.Program): string[] {
  return program.getSourceFiles()
    .map((source) => relative(sourceRoot, source.fileName).replaceAll('\\', '/'))
    .filter((path) => !path.startsWith('../'))
    .toSorted();
}

describe('product entry points', () => {
  it.each([
    ['client-configs/node', 'client-configs/node/index.ts'],
    ['session-rating', 'session-rating/common/index.ts'],
    ['session-rating/node', 'session-rating/node/index.ts'],
  ])('resolves the %s public entry', (subpath, source) => {
    expect(resolve(`@moonshot-ai/kimi-code-product/${subpath}`)).toBe(join(sourceRoot, source));
  });

  it('typechecks the public contract and all common modules without Node types', () => {
    const consumerPath = fileURLToPath(new URL('common-consumer.ts', import.meta.url)).replaceAll('\\', '/');
    const consumer = `
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
    `;
    const host = ts.createCompilerHost(compilerOptions);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === consumerPath
        ? ts.createSourceFile(fileName, consumer, languageVersion, true)
        : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram({
      rootNames: [...sourceFiles(join(sourceRoot, 'session-rating/common')), consumerPath],
      options: compilerOptions,
      host,
    });

    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    )).toEqual([]);
    expect(productDependencies(program).filter((path) =>
      !path.startsWith('session-rating/common/') && !path.startsWith('shared/common/'),
    )).toEqual([]);
    expect(program.getSourceFiles().filter((source) =>
      source.fileName.replaceAll('\\', '/').includes('/@types/node/'),
    )).toEqual([]);
  });

  it('keeps shared helpers independent of product domains', () => {
    const program = ts.createProgram({
      rootNames: sourceFiles(join(sourceRoot, 'shared/node')),
      options: { ...compilerOptions, types: ['node'] },
    });

    expect(productDependencies(program).filter((path) => !path.startsWith('shared/'))).toEqual([]);
  });
});
