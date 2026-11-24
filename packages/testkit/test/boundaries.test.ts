import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, it } from 'vitest';

const PACKAGE_ROOT = join(import.meta.dirname, '..');

it('depends on no product package, so every package can use it', async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {}));
  expect(declared.filter((name) => name.startsWith('@moonshot-ai/'))).toEqual([]);
  const offending: string[] = [];
  for (const file of await sourceFiles(join(PACKAGE_ROOT, 'src'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('@moonshot-ai/') || specifier.startsWith('.')) offending.push(`${relative(PACKAGE_ROOT, file)} imports ${specifier}`);
    }
  }
  expect(offending).toEqual([]);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
