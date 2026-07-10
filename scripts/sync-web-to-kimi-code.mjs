import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repoRoot, 'apps/web/dist');
// Dev default: sibling checkout `../kimi-code-2` (the kimi-code repo where the
// split branch lives). Override with KIMI_CODE_REPO to point at any checkout.
const kimiCodeRepo = process.env.KIMI_CODE_REPO
  ? resolve(process.env.KIMI_CODE_REPO)
  : resolve(repoRoot, '..', 'kimi-code-2');
const target = resolve(kimiCodeRepo, 'apps/kimi-code/dist-web');

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

console.log(`Synced web assets to kimi-code SEA bundle: ${target}`);
console.log('Next: commit the dist-web snapshot inside the kimi-code repo and open a PR.');
