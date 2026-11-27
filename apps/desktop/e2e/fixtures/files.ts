import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Locator } from '@playwright/test';

import { expect, test as base } from './app';

const GIT_IDENTITY = ['-c', 'user.name=Kimi E2E', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

export const test = base.extend<{ repoFiles: Record<string, string | Buffer> | null }>({
  repoFiles: [null, { option: true }],
  scratch: async ({ scratch, repoFiles }, use) => {
    if (repoFiles !== null) {
      const workspace = join(scratch, 'workspace');
      mkdirSync(workspace, { recursive: true });
      git(workspace, 'init', '-q', '-b', 'main');
      writeTree(workspace, repoFiles);
      git(workspace, 'add', '-A');
      git(workspace, 'commit', '-q', '-m', 'initial');
    }
    await use(scratch);
  },
});

export { expect };

export interface DiffRow {
  readonly kind: string;
  readonly text: string;
}

export async function diffRows(scope: Locator): Promise<DiffRow[]> {
  return scope.locator('.hl-row').evaluateAll(rows => rows.map(row => ({
    kind: [...row.classList].find(name => name.startsWith('row-'))?.slice(4) ?? 'plain',
    text: row.querySelector('.hl-text')?.textContent ?? '',
  })));
}

export const changedRows = (rows: readonly DiffRow[]): string[] =>
  rows.filter(row => row.kind === 'add' || row.kind === 'del').map(row => `${row.kind === 'add' ? '+' : '-'}${row.text}`);
