import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  scripts?: Record<string, string>;
};

const bundledDependencies = [
  '@earendil-works/pi-tui',
  'chalk',
  'cli-highlight',
  'commander',
  'pathe',
  'semver',
  'smol-toml',
  'zod',
];

describe('npm package manifest', () => {
  it('keeps bundled runtime dependencies out of the published dependencies list', () => {
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.publishConfig).not.toHaveProperty('directory');
    expect(packageJson.scripts).not.toHaveProperty('prepublishOnly');
    expect(packageJson.scripts).not.toHaveProperty('build:npm-package');

    for (const dependency of bundledDependencies) {
      expect(packageJson.devDependencies).toHaveProperty(dependency);
    }
  });

  it('keeps native support packages optional', () => {
    expect(packageJson.optionalDependencies).toEqual({
      '@mariozechner/clipboard': '^0.3.2',
      koffi: '^2.16.0',
    });
  });
});
