// apps/kimi-web/src/lib/mathInline.test.ts
import { describe, expect, it } from 'vitest';
import { mathInline, type MathInlineState } from './mathInline';

interface Seg {
  kind: 'text' | 'math';
  text: string;
  markup?: string;
  loading?: boolean;
}

// Minimal stand-in for markdown-it's inline tokenizer: at each position the
// math rule gets first shot (it sits before `escape` in the real chain);
// `\x` is consumed as two literal chars the way the escape rule would, and
// everything else stays literal text. Real code spans are consumed by
// markdown-it's backticks rule before `$` inside them is ever reached, so
// the harness doesn't need to model them.
function scan(src: string, final = true): Seg[] {
  const segs: Seg[] = [];
  let text = '';
  const pushed: { content: string; markup: string; loading?: boolean }[] = [];
  const state: MathInlineState = {
    src,
    pos: 0,
    env: final ? { __markstreamFinal: true } : {},
    push: () => {
      const token: { content: string; markup: string; loading?: boolean } = {
        content: '',
        markup: '',
      };
      pushed.push(token);
      return token;
    },
  };
  while (state.pos < src.length) {
    const pushedBefore = pushed.length;
    if (mathInline(state, false)) {
      if (text) {
        segs.push({ kind: 'text', text });
        text = '';
      }
      const token = pushed[pushedBefore];
      segs.push({
        kind: 'math',
        text: token?.content ?? '',
        markup: token?.markup ?? '',
        ...(token?.loading ? { loading: true } : {}),
      });
    } else if (src[state.pos] === '\\' && state.pos + 1 < src.length) {
      text += src.slice(state.pos, state.pos + 2);
      state.pos += 2;
    } else {
      text += src[state.pos];
      state.pos += 1;
    }
  }
  if (text) segs.push({ kind: 'text', text });
  return segs;
}

function math(src: string): Seg[] {
  return scan(src).filter((s) => s.kind === 'math');
}

describe('mathInline', () => {
  it('renders $…$ inline formulas', () => {
    expect(math('At time $t$, the matrix $\\Sigma_t$ only uses $\\leq t-1$ of information')).toEqual([
      { kind: 'math', text: 't', markup: '$' },
      { kind: 'math', text: '\\Sigma_t', markup: '$' },
      { kind: 'math', text: '\\leq t-1', markup: '$' },
    ]);
  });

  it('treats CJK characters as word characters for delimiter adjacency', () => {
    expect(math('矩阵 $\\Sigma_t$ 的特征值')).toEqual([
      { kind: 'math', text: '\\Sigma_t', markup: '$' },
    ]);
  });

  it('renders a formula containing brackets and commands', () => {
    expect(math('$\\sum_t [\\log\\det\\Sigma_t + r_t^\\top\\Sigma_t^{-1}r_t]$')).toEqual([
      {
        kind: 'math',
        text: '\\sum_t [\\log\\det\\Sigma_t + r_t^\\top\\Sigma_t^{-1}r_t]',
        markup: '$',
      },
    ]);
  });

  it('keeps prices literal', () => {
    expect(math('sell it for $5 flat')).toEqual([]);
    expect(math('between $5 and $10 dollars')).toEqual([]);
    expect(math('$5 plus $10')).toEqual([]);
    expect(math('$1,000.50 成交')).toEqual([]);
  });

  it('keeps env vars and shell paths literal', () => {
    expect(math('$PATH')).toEqual([]);
    expect(math('echo $HOME/bin and $PATH')).toEqual([]);
  });

  it('keeps bare numbers literal even when closed', () => {
    expect(math('$100$')).toEqual([]);
  });

  it('allows math that starts with a digit', () => {
    expect(math('$3+4=7$')).toEqual([{ kind: 'math', text: '3+4=7', markup: '$' }]);
  });

  it('rejects a closing $ followed by a digit', () => {
    expect(math('$x$2')).toEqual([]);
  });

  it('rejects a closing $ preceded by a space', () => {
    expect(math('$x $ and nothing after')).toEqual([]);
  });

  it('never pairs a literal dollar with a later formula (PR review regression)', () => {
    // A candidate closer that fails the delimiter rules must ABANDON the
    // opener — skipping it would let `$5` consume the closer of `$x$`.
    expect(math('Costs $5 and variable $x$')).toEqual([
      { kind: 'math', text: 'x', markup: '$' },
    ]);
    expect(math('price $5 then $x_1$ and $x_2$')).toEqual([
      { kind: 'math', text: 'x_1', markup: '$' },
      { kind: 'math', text: 'x_2', markup: '$' },
    ]);
    // `$x$2` stays literal (closer followed by a digit) without dragging the
    // later `$y$` down with it.
    expect(math('$x$2 and $y$')).toEqual([{ kind: 'math', text: 'y', markup: '$' }]);
  });

  it('keeps escaped dollars literal', () => {
    expect(math('\\$x$ is not a formula')).toEqual([]);
  });

  it('rejects content containing a backtick', () => {
    expect(math('$a `b` c$')).toEqual([]);
  });

  it('rejects an unclosed $', () => {
    expect(math('formula $x never closes')).toEqual([]);
  });

  it('renders inline $$…$$', () => {
    expect(math('inline $$e^{i\\pi}+1=0$$ done')).toEqual([
      { kind: 'math', text: 'e^{i\\pi}+1=0', markup: '$$' },
    ]);
  });

  it('renders \\(...\\)', () => {
    expect(math('inline \\(\\alpha+\\beta\\) done')).toEqual([
      { kind: 'math', text: '\\alpha+\\beta', markup: '\\(\\)' },
    ]);
  });

  it('does not push a token in silent mode', () => {
    let pushed = 0;
    const state: MathInlineState = {
      src: '$x$',
      pos: 0,
      push: () => {
        pushed++;
        return { content: '', markup: '' };
      },
    };
    expect(mathInline(state, true)).toBe(true);
    expect(pushed).toBe(0);
  });
});

describe('mathInline streaming (unclosed $)', () => {
  function run(src: string, final: boolean) {
    const pushed: { content: string; markup: string; loading?: boolean }[] = [];
    const state: MathInlineState = {
      src,
      pos: 0,
      env: final ? { __markstreamFinal: true } : {},
      push: () => {
        const token: { content: string; markup: string; loading?: boolean } = {
          content: '',
          markup: '',
        };
        pushed.push(token);
        return token;
      },
    };
    const matched = mathInline(state, false);
    return { matched, token: pushed[0], pos: state.pos };
  }

  it('progressively renders partial content with a TeX command', () => {
    const r = run('$\\Sigma_t + r_t', false);
    expect(r.matched).toBe(true);
    expect(r.token).toMatchObject({
      content: '\\Sigma_t + r_t',
      markup: '$',
      loading: true,
    });
    expect(r.pos).toBe('$\\Sigma_t + r_t'.length);
  });

  it('keeps partial content without a TeX signal literal', () => {
    for (const src of ['$5', '$PATH', '$x', '$HOME/bin', '$3+4=7']) {
      expect(run(src, false).matched, src).toBe(false);
    }
  });

  it('stops the partial content at a line break', () => {
    const r = run('$\\Sig\ntrailing prose', false);
    expect(r.matched).toBe(true);
    expect(r.token?.content).toBe('\\Sig');
    expect(r.pos).toBe('$\\Sig'.length);
  });

  it('never renders partial math in settled messages', () => {
    expect(run('$\\Sigma_t', true).matched).toBe(false);
  });
});

// --- Property-based fuzzing -------------------------------------------------
// Not a proof, but the pragmatic equivalent for a scanner this size: pin the
// invariants that define "correct" and hammer them with adversarial inputs.
// The invariant set directly targets the failure class found in PR review
// (a literal `$` pairing with a later formula's closer): invariant (2d)
// forbids math spans from crossing ANY unescaped dollar.

function mulberry32(seed: number): () => number {
  // oxlint-disable-next-line prefer-math-trunc -- uint32 wrap is intentional
  let a = seed >>> 0;
  return () => {
    // oxlint-disable-next-line prefer-math-trunc -- uint32 wrap is intentional
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // oxlint-disable-next-line prefer-math-trunc -- uint32 wrap is intentional
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  '$5', '$x$', '$\\Sigma_t$', '$PATH', '$HOME/bin:$PATH', '$', ' ', '10',
  'and', '\\(a\\)', '$$b$$', '\\$', '`c$d`', '\n', '$x_1$', '$100$',
  '$3+4=7$', ' Costs ', 'vars', '$MY_VAR', '${PATH}', '$x$2',
];
const ALPHABET = '$$$$0125 ,\\abcxyz_^={}()`\n.t';

function genStructured(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 8);
  let s = '';
  for (let i = 0; i < n; i++) s += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)];
  return s;
}

function genNoise(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 60);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return s;
}

/** Rebuild the source from segments — must be perfectly lossless. Loading
    (unclosed) math has no closing delimiter in the source. */
function reconstruct(segs: Seg[]): string {
  return segs
    .map((s) => {
      if (s.kind === 'text') return s.text;
      if (s.loading) return `$${s.text}`;
      if (s.markup === '$$') return `$$${s.text}$$`;
      if (s.markup === '\\(\\)') return `\\(${s.text}\\)`;
      return `$${s.text}$`;
    })
    .join('');
}

function expectInvariants(src: string, final: boolean): void {
  const segs = scan(src, final);
  // (1) Lossless round-trip: tokenization never drops, alters, or reorders
  // a single character.
  expect(reconstruct(segs), `round-trip failed for ${JSON.stringify(src)}`).toBe(src);
  for (const seg of segs) {
    if (seg.kind !== 'math') continue;
    const label = `seg ${JSON.stringify(seg)} in ${JSON.stringify(src)} (final=${final})`;
    // (2a) non-empty content
    expect(seg.text.trim(), label).not.toBe('');
    // (2b) no backtick (code-span crossing)
    expect(seg.text.includes('`'), label).toBe(false);
    if (seg.loading) {
      // (3) loading math only while streaming, and only with a TeX signal
      expect(final, label).toBe(false);
      expect(/\\[a-zA-Z]/.test(seg.text), label).toBe(true);
      continue;
    }
    if (seg.markup !== '$') continue;
    // (2c) delimiter adjacency: content never starts/ends with whitespace
    expect(/^\s|\s$/.test(seg.text), label).toBe(false);
    // (2d) no unescaped `$` — math spans never cross another dollar
    expect(seg.text.replaceAll('\\$', '').includes('$'), label).toBe(false);
    // (2e) bare numbers stay currency
    expect(/^\d[\d,]*(?:\.\d+)?$/.test(seg.text.trim()), label).toBe(false);
  }
}

describe('mathInline fuzz (invariants)', () => {
  const ITERATIONS = 20_000;
  for (const [name, gen] of [
    ['structured', genStructured],
    ['noise', genNoise],
  ] as const) {
    for (const final of [true, false]) {
      it(`holds for ${ITERATIONS} ${name} inputs (final=${final})`, () => {
        const rnd = mulberry32(final ? 0x5eed1 : 0x5eed2);
        for (let i = 0; i < ITERATIONS; i++) expectInvariants(gen(rnd), final);
      });
    }
  }
});
