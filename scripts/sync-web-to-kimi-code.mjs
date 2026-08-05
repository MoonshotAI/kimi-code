import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repoRoot, 'apps/web/dist');
// Target kimi-code checkout is REQUIRED via KIMI_CODE_REPO — there is no
// default, so a sync never lands in the wrong clone.
const kimiCodeRepo = process.env.KIMI_CODE_REPO
  ? resolve(process.env.KIMI_CODE_REPO)
  : undefined;

if (kimiCodeRepo === undefined) {
  throw new Error(
    '请设置 KIMI_CODE_REPO 指向你的 kimi-code 仓 checkout，例如：KIMI_CODE_REPO=~/code/kimi-code-5 pnpm sync:web',
  );
}

const appRoot = resolve(kimiCodeRepo, 'apps/kimi-code');
const target = resolve(appRoot, 'dist-web');

async function assertBuiltWeb() {
  try {
    const info = await stat(resolve(source, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `未找到 web 构建产物 ${source}/index.html，请先运行 \`pnpm --filter kimi-code-web run build\`。`,
    );
  }
}

async function assertKimiCodeRepo() {
  try {
    const info = await stat(appRoot);
    if (!info.isDirectory()) {
      throw new Error('apps/kimi-code is not a directory');
    }
  } catch {
    throw new Error(
      `KIMI_CODE_REPO 不像一个 kimi-code 仓 checkout：未找到 ${appRoot}。`,
    );
  }
}

await assertBuiltWeb();
await assertKimiCodeRepo();
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`已同步 web 产物到：${target}`);
console.log('提醒：完成后在 kimi-code 仓提交 dist-web 变更并创建 PR。');
