import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

const NAMED_COLORS = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  'white', 'gray', 'grey', 'black',
  'blackBright', 'whiteBright', 'redBright', 'greenBright',
  'yellowBright', 'blueBright', 'magentaBright', 'cyanBright',
];

const CHALK_NAMED_PATTERN = new RegExp(
  `chalk\\.(${NAMED_COLORS.join('|')})\\(`,
);

function walk(dir: string, files: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p, files);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
        files.push(p);
      }
    }
  } catch { /* skip */ }
  return files;
}

describe('chalk named color guard', () => {
  it('forbids chalk named colors in production source code', () => {
    const offenders: { file: string; line: number; snippet: string }[] = [];
    const files = walk(SRC_ROOT);
    let inBlockComment = false;
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const trimmed = line.trimStart();

        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          continue;
        }

        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlockComment = true;
          continue;
        }

        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

        CHALK_NAMED_PATTERN.lastIndex = 0;
        const m = CHALK_NAMED_PATTERN.exec(line);
        if (m) {
          offenders.push({
            file: relative(SRC_ROOT, file),
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }
    expect(
      offenders,
      `Found chalk named color usages. Use chalk.hex(colors.<token>) or theme styles instead.\n` +
        offenders.map((o) => `  ${o.file}:${String(o.line)}  ${o.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
