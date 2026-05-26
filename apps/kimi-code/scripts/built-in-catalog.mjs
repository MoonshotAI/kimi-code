import { readFileSync } from 'node:fs';

export const BUILT_IN_CATALOG_ENV = 'KIMI_CODE_BUILT_IN_CATALOG_FILE';
export const BUILT_IN_CATALOG_DEFINE = '__KIMI_CODE_BUILT_IN_CATALOG__';

export function builtInCatalogDefine(env = process.env) {
  const file = env[BUILT_IN_CATALOG_ENV];
  if (file === undefined || file.length === 0) return 'undefined';
  return JSON.stringify(readFileSync(file, 'utf-8'));
}
