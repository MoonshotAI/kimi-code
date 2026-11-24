import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, it } from 'vitest';

const ROOT = import.meta.dirname;
const ALLOWED = [/^vitest$/, /^node:/, /^@moonshot-ai\/testkit\/(model|kap|fixtures|vitest)$/, /^@moonshot-ai\/kap-server$/, /^\.\/support\/[\w-]+$/];

it('drives the product only through the KAP server entry and the testkit', async () => {
  const offending: string[] = [];
  for (const file of await sourceFiles(ROOT)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      if (!ALLOWED.some((pattern) => pattern.test(specifier))) offending.push(`${relative(ROOT, file)} imports ${specifier}`);
    }
  }
  expect(offending).toEqual([]);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts') && entry.name !== 'vitest.config.ts') files.push(path);
  }
  return files;
}
