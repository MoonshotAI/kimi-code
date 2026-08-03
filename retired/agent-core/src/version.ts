import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function getCoreVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
