import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { escapeNonAscii, firstNonAscii } from '../../scripts/ascii-bundle.mjs';

const c = (code: number): string => String.fromCodePoint(code);
const CJK = c(0x4efb) + c(0x52a1); // 任务
const EMOJI = c(0x1f313); // 🌓 (astral: two UTF-16 code units)
const E_ACUTE = c(0xe9);
const LS = c(0x2028);
const NBSP = c(0xa0);

function isAscii(text: string): boolean {
  return firstNonAscii(text) === undefined;
}

function evaluate(source: string): unknown {
  return runInNewContext(`${source}\n__result`, {});
}

describe('escapeNonAscii', () => {
  it('leaves an all-ASCII source byte-identical', () => {
    const source = 'const a = "plain";\nconst __result = a + `tmpl ${a}`;\n';
    const { text, counts } = escapeNonAscii(source, { sourceType: 'script' });
    expect(text).toBe(source);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('escapes string, template and regex literals without changing their values', () => {
    const source = [
      `const s = '${CJK}${EMOJI}${E_ACUTE}';`,
      `const d = "${CJK}";`,
      'const n = 1;',
      `const t = \`x${CJK}\${n}${EMOJI}\`;`,
      `const r1 = /[${E_ACUTE}-${c(0xfc)}]${CJK}/;`,
      `const r2 = /^(${CJK}|loading)(${c(0x2026)}|\\.\\.\\.)?$/iu;`,
      `const r3 = /${EMOJI}/u;`,
      // `.source` legitimately changes (it mirrors the literal's text); the
      // matching behaviour, the flags and a regex rebuilt from `.source` must not.
      'const probe = (r, input) => [r.flags, r.test(input), new RegExp(r.source, r.flags).test(input)];',
      'const __result = { s, d, t, r1: probe(r1, "' + E_ACUTE + CJK + '"), r1miss: probe(r1, "x"),',
      '  r2: probe(r2, "' + CJK + c(0x2026) + '"), r3: probe(r3, "' + EMOJI + '"), r3miss: probe(r3, "x") };',
    ].join('\n');
    const { text, counts } = escapeNonAscii(source, { sourceType: 'script' });
    expect(isAscii(text)).toBe(true);
    expect(text.split('\n').length).toBe(source.split('\n').length);
    expect(counts.string).toBeGreaterThan(0);
    expect(counts.template).toBeGreaterThan(0);
    expect(counts.regexp).toBeGreaterThan(0);
    expect(evaluate(text)).toEqual(evaluate(source));
  });

  it('escapes identifiers used as object keys and property names', () => {
    const source = `const map = { ${c(0xc6)}: "Ae", ${c(0x110)}: "D" };\nconst __result = [Object.keys(map), map.${c(0xc6)}];`;
    const { text, counts } = escapeNonAscii(source, { sourceType: 'script' });
    expect(isAscii(text)).toBe(true);
    expect(counts.identifier).toBe(3);
    expect(evaluate(text)).toEqual(evaluate(source));
  });

  it('escapes comments and keeps line structure', () => {
    const source = `// note ${CJK}\n/* block ${EMOJI}\n second line ${E_ACUTE} */\nconst __result = 1; // trailing ${CJK}\n`;
    const { text, counts } = escapeNonAscii(source, { sourceType: 'script' });
    expect(isAscii(text)).toBe(true);
    // 任务 (2) + 🌓 (2 code units) + é (1) + 任务 (2)
    expect(counts.comment).toBe(7);
    expect(text.split('\n').length).toBe(source.split('\n').length);
    expect(text).toContain('//#region'.slice(0, 2));
    expect(evaluate(text)).toBe(1);
  });

  it('keeps region markers intact', () => {
    const source = `//#region src/${CJK}.ts\nconst __result = "${CJK}";\n//#endregion\n`;
    const { text } = escapeNonAscii(source, { sourceType: 'script' });
    expect(text.startsWith('//#region src/\\u4efb\\u52a1.ts\n')).toBe(true);
    expect(text).toContain('\n//#endregion\n');
  });

  it('replaces unicode whitespace and line separators outside literals', () => {
    const source = `const a${NBSP}= 1;${LS}const __result = a + 1;\n`;
    const { text, counts } = escapeNonAscii(source, { sourceType: 'script' });
    expect(isAscii(text)).toBe(true);
    expect(text).toBe('const a = 1;\nconst __result = a + 1;\n');
    expect(counts.whitespace).toBe(2);
    expect(evaluate(text)).toBe(2);
  });

  it('drops a redundant backslash before a non-ASCII character in a string', () => {
    const source = `const __result = "\\${E_ACUTE}${CJK}";`;
    const { text } = escapeNonAscii(source, { sourceType: 'script' });
    expect(isAscii(text)).toBe(true);
    expect(evaluate(text)).toBe(evaluate(source));
  });

  it('leaves tagged templates alone and rejects non-ASCII inside them', () => {
    const ascii = 'const raw = String.raw`a\\n${1}b`;\nconst __result = raw;';
    expect(escapeNonAscii(ascii, { sourceType: 'script' }).text).toBe(ascii);
    const tagged = `const __result = String.raw\`${CJK}\`;`;
    expect(() => escapeNonAscii(tagged, { sourceType: 'script' })).toThrow(/tagged template/);
  });

  it('rejects line separators inside string literals instead of shifting line numbers', () => {
    const source = `const __result = "a${LS}b";`;
    expect(() => escapeNonAscii(source, { sourceType: 'script' })).toThrow(/U\+2028/);
  });

  it('parses ES modules with top-level await and a shebang', () => {
    const source = `#!/usr/bin/env node\nimport { x } from 'node:fs';\nawait Promise.resolve();\nexport const y = "${CJK}";\n`;
    const { text } = escapeNonAscii(source, { sourceType: 'module' });
    expect(isAscii(text)).toBe(true);
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});

describe('firstNonAscii', () => {
  it('reports the first offending code unit with its line and column', () => {
    expect(firstNonAscii('abc')).toBeUndefined();
    expect(firstNonAscii(`ab\ncd${CJK}`)).toEqual({ index: 5, line: 2, column: 3, codeUnit: 0x4efb });
  });
});
