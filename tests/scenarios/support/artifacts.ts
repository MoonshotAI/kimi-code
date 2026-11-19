import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function firstDifference(expected: Json | undefined, actual: Json | undefined, path: string): string | undefined {
  if (expected === actual) return;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && Array.isArray(expected) === Array.isArray(actual)) {
    const left = expected as Record<string, Json>;
    const right = actual as Record<string, Json>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const diff = firstDifference(left[key], right[key], path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'));
      if (diff) return diff;
    }
    return;
  }
  const show = (v: Json | undefined) => v === undefined ? '<absent>' : JSON.stringify(v).slice(0, 180);
  return `${path || '/'}: expected ${show(expected)}, received ${show(actual)}`;
}

export async function checkArtifact(target: URL, value: unknown, kind: 'replay' | 'schema'): Promise<void> {
  const path = fileURLToPath(target);
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).toSorted().map(key => [key, (item as Record<string, unknown>)[key]]));
  }, 2) + '\n';
  if (process.env['KIMI_TEST_REFRESH'] === kind) {
    if (process.env['CI']) throw new Error('CI only verifies committed fixtures');
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, text, { flag: 'wx' });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    return;
  }
  const expected = await readFile(path, 'utf8');
  const diff = firstDifference(JSON.parse(expected), JSON.parse(text), '');
  if (diff) throw new Error(`${path}: ${diff}\nTo regenerate intentionally: pnpm qa:refresh ${kind}`);
}
