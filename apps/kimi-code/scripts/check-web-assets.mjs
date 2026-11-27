import { readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, 'web-dist');

async function assertWebAssets() {
  try {
    const info = await stat(resolve(target, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `未找到 web 产物 ${target}/index.html。web-dist 不再入库，由 desktop renderer 的 web 变体构建：` +
        '运行 `pnpm sync:web`（或完整 `pnpm build`，其 prebuild 会自动同步）。详见 apps/kimi-code/AGENTS.md。',
    );
  }
}

await assertWebAssets();
const files = await readdir(target, { recursive: true });
console.log(`Web assets OK: ${target} (${files.length} entries, built from the desktop renderer web variant)`);
