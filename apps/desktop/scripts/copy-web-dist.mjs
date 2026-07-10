import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopRoot, '../..');
const source = resolve(repoRoot, 'apps/web/dist');
const target = resolve(desktopRoot, 'web-dist');

async function assertBuiltWeb() {
  try {
    const info = await stat(resolve(source, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Web build output was not found at ${source}. Run \`pnpm --filter @moonshot-ai/kimi-web run build\` first.`,
    );
  }
}

await assertBuiltWeb();
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`Copied web assets to ${target}`);
