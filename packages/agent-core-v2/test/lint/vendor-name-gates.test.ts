/**
 * Vendor-name gate probe — outside the kosong layer (`src/kosong/**`, which
 * owns the vendor registries), `src/**` must never branch on the vendor id
 * `'kimi'`. Vendor identity is answered structurally by the kosong
 * provider-definition / adapter registries (`drivesThinkingThroughTraits`,
 * `requiresStrictThinkingValidation`, `isOAuthCatalogVendor` and the
 * `modelSource: 'oauth-catalog'` declaration behind it); a string compare
 * silently re-hardcodes what those registries exist to answer. This probe is
 * zero-tolerance: any new gate fails the build.
 *
 * Full-line comments (`//`, `/* ...`, JSDoc `* ...`) are not code and may
 * quote the legacy v1 gate as parity documentation; they are skipped.
 * Brand/env names (`KIMI_CODE_*`, `KIMI_MODEL_*`) and `'kimi'` as data
 * (config values, telemetry fields, registration ids) do not match the
 * patterns — verified against the whole `src/` tree.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', 'src');

/**
 * Branching on the vendor id: `=== 'kimi'` / `== 'kimi'` / `!== 'kimi'` /
 * `!= 'kimi'` (either operand order) and `case 'kimi':`.
 */
const VENDOR_GATE_RE = /[!=]==?\s*'kimi'|'kimi'\s*[!=]==?|\bcase\s+'kimi'\s*:/;

interface GateHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (relative(SRC_ROOT, abs) === 'kosong') continue;
      out.push(...walk(abs));
    } else if (abs.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** Full-line comments may quote the legacy gate as parity documentation. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function findVendorGates(source: string, file: string): GateHit[] {
  const hits: GateHit[] = [];
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (isCommentLine(line)) continue;
    VENDOR_GATE_RE.lastIndex = 0;
    if (VENDOR_GATE_RE.test(line)) {
      hits.push({ file, line: index + 1, text: line.trim() });
    }
  }
  return hits;
}

describe('vendor-name gates', () => {
  it('flags vendor compares and switch cases in code', () => {
    const hits = findVendorGates(
      [
        `if (provider.type === 'kimi') return;`,
        `if (provider?.type !== 'kimi' || provider.oauth === undefined) return;`,
        `const managed = 'kimi' === vendor;`,
        `switch (type) { case 'kimi': break; }`,
        `if (type == 'kimi') return;`,
      ].join('\n'),
      'fixture.ts',
    );
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ignores comments, brand/env names, and kimi as data', () => {
    const hits = findVendorGates(
      [
        '// v1 `provider.type === \'kimi\'` gate restored.',
        ' * `provider.type === \'kimi\'` parity): strict validation',
        '/* legacy: provider.type === \'kimi\' */',
        'const home = process.env.KIMI_CODE_HOME;',
        `const event = { provider_type: 'kimi' };`,
        `const provider = { type: 'kimi', oauth };`,
        `registerProviderDefinition({ id: 'kimi', ...rest });`,
      ].join('\n'),
      'fixture.ts',
    );
    expect(hits).toEqual([]);
  });

  it('finds no vendor-name gates in src/ outside kosong', () => {
    const hits = walk(SRC_ROOT).flatMap((file) =>
      findVendorGates(readFileSync(file, 'utf8'), relative(SRC_ROOT, file)),
    );
    expect(
      hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`),
      'vendor-name gate found outside kosong — ask the provider-definition / adapter registries instead',
    ).toEqual([]);
  });
});
