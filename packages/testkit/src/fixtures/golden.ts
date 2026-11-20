import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { TestkitError } from '#/errors';

export const REFRESH_ENV = 'TESTKIT_REFRESH';
const LISTED_DIFFERENCES = 40;

export interface GoldenOptions {
  readonly kind: string;
  readonly refreshCommand: string;
}

export interface JsonDifference {
  readonly pointer: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) => sortKeys(item), 2)}\n`;
}

export function jsonDifferences(expected: unknown, actual: unknown, pointer = ''): JsonDifference[] {
  if (Object.is(expected, actual)) return [];
  const bothArrays = Array.isArray(expected) && Array.isArray(actual);
  const bothObjects = isPlainObject(expected) && isPlainObject(actual);
  if (bothArrays) {
    const length = Math.max(expected.length, actual.length);
    return Array.from({ length }, (_, index) => jsonDifferences(expected[index], actual[index], `${pointer}/${index}`)).flat();
  }
  if (bothObjects) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted();
    return keys.flatMap((key) => jsonDifferences(expected[key], actual[key], `${pointer}/${escapePointer(key)}`));
  }
  return [{ pointer, expected, actual }];
}

export function describeDifferences(differences: readonly JsonDifference[]): string[] {
  const listed = differences.slice(0, LISTED_DIFFERENCES).map(
    ({ pointer, expected, actual }) => `- ${pointer === '' ? '/' : pointer}: expected ${show(expected)}, received ${show(actual)}`,
  );
  const hidden = differences.length - listed.length;
  return hidden > 0 ? [...listed, `- … and ${hidden} more`] : listed;
}

export async function expectGolden(path: string, value: unknown, options: GoldenOptions): Promise<void> {
  const text = stableJson(value);
  const committed = await mismatchedGolden(path, text, options);
  if (committed === undefined) return;
  const differences = jsonDifferences(JSON.parse(committed), JSON.parse(text));
  const summary = differences.length === 0
    ? [`${path} has the same data as the committed golden but different formatting:`]
    : [`${path} differs from the committed golden in ${differences.length} place(s):`, ...describeDifferences(differences)];
  throw new TestkitError([...summary, `To accept the change intentionally: ${options.refreshCommand}`].join('\n'));
}

export async function expectTextGolden(path: string, text: string, options: GoldenOptions): Promise<void> {
  const committed = await mismatchedGolden(path, text, options);
  if (committed === undefined) return;
  const before = new Set(committed.split('\n'));
  const after = new Set(text.split('\n'));
  const lines = [
    ...[...before].filter((line) => !after.has(line)).map((line) => `- ${line}`),
    ...[...after].filter((line) => !before.has(line)).map((line) => `+ ${line}`),
  ];
  const listed = lines.slice(0, LISTED_DIFFERENCES);
  const hidden = lines.length - listed.length;
  throw new TestkitError(
    [
      `${path} differs from the committed golden in ${lines.length} line(s):`,
      ...listed,
      ...(hidden > 0 ? [`… and ${hidden} more`] : []),
      ...(lines.length === 0 ? ['(only line order or repeated lines changed)'] : []),
      `To accept the change intentionally: ${options.refreshCommand}`,
    ].join('\n'),
  );
}

async function mismatchedGolden(path: string, text: string, options: GoldenOptions): Promise<string | undefined> {
  if (process.env[REFRESH_ENV] === options.kind) {
    if (process.env['CI']) throw new TestkitError(`CI only verifies committed goldens; refresh ${path} locally with: ${options.refreshCommand}`);
    await writeAtomically(path, text);
    return undefined;
  }
  let committed: string;
  try {
    committed = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TestkitError(`Missing golden ${path}; create it intentionally with: ${options.refreshCommand}`, { cause: error });
    }
    throw error;
  }
  return committed === text ? undefined : committed;
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function sortKeys(item: unknown): unknown {
  if (!isPlainObject(item)) return item;
  return Object.fromEntries(Object.keys(item).toSorted().map((key) => [key, item[key]]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function show(value: unknown): string {
  if (value === undefined) return '<absent>';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
