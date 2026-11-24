import { readFileSync } from 'node:fs';

const manifestPath = 'apps/kimi-code/package.json';

export function lintCliDependencies(manifest) {
  const packages = Object.keys(manifest.dependencies ?? {});
  if (packages.length === 0) return null;
  return `${manifestPath}: dependencies must be empty. Move ${packages.join(', ')} to devDependencies so the CLI bundles them.`;
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(new URL(`../../${manifestPath}`, import.meta.url), 'utf8'));
  const error = lintCliDependencies(manifest);
  if (error !== null) {
    console.error(error);
    process.exitCode = 1;
  }
}
