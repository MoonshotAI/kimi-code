import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const CANDIDATES = [
  fileURLToPath(new URL('../../kimi-code/package.json', import.meta.url)),
  join(process.cwd(), '../kimi-code/package.json'),
  join(process.cwd(), 'apps/kimi-code/package.json'),
];

const pkgPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (pkgPath === undefined) {
  throw new Error(`kimi-code CLI package.json not found; tried:\n${CANDIDATES.join('\n')}`);
}

export const KIMI_CORE_VERSION = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
