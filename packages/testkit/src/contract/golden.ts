import { readFile } from 'node:fs/promises';

import { classifyContractChanges, describeContractChanges, type ContractChange } from '#/contract/changes';
import { canonical, summarizeContract } from '#/contract/summary';
import { TestkitError } from '#/errors';
import { expectGolden, expectTextGolden, REFRESH_ENV, stableJson } from '#/fixtures/golden';

export interface ContractGoldenPaths {
  readonly openapi: string;
  readonly asyncapi: string;
  readonly summary: string;
}

export interface ContractGoldenOptions {
  readonly kind: string;
  readonly refreshCommand: string;
}

export const CONTRACT_SUMMARY_HEADER = [
  '# Field-level summary of the published KAP contract, one line per field, generated from openapi.json and asyncapi.json.',
  '# Review contract changes here first; the JSON files keep details this summary leaves out, such as descriptions.',
  '# "shape <hash>" names a schema used in many places; its fields are listed once at the end.',
];

export function contractSummaryText(openapi: unknown, asyncapi: unknown): string {
  return `${[...CONTRACT_SUMMARY_HEADER, ...summarizeContract(openapi, asyncapi).lines].join('\n')}\n`;
}

export async function expectContractGolden(paths: ContractGoldenPaths, live: { readonly openapi: unknown; readonly asyncapi: unknown }, options: ContractGoldenOptions): Promise<readonly ContractChange[]> {
  const summary = contractSummaryText(live.openapi, live.asyncapi);
  if (process.env[REFRESH_ENV] === options.kind) {
    await expectGolden(paths.openapi, live.openapi, options);
    await expectGolden(paths.asyncapi, live.asyncapi, options);
    await expectTextGolden(paths.summary, summary, options);
    return [];
  }
  const committed = { openapi: await readJson(paths.openapi, options), asyncapi: await readJson(paths.asyncapi, options) };
  const changes = classifyContractChanges(summarizeContract(committed.openapi, committed.asyncapi), summarizeContract(live.openapi, live.asyncapi));
  const documentsChanged = stableJson(committed.openapi) !== stableJson(live.openapi) || stableJson(committed.asyncapi) !== stableJson(live.asyncapi);
  if (changes.length > 0 || documentsChanged) {
    const onlyWording = canonical(committed.openapi) === canonical(live.openapi) && canonical(committed.asyncapi) === canonical(live.asyncapi);
    const detail = changes.length > 0
      ? describeContractChanges(changes)
      : [onlyWording
        ? 'Only descriptions, examples or formatting changed; no field changed.'
        : 'The documents differ in schema details this summary does not model; read the JSON diff of openapi.json and asyncapi.json before refreshing.'];
    throw new TestkitError([`The published KAP contract differs from the committed one.`, ...detail, `To accept the change intentionally: ${options.refreshCommand}`].join('\n'));
  }
  await expectTextGolden(paths.summary, summary, options);
  return changes;
}

async function readJson(path: string, options: ContractGoldenOptions): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new TestkitError(`Cannot read the committed contract ${path}; create it with: ${options.refreshCommand}`, { cause: error });
  }
}
