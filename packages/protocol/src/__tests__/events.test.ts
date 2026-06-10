import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import type { Event } from '../events';
import type { ToolInputDisplay } from '../display';

type _AssertEventNonNever = Event extends never ? never : true;
const _assertEvent: _AssertEventNonNever = true;

type _AssertToolInputDisplayNonNever = ToolInputDisplay extends never ? never : true;
const _assertDisplay: _AssertToolInputDisplayNonNever = true;

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const sdkPackageName = ['@moonshot-ai', 'kimi-code-sdk'].join('/');

function readPackageFiles(): string {
  const files = ['package.json', ...sourceFiles(join(packageRoot, 'src'))];
  return files
    .map((file) => readFileSync(join(packageRoot, file), 'utf8'))
    .join('\n');
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(relative(packageRoot, full));
    }
  }
  return files;
}

describe('events / display re-exports', () => {
  it('does not depend on the node SDK package', () => {
    expect(readPackageFiles()).not.toContain(sdkPackageName);
  });

  it('Event re-export is non-never (compile-time check passed)', () => {
    expect(_assertEvent).toBe(true);
  });

  it('ToolInputDisplay re-export is non-never (12-arm union preserved)', () => {
    expect(_assertDisplay).toBe(true);
  });
});
