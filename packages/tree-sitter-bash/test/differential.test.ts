// test/differential.test.ts
//
// Differential suite: every sample in test/fixtures/differential/ and every
// official tree-sitter-bash 0.25.0 corpus case in test/fixtures/corpus/ is
// parsed by BOTH this package and the reference (web-tree-sitter + the
// official wasm build) and the normalized trees are compared byte-for-byte.
//
//   - @match samples must produce a tree identical to the reference;
//   - @known-diff samples must (a) still differ from the reference and
//     (b) match the stored dump of our parser exactly — so a documented
//     deviation cannot silently drift, and a fixed deviation fails loudly
//     ("remove it from the known list").
//
// The known-difference registry (test/helpers/known-differences.ts) is the
// single source of truth and is cross-checked against README.md's Known
// differences section here.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { compareSource, diffDumps, ourDump, parseCorpusFile, parseFixtureFile, referenceDump } from './helpers/differential';
import type { FixtureSample } from './helpers/differential';
import { KNOWN_DIFFERENCES, isKnownDifferenceId } from './helpers/known-differences';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const DIFF_DIR = path.join(PKG_ROOT, 'test/fixtures/differential');
const CORPUS_DIR = path.join(PKG_ROOT, 'test/fixtures/corpus');

interface LocatedSample extends FixtureSample {
  file: string;
}

function loadDifferentialFixtures(): LocatedSample[] {
  const out: LocatedSample[] = [];
  for (const file of readdirSync(DIFF_DIR).filter((f) => f.endsWith('.txt')).toSorted()) {
    const content = readFileSync(path.join(DIFF_DIR, file), 'utf8');
    for (const sample of parseFixtureFile(`${DIFF_DIR}/${file}`, content)) {
      out.push({ ...sample, file });
    }
  }
  return out;
}

function loadCorpusKnownDiffs(): Map<string, LocatedSample> {
  const file = 'known-diffs.txt';
  const content = readFileSync(path.join(CORPUS_DIR, file), 'utf8');
  const map = new Map<string, LocatedSample>();
  for (const sample of parseFixtureFile(`${CORPUS_DIR}/${file}`, content)) {
    // description: "corpus <file>::<case name>"
    const key = sample.description.replace(/^corpus /, '');
    map.set(key, { ...sample, file });
  }
  return map;
}

function label(sample: LocatedSample): string {
  return `${sample.file}:${sample.line} ${sample.kind === 'match' ? 'match' : `known-diff ${sample.id}`} — ${sample.description.slice(0, 60)}`;
}

const fixtures = loadDifferentialFixtures();
const corpusKnownDiffs = loadCorpusKnownDiffs();
const corpusCases = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.txt') && f !== 'known-diffs.txt')
  .toSorted()
  .flatMap((file) => parseCorpusFile(readFileSync(path.join(CORPUS_DIR, file), 'utf8')).map((c) => ({ ...c, file })));

beforeAll(async () => {
  // Fails with a descriptive error when the wasm reference cannot be loaded.
  await compareSource('echo sanity');
});

describe('differential fixtures', () => {
  for (const sample of fixtures) registerFixtureTest(sample);
});

/** Register one fixture test (lookup table instead of conditionals — the
 *  vitest lint rules reject conditionals around `it`). */
function registerFixtureTest(sample: LocatedSample): void {
  const register: Record<FixtureSample['kind'], () => void> = {
    match: () => {
      it(label(sample), async () => {
        const cmp = await compareSource(sample.source);
        expect(cmp.diff).toBe('');
      });
    },
    'known-diff': () => {
      it(label(sample), async () => {
        const [ours, reference] = [ourDump(sample.source), await referenceDump(sample.source)];
        expect(
          ours !== reference,
          'this sample now matches the reference — remove it from the known-difference list (fixture + registry + README)',
        ).toBe(true);
        expect(ours === sample.expectedOurs, `deviation shape drifted:\n${diffDumps(ours, sample.expectedOurs!)}`).toBe(
          true,
        );
      });
    },
  };
  register[sample.kind]();
}

describe('official tree-sitter-bash 0.25.0 corpus', () => {
  for (const corpusCase of corpusCases) registerCorpusTest(corpusCase);
});

/** Register one corpus case test. */
function registerCorpusTest(corpusCase: { file: string; name: string; input: string }): void {
  const key = `${corpusCase.file}::${corpusCase.name}`;
  const known = corpusKnownDiffs.get(key) ?? null;
  const register: Record<'match' | 'known-diff', () => void> = {
    match: () => {
      it(`${key} (match)`, async () => {
        const cmp = await compareSource(corpusCase.input);
        expect(cmp.diff).toBe('');
      });
    },
    'known-diff': () => {
      it(`${key} (known-diff ${known!.id})`, async () => {
        const [ours, reference] = [ourDump(corpusCase.input), await referenceDump(corpusCase.input)];
        expect(
          ours !== reference,
          'this corpus case now matches the reference — remove it from known-diffs.txt, the registry and the README',
        ).toBe(true);
        expect(ours === known!.expectedOurs, `deviation shape drifted:\n${diffDumps(ours, known!.expectedOurs!)}`).toBe(
          true,
        );
      });
    },
  };
  register[known === null ? 'match' : 'known-diff']();
}

describe('known-difference registry consistency', () => {
  const usedIds = new Set<string>();
  for (const sample of fixtures) {
    if (sample.id !== undefined) usedIds.add(sample.id);
  }
  for (const sample of corpusKnownDiffs.values()) {
    if (sample.id !== undefined) usedIds.add(sample.id);
  }

  it('every @known-diff id used in fixtures exists in the registry', () => {
    for (const id of usedIds) {
      expect(isKnownDifferenceId(id), `fixture uses unregistered id '${id}'`).toBe(true);
    }
  });

  it('every registry id is exercised by at least one fixture or corpus case', () => {
    for (const entry of KNOWN_DIFFERENCES) {
      expect(usedIds.has(entry.id), `registry id '${entry.id}' has no fixture sample`).toBe(true);
    }
  });

  it('every registry entry is anchored in README.md Known differences', () => {
    const readme = readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');
    const sectionMatch = /## Known differences[^\n]*\n([\s\S]*?)(?=\n## |\s*$)/.exec(readme);
    expect(sectionMatch, 'README.md has no "## Known differences" section').not.toBeNull();
    // Whitespace-normalized so anchors may span line breaks in the README.
    const section = sectionMatch![1]!.replaceAll(/\s+/g, ' ');
    for (const entry of KNOWN_DIFFERENCES) {
      expect(
        section.includes(entry.readmeAnchor.replaceAll(/\s+/g, ' ')),
        `README.md Known differences does not contain the anchor for '${entry.id}': ${entry.readmeAnchor}`,
      ).toBe(true);
    }
  });
});
