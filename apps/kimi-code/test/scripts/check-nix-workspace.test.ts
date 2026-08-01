import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const CHECK_SCRIPT = join(REPO_ROOT, 'scripts/check-nix-workspace.mjs');

function writeWorkspacePackage(root: string, path: string, name: string) {
  const packageDir = join(root, path);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify({ name, private: true }, null, 2)}\n`,
  );
}

describe('check-nix-workspace.mjs', () => {
  it('rejects a leaf workspace missing from flake.nix', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'kimi-code-nix-workspace-'));

    try {
      const fixtureScript = join(
        fixtureRoot,
        'scripts/check-nix-workspace.mjs',
      );
      mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
      copyFileSync(CHECK_SCRIPT, fixtureScript);

      writeFileSync(
        join(fixtureRoot, 'pnpm-workspace.yaml'),
        ['packages:', '  - apps/*', '  - packages/*', ''].join('\n'),
      );
      writeWorkspacePackage(
        fixtureRoot,
        'apps/kimi-code',
        '@moonshot-ai/kimi-code',
      );
      writeWorkspacePackage(
        fixtureRoot,
        'packages/leaf-package',
        '@moonshot-ai/leaf-package',
      );
      writeFileSync(
        join(fixtureRoot, 'flake.nix'),
        `{
  workspacePaths = [
    ./apps/kimi-code
  ];
  workspaceNames = [
    "@moonshot-ai/kimi-code"
  ];
}
`,
      );

      const result = spawnSync(process.execPath, [fixtureScript], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('@moonshot-ai/leaf-package');
      expect(result.stderr).toContain('./packages/leaf-package');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
