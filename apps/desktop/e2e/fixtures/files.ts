import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import type { Locator } from '@playwright/test';

import { expect, test as base, type DesktopApp } from './app';

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

export function solidPng(width: number, height: number): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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

export async function chooseTabMenuItem(app: DesktopApp, tab: Locator, item: string): Promise<void> {
  await tab.click({ button: 'right' });
  const overlay = await app.overlay();
  const entry = overlay.getByRole('menuitem', { name: item });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(entry).toBeHidden();
}

