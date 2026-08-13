import { describe, expect, it } from 'vitest';
import { createInlineMathMatcher, matchInlineMath, mathInlineRule } from './inlineMath';

// Simulate the markdown-it inline tokenizer: code spans are consumed
// atomically; the math rule is tried at every remaining `$` position.
function extractMath(text: string): string[] {
  const spans: string[] = [];
  let pos = 0;
  let lastEnd = -1;
  while (pos < text.length) {
    if (text[pos] === '`' && !isEscaped(text, pos)) {
      const end = codeSpanEnd(text, pos);
      // A run without a closer is literal text — never retried from inside.
      pos = end ?? runEnd(text, pos);
      continue;
    }
    if (text[pos] === '$') {
      const match = matchInlineMath(text, pos, lastEnd);
      if (match) {
        spans.push(match.content);
        pos = match.end;
        lastEnd = match.end;
        continue;
      }
    }
    pos++;
  }
  return spans;
}

/** Whether the character at `pos` is backslash-escaped (odd run). */
function isEscaped(text: string, pos: number): boolean {
  let backslashes = 0;
  let i = pos - 1;
  while (i >= 0 && text[i] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

/** Index past the backtick run starting at `pos`. */
function runEnd(text: string, pos: number): number {
  let end = pos;
  while (text[end] === '`') end++;
  return end;
}

/** Index past the run matching the backtick run at `pos`, or null if unclosed. */
function codeSpanEnd(text: string, pos: number): number | null {
  let openEnd = pos;
  while (text[openEnd] === '`') openEnd++;
  const runLength = openEnd - pos;
  let j = openEnd;
  while (j < text.length) {
    if (text[j] !== '`') {
      j++;
      continue;
    }
    let closeEnd = j;
    while (text[closeEnd] === '`') closeEnd++;
    if (closeEnd - j === runLength) return closeEnd;
    j = closeEnd;
  }
  return null;
}

describe('matchInlineMath', () => {
  it('renders real math', () => {
    expect(extractMath('$x$')).toEqual(['x']);
    expect(extractMath('$E=mc^2$')).toEqual(['E=mc^2']);
    expect(extractMath('$\\frac{a}{b}$')).toEqual(['\\frac{a}{b}']);
    expect(extractMath('$x^2$ 和 $y$')).toEqual(['x^2', 'y']);
  });

  it('renders bare-number math (common in model output)', () => {
    expect(extractMath('答案是 $42$')).toEqual(['42']);
    expect(extractMath('约为 $3.14$')).toEqual(['3.14']);
  });

  it('keeps lone currency amounts literal', () => {
    expect(extractMath('$100')).toEqual([]);
    expect(extractMath('价格是 $100，谢谢')).toEqual([]);
  });

  it('keeps currency pairs literal', () => {
    expect(extractMath('$100 和 $200')).toEqual([]);
    expect(extractMath('$10, $20')).toEqual([]);
    expect(extractMath('价格是 $5; $10; $15')).toEqual([]);
    expect(extractMath('$5,000 and $10,000')).toEqual([]);
  });

  it('keeps currency ranges literal (closing dollar followed by a digit)', () => {
    expect(extractMath('$10-$20')).toEqual([]);
    expect(extractMath('$10,$20')).toEqual([]);
    expect(extractMath('$10~$20')).toEqual([]);
    expect(extractMath('$100$200')).toEqual([]);
  });

  it('keeps trailing-$ currency ranges literal (100$-200$)', () => {
    expect(extractMath('100$-200$')).toEqual([]);
    expect(extractMath('100$、200$')).toEqual([]);
    expect(extractMath('价格为100$至200$')).toEqual([]);
    expect(extractMath('ranges from 100$ to 200$')).toEqual([]);
  });

  it('keeps trailing-$ currency literal — connector and context variants', () => {
    expect(extractMath('100$到200$')).toEqual([]);
    expect(extractMath('100$~200$')).toEqual([]);
    expect(extractMath('100$，200$')).toEqual([]);
    expect(extractMath('US$100$-200$')).toEqual([]);
    expect(extractMath('100$ bill and $x$')).toEqual(['x']);
    expect(extractMath('100$ 和 $x$ 的区别')).toEqual(['x']);
  });

  it('keeps trailing-$ currency literal for astral digits', () => {
    expect(extractMath('𝟙$-𝟚$')).toEqual([]);
    expect(extractMath('𝟙$、𝟚$')).toEqual([]);
    expect(extractMath('𝟙$至𝟚$')).toEqual([]);
  });

  it('keeps trailing-$ currency literal with space-grouped thousands', () => {
    expect(extractMath('100$–1 200$')).toEqual([]);
    expect(extractMath('100$–1 200$')).toEqual([]);
    expect(extractMath('100$–1 200$')).toEqual([]);
    expect(extractMath('100$、1 200$')).toEqual([]);
  });

  it('does not backtrack on long space-grouped digit runs', () => {
    const text = `1$${'1 '.repeat(30)}!$`;
    expect(extractMath(text)).toEqual([`${'1 '.repeat(30)}!`]);
  });

  it('keeps trailing-$ currency literal with slash connectors', () => {
    expect(extractMath('100$/200$')).toEqual([]);
    expect(extractMath('100$／200$')).toEqual([]);
    expect(extractMath('价格 100$/200$ 均可')).toEqual([]);
  });

  it('keeps trailing-$ prices with multi-word pricing notes literal', () => {
    expect(extractMath('100$per adult,50$per child')).toEqual([]);
    expect(extractMath('100$每位成人，50$每位儿童')).toEqual([]);
    expect(extractMath('100$per adult, 50$per child, free for infants')).toEqual([]);
  });

  it('keeps trailing-$ ranges with apostrophe grouping literal', () => {
    expect(extractMath("1'000$–2'000$")).toEqual([]);
    expect(extractMath('1’000$–2’000$')).toEqual([]);
    expect(extractMath("价格 1'000$–2'000$ 之间")).toEqual([]);
  });

  it('keeps trailing-$ currency literal with units and conjunctions', () => {
    expect(extractMath('套餐100$/月、200$/月')).toEqual([]);
    expect(extractMath('100$/件，200$/台')).toEqual([]);
    expect(extractMath('100$/kg and 200$/kg')).toEqual([]);
    expect(extractMath('每千克 $x$ 克')).toEqual(['x']);
  });

  it('keeps spaceless label+amount trailing-$ price lists literal', () => {
    expect(extractMath('成人票100$，儿童票50$')).toEqual([]);
    expect(extractMath('大杯100$、中杯80$')).toEqual([]);
    expect(extractMath('adult 100$, child 50$')).toEqual([]);
  });

  it('keeps multi-word label trailing-$ price lists literal', () => {
    expect(extractMath('small coffee 5$, large coffee 10$')).toEqual([]);
    expect(extractMath('Plan A 5$, Plan B 10$')).toEqual([]);
    expect(extractMath('小杯 咖啡 30$，大杯 咖啡 50$')).toEqual([]);
  });

  it('keeps trailing-$ currency literal with parenthesized notes', () => {
    expect(extractMath('100$（基础版），200$（专业版）')).toEqual([]);
    expect(extractMath('100$（大杯）、200$（特大杯）')).toEqual([]);
    expect(extractMath('100（$x$）')).toEqual(['x']);
  });

  it('keeps compact trailing-$ currency arithmetic literal', () => {
    expect(extractMath('100$*2=200$')).toEqual([]);
    expect(extractMath('5$+10$=15$')).toEqual([]);
    expect(extractMath('100$×2=200$')).toEqual([]);
    expect(extractMath('100$*2=200$ 所以 $x$ 成立')).toEqual(['x']);
  });

  it('keeps composite currency amounts literal (HK$, US$, S$…)', () => {
    expect(extractMath('票价 HK$80 和 HK$120')).toEqual([]);
    expect(extractMath('The fare is HK$80 or US$12.')).toEqual([]);
    expect(extractMath('S$12.50 vs NZ$15.00, please.')).toEqual([]);
  });

  it('vetoes composite-currency symbol listings (letter-preceded opener)', () => {
    expect(extractMath('支持 HK$、US$、A$ 等币种结算')).toEqual([]);
    expect(extractMath('HK$100、US$ 均可使用')).toEqual([]);
    expect(extractMath('Accept HK$, US$, or S$ at checkout')).toEqual([]);
  });

  it('vetoes standalone single-letter currency symbol listings', () => {
    expect(extractMath('Accept S$, S$, or S$')).toEqual([]);
    expect(extractMath('支持 A$、A$')).toEqual([]);
    expect(extractMath('Pay with R$; refunds are in R$')).toEqual([]);
    // …while a lone uppercase variable glued to a formula stays math.
    expect(extractMath('矩阵 A$x$ 是所求')).toEqual(['x']);
    expect(extractMath('Let X$x$ hold')).toEqual(['x']);
  });

  it('renders math glued to lowercase or mixed-case words', () => {
    expect(extractMath('Euler$e^{i\\pi}$ 是欧拉公式')).toEqual(['e^{i\\pi}']);
    expect(extractMath('variable$x$ is math')).toEqual(['x']);
    expect(extractMath('函数f$x$ 紧贴小写单词也渲染')).toEqual(['x']);
  });

  it('renders math glued to uppercase variables', () => {
    expect(extractMath('矩阵 A$x$ 是所求')).toEqual(['x']);
    expect(extractMath('Let X$x$ be the product')).toEqual(['x']);
    expect(extractMath('S$100 和 ZZ$50')).toEqual([]);
    expect(extractMath('价格 S$100 或 A$50')).toEqual([]);
  });

  it('vetoes ISO and composite currency codes in symbol listings', () => {
    expect(extractMath('Accept CHF$, AED$, or PHP$ at checkout')).toEqual([]);
    expect(extractMath('CAD$, AUD$, and USD$')).toEqual([]);
    expect(extractMath('接受 JPY$、EUR$ 或 GBP$ 付款')).toEqual([]);
    expect(extractMath('支持 HK$、US$、A$ 等币种结算')).toEqual([]);
  });

  it('confirms a following word-glued formula for the currency veto', () => {
    expect(extractMath('单价 $100，函数 f$x$ 成立')).toEqual(['x']);
    expect(extractMath('It costs $100, and Euler$e^{i\\pi}$ works')).toEqual(['e^{i\\pi}']);
  });

  it('confirms formulas starting with operator or grouping characters', () => {
    expect(extractMath('It costs $100 ($|x|$ each)')).toEqual(['|x|']);
    expect(extractMath('It costs $100 ($-x$ each)')).toEqual(['-x']);
    expect(extractMath('It costs $100 ($+x$ each)')).toEqual(['+x']);
    expect(extractMath('价格 $100（${x}$ 每个）')).toEqual(['{x}']);
    expect(extractMath('价格 $100（$[a]$ 每组）')).toEqual(['[a]']);
    expect(extractMath('价格 $100（$.5$ 折扣）')).toEqual(['.5']);
    expect(extractMath('价格 $100（$𝟙$ 个）')).toEqual(['𝟙']);
  });

  it('confirms operator/grouping starts — bilingual variants', () => {
    expect(extractMath('价格 $100（每个 $+x$）')).toEqual(['+x']);
    expect(extractMath('价格 $100（每个 $-x$）')).toEqual(['-x']);
    expect(extractMath('It costs $50 ($|a|$ or $|b$)')).toEqual(['|a|', '|b']);
    expect(extractMath('答案是 $+1$ 或 $-1$。')).toEqual(['+1', '-1']);
    expect(extractMath('设 $+y$ 为正方向')).toEqual(['+y']);
  });

  it('still allows math attached to CJK characters and punctuation', () => {
    expect(extractMath('公式$f(x)$ 成立')).toEqual(['f(x)']);
    expect(extractMath('代入$x=1$ 得$y=2$。')).toEqual(['x=1', 'y=2']);
    expect(extractMath('见 ($x$) 和“$y$”。')).toEqual(['x', 'y']);
  });

  it('applies the currency guard to Unicode digits and spaces', () => {
    const nbsp = ' ';
    expect(extractMath('价格区间 $１０-$２０')).toEqual([]);
    expect(extractMath(`$${nbsp}10 和 $${nbsp}20`)).toEqual([]);
    expect(extractMath(`$10${nbsp}$20`)).toEqual([]);
  });

  it('covers more Unicode space and digit categories', () => {
    expect(extractMath('￥是 $　10 和 $　20')).toEqual([]);
    expect(extractMath('Prix : $ 10–$ 20')).toEqual([]);
    expect(extractMath('النطاق $١٠-$٢٠')).toEqual([]);
    expect(extractMath('القيمة $١٠٠$ هنا')).toEqual(['١٠٠']);
  });

  it('handles UTF-16 surrogate pairs around and inside math', () => {
    expect(extractMath('🎉$x$')).toEqual(['x']);
    expect(extractMath('结果是 $x$🎉 庆祝')).toEqual(['x']);
    expect(extractMath('𠀀 $x$ 𠀁')).toEqual(['x']);
    expect(extractMath('$𝐴 + 𝐵$ 是粗体')).toEqual(['𝐴 + 𝐵']);
    expect(extractMath('公式 $x^2 + 🎉$ 完成')).toEqual(['x^2 + 🎉']);
    expect(extractMath('区间 $𝟙–$𝟚 不在此列')).toEqual([]);
    expect(extractMath('$𝟙𝟚$ 是数学数字')).toEqual(['𝟙𝟚']);
  });

  it('rejects whitespace-adjacent delimiters', () => {
    expect(extractMath('$ x$')).toEqual([]);
    expect(extractMath('$x $')).toEqual([]);
    expect(extractMath('$ $')).toEqual([]);
  });

  it('mixes math and currency in one sentence', () => {
    expect(extractMath('$x$ 是 $100')).toEqual(['x']);
    expect(extractMath('设 $n$ 个，每个 $5')).toEqual(['n']);
  });

  it('reads Unicode sign variants as currency shapes', () => {
    expect(extractMath('价格 $−100，公式为$x$')).toEqual(['x']);
    expect(extractMath('Price $＋100 and f$x$')).toEqual(['x']);
    expect(extractMath('价格 $－100 与 $-100 均保留')).toEqual([]);
  });

  it('keeps leading/trailing mixed-$ price comparisons literal', () => {
    expect(extractMath('$5 vs 10$')).toEqual([]);
    expect(extractMath('$5 each, or 10$ total')).toEqual([]);
    expect(extractMath('$5 美元或 10$')).toEqual([]);
    // Math with operators or clean endings is unaffected.
    expect(extractMath('答案是 $42$。')).toEqual(['42']);
    expect(extractMath('$3x+1$ 成立')).toEqual(['3x+1']);
    // Compact digit-led formulas without whitespace are not price comparisons.
    expect(extractMath('$2e3$')).toEqual(['2e3']);
    expect(extractMath('$3x2$')).toEqual(['3x2']);
    expect(extractMath('$10log2$')).toEqual(['10log2']);
    expect(extractMath('系数 $2e3$ 与 $10log2$ 都成立')).toEqual(['2e3', '10log2']);
  });

  it('keeps digit-led formulas with named TeX operators', () => {
    expect(extractMath('$2 \\times 3$')).toEqual(['2 \\times 3']);
    expect(extractMath('$2 \\mod 3$')).toEqual(['2 \\mod 3']);
    expect(extractMath('$10 \\div 2$')).toEqual(['10 \\div 2']);
    expect(extractMath('$2 \\neq 3$ 显然成立')).toEqual(['2 \\neq 3']);
  });

  it('keeps digit-led formulas with Unicode operators', () => {
    expect(extractMath('$1 × 2$')).toEqual(['1 × 2']);
    expect(extractMath('$1 ÷ 2$')).toEqual(['1 ÷ 2']);
    expect(extractMath('误差 $1 ± 2$ 可接受')).toEqual(['1 ± 2']);
    expect(extractMath('条件 $1 ≤ 2$ 成立')).toEqual(['1 ≤ 2']);
    // …while real price comparisons stay literal.
    expect(extractMath('$5 vs 10$')).toEqual([]);
    expect(extractMath('$5 美元或 10$')).toEqual([]);
  });

  it('confirms formulas starting with Unicode math symbols after prices', () => {
    expect(extractMath('价格$100，误差为$±5$')).toEqual(['±5']);
    expect(extractMath('The price is $100 with tolerance $±5$')).toEqual(['±5']);
    expect(extractMath('票价$50，映射为 $x → y$')).toEqual(['x → y']);
    expect(extractMath('原价$80，开根得 $√2$ 倍')).toEqual(['√2']);
    expect(extractMath('The fare is $50, mapped as $x → y$')).toEqual(['x → y']);
  });

  it('confirms formulas starting with ASCII operators after prices', () => {
    expect(extractMath('价格$5，条件为$<x$')).toEqual(['<x']);
    expect(extractMath('价格$5，结果为$=x$')).toEqual(['=x']);
    expect(extractMath('The price is $5, condition $<x$')).toEqual(['<x']);
    expect(extractMath('价格$5，指数为$^2$')).toEqual(['^2']);
    expect(extractMath('价格$5，下标为$_i$')).toEqual(['_i']);
  });

  it('vetoes the currency-then-math cascade via the inner-dollar rule', () => {
    expect(extractMath('花了 $100 买了 $x$ 个')).toEqual(['x']);
    expect(extractMath('It costs $100 for $x$ items')).toEqual(['x']);
  });

  it('vetoes currency closing at a parenthesized formula opener', () => {
    expect(extractMath('价格 $100（$x$ 元）')).toEqual(['x']);
    expect(extractMath('It costs $100 ($x$ per item)')).toEqual(['x']);
    expect(extractMath('$100$x$')).toEqual(['x']);
    expect(extractMath('花了 $100 ($x 元')).toEqual([]);
  });

  it('vetoes an unterminated following formula (streaming mid-state)', () => {
    expect(extractMath('It costs $100 ($x')).toEqual([]);
    expect(extractMath('It costs $100 ($|x|')).toEqual([]);
  });

  it('vetoes unterminated formulas — bilingual and longer mid-stream states', () => {
    expect(extractMath('价格为 $100（$x 尚未闭合')).toEqual([]);
    expect(extractMath('It costs $100 ($x^2')).toEqual([]);
    expect(extractMath('It costs $100 ($E=mc')).toEqual([]);
    expect(extractMath('It costs $100 ($+x')).toEqual([]);
  });

  it('keeps digit-led formulas glued to following text', () => {
    expect(extractMath('$42$次')).toEqual(['42']);
    expect(extractMath('$3x$项')).toEqual(['3x']);
    expect(extractMath('$2$nd order')).toEqual(['2']);
    expect(extractMath('平均 $5$次每天')).toEqual(['5']);
    expect(extractMath('the $3$rd place')).toEqual(['3']);
  });

  it('confirms an unclosed following formula after CJK prose', () => {
    expect(extractMath('价格 $100，公式为$x')).toEqual([]);
    expect(extractMath('价格$100，公式为$x')).toEqual([]);
    expect(extractMath('成本$100，苹果$x')).toEqual([]);
    // …while a clean digit-led formula still glues to following text.
    expect(extractMath('$42$次')).toEqual(['42']);
    expect(extractMath('$3x$项')).toEqual(['3x']);
  });

  it('confirms single-char non-Latin variables after prices', () => {
    expect(extractMath('价格 $100，变量$中$ 已知')).toEqual(['中']);
    expect(extractMath('цена $100, где $х$ известна')).toEqual(['х']);
    expect(extractMath('السعر $100، حيث $س$ معروف')).toEqual(['س']);
    expect(extractMath('मूल्य $100, जहाँ $क$ ज्ञात')).toEqual(['क']);
    // …while multi-char prose in any script still means separate formulas.
    expect(extractMath('价格 $100，公式为$x')).toEqual([]);
  });

  it('treats pure-ASCII prose words as text, not formula content', () => {
    expect(extractMath('$42$times$x$')).toEqual(['42', 'x']);
    expect(extractMath('It costs $100 and formula$x')).toEqual([]);
    expect(extractMath('价格 $100 and formula$x')).toEqual([]);
    expect(extractMath('$100 worth of apples$x')).toEqual([]);
    // …while real formula content still confirms.
    expect(extractMath('It costs $100, and Euler$e^{i\\pi}$ works')).toEqual(['e^{i\\pi}']);
    expect(extractMath('单价 $100，函数 f$x$ 成立')).toEqual(['x']);
  });

  it('keeps two formulas separated by CJK prose', () => {
    expect(extractMath('$42$次，结果为$y$。')).toEqual(['42', 'y']);
    expect(extractMath('$42$次、$y$个')).toEqual(['42', 'y']);
    expect(extractMath('计算 $3x$。然后 $y$ 即可')).toEqual(['3x', 'y']);
  });

  it('keeps ordinal-style formulas followed by prose punctuation', () => {
    expect(extractMath('Use the $1$st,$x$ case')).toEqual(['1', 'x']);
    expect(extractMath('取 $2$nd，再取 $y$')).toEqual(['2', 'y']);
  });

  it('keeps two formulas in spaceless CJK/Japanese prose', () => {
    expect(extractMath('$42$回結果は$y$です')).toEqual(['42', 'y']);
    expect(extractMath('$3x$然后$y$即可')).toEqual(['3x', 'y']);
    expect(extractMath('$42$回、$y$回')).toEqual(['42', 'y']);
  });

  it('keeps two formulas in spaceless Korean, Cyrillic, Arabic, and Indic prose', () => {
    expect(extractMath('$42$회결과는$y$입니다')).toEqual(['42', 'y']);
    expect(extractMath('$42$ раз $y$ два')).toEqual(['42', 'y']);
    expect(extractMath('$42$ مرة $y$')).toEqual(['42', 'y']);
    expect(extractMath('$42$ बार $y$')).toEqual(['42', 'y']);
  });

  it('keeps digit-led formulas followed by punctuation', () => {
    expect(extractMath('答案是 $42$。')).toEqual(['42']);
    expect(extractMath('The answer is $42$.')).toEqual(['42']);
    expect(extractMath('令 $3x$+2=5')).toEqual(['3x']);
    expect(extractMath('增长率是 $3.14$%！')).toEqual(['3.14']);
  });

  it('vetoes currency closing at a composite currency symbol', () => {
    expect(extractMath('It costs $100; US$ is accepted.')).toEqual([]);
    expect(extractMath('价格 $100（US$ 也可使用）')).toEqual([]);
    expect(extractMath('The fare is $100; HK$ accepted.')).toEqual([]);
    expect(extractMath('It costs $100; USD$ is accepted')).toEqual([]);
    expect(extractMath('价格 $100（JPY$ 也可）')).toEqual([]);
    expect(extractMath('价格 $100（EUR$ 也可）')).toEqual([]);
    expect(extractMath('It costs $100; S$ is accepted.')).toEqual([]);
    expect(extractMath('价格 $100（A$ 也可）')).toEqual([]);
    expect(extractMath('结果是 $3ab$，另一个是$y$')).toEqual(['3ab', 'y']);
    expect(extractMath('结果是 $3X$，第二个是$Y$')).toEqual(['3X', 'Y']);
  });

  it('keeps digit-led formulas ending in multiple uppercase variables', () => {
    expect(extractMath('$2AB$ 成立')).toEqual(['2AB']);
    expect(extractMath('$3XY$ 成立')).toEqual(['3XY']);
    expect(extractMath('so $2AB$ and $3XY$ hold')).toEqual(['2AB', '3XY']);
  });

  it('keeps digit-led formulas when the closer is letter-preceded', () => {
    expect(extractMath('结果是 $3x$，另一个公式是$y$。')).toEqual(['3x', 'y']);
    expect(extractMath('Result is $3x$, and $y$ too.')).toEqual(['3x', 'y']);
  });

  it('vetoes sign/decimal-prefixed amounts closing at a formula opener', () => {
    expect(extractMath('价格 $-100（$x$ 元）')).toEqual(['x']);
    expect(extractMath('It costs $-100 ($x$ per item)')).toEqual(['x']);
    expect(extractMath('It costs $.99 ($x$ each)')).toEqual(['x']);
    expect(extractMath('答案是 $-100$。')).toEqual(['-100']);
    expect(extractMath('约为 $.99$ 吗')).toEqual(['.99']);
    expect(extractMath('$-x$ 和 $-y$')).toEqual(['-x', '-y']);
  });

  it('keeps sign/decimal-prefixed price pairs literal', () => {
    expect(extractMath('范围 $-100–$-200')).toEqual([]);
    expect(extractMath('Prices are ($.99) or ($.50).')).toEqual([]);
    expect(extractMath('($-5) 和 ($-10)')).toEqual([]);
    expect(extractMath('Discounts $-5, $-10, $-15 today')).toEqual([]);
    expect(extractMath('$-5/$-10 都是亏本价')).toEqual([]);
    expect(extractMath('$.99/$.50 on sale')).toEqual([]);
  });

  it('keeps compact math with trailing arithmetic terms', () => {
    expect(extractMath('$x^2$+3 成立')).toEqual(['x^2']);
    expect(extractMath('$x^{2}$-1 成立')).toEqual(['x^{2}']);
    expect(extractMath('$π$-1 成立')).toEqual(['π']);
    expect(extractMath('so $x^2$+3 and $y$-2 hold')).toEqual(['x^2', 'y']);
  });

  it('does not veto non-currency openers closing at a formula opener', () => {
    expect(extractMath('$x$+y$')).toEqual(['x']);
    expect(extractMath('设 $1$ 或 $2$ 个')).toEqual(['1', '2']);
    expect(extractMath('$3x$$2y$')).toEqual(['3x', '2y']);
  });

  it('ignores escaped dollars', () => {
    expect(extractMath('\\$100$')).toEqual([]);
    expect(extractMath('$a \\$ b$')).toEqual(['a \\$ b']);
  });

  it('leaves $$ display math to the block rule', () => {
    expect(extractMath('$$x$$')).toEqual([]);
    expect(extractMath('$$')).toEqual([]);
  });

  it('keeps the close/open boundary of adjacent formulas', () => {
    expect(extractMath('$x$$y$')).toEqual(['x', 'y']);
    expect(extractMath('$a$$b$$c$')).toEqual(['a', 'b', 'c']);
    expect(extractMath('相邻公式 $E=mc^2$$F=ma$ 连用')).toEqual(['E=mc^2', 'F=ma']);
    expect(extractMath('$$x$$y$$')).toEqual([]);
    expect(extractMath('$x$$')).toEqual(['x']);
  });

  it('splits adjacent formulas in bilingual prose', () => {
    expect(extractMath('相邻公式 $a$$b$ 连用没问题')).toEqual(['a', 'b']);
    expect(extractMath('Adjacent formulas $a$$b$ work fine')).toEqual(['a', 'b']);
    expect(extractMath('$x$$y$ 和 $z$')).toEqual(['x', 'y', 'z']);
    expect(extractMath('$x$$y$ and $100')).toEqual(['x', 'y']);
    expect(extractMath('$x$$y$ 再加 $100')).toEqual(['x', 'y']);
  });

  it('keeps a $$ run after one formula literal', () => {
    expect(extractMath('$x$$$y$')).toEqual(['x']);
    expect(extractMath('$$x$$ 和 $y$')).toEqual(['y']);
    expect(extractMath('$$x$$ and $y$')).toEqual(['y']);
  });

  it('does not close a currency span into a $$ pair', () => {
    expect(extractMath('Price $100:$$x$$')).toEqual([]);
    expect(extractMath('价格 $100：$$x$$')).toEqual([]);
  });

  it('keeps adjacent bare-number formulas (letterless but not sentence punctuation)', () => {
    expect(extractMath('$42$$43$')).toEqual(['42', '43']);
    expect(extractMath('$3^2$$4^2$')).toEqual(['3^2', '4^2']);
    expect(extractMath('$-1$$-2$')).toEqual(['-1', '-2']);
  });

  it('keeps adjacent bare-number formulas — variants', () => {
    expect(extractMath('$1$$2$$3$')).toEqual(['1', '2', '3']);
    expect(extractMath('$0.5$$0.99$')).toEqual(['0.5', '0.99']);
    expect(extractMath('$+1$$+2$')).toEqual(['+1', '+2']);
    expect(extractMath('$42$$43$ 连续出现')).toEqual(['42', '43']);
    expect(extractMath('Price $50;$$x$$')).toEqual([]);
  });

  it('ignores dollars inside code spans', () => {
    expect(extractMath('`$PATH/bin:$HOME/bin`')).toEqual([]);
    expect(extractMath('用 `$x$` 表示')).toEqual([]);
  });

  it('ignores dollars in template literals split open by inner backticks', () => {
    // CommonMark closes a code span at an inner backtick (escapes don't apply
    // inside code), so `` `…`${A}/${B}`…` `` and its escaped-backtick variant
    // both split and leak the `$…$` out of the intended span. A backtick-
    // delimited segment whose dollars all belong to balanced `${…}`
    // placeholders reads as template code and keeps them literal.
    expect(extractMath('`kimiCdnContentUrl(\\`${BINARY_CDN_PATH}/${asset}\\`)`')).toEqual([]);
    expect(extractMath('`kimiCdnContentUrl(`${BINARY_CDN_PATH}/${asset}`)`')).toEqual([]);
    expect(extractMath('`fn(`${A}/${B}`)`')).toEqual([]);
    expect(extractMath('用 `\\`${foo}/${bar}\\`` 拼路径')).toEqual([]);
    // Math outside the split segments still renders.
    expect(extractMath('`\\`${foo}/${bar}\\``，然后 $x$')).toEqual(['x']);
    // …and prose between two spans is not template code.
    expect(extractMath('`C:\\` then $x$ then `tail`')).toEqual(['x']);
    expect(extractMath('路径 `C:\\` 与 $x$ 以及 `tail`')).toEqual(['x']);
    expect(extractMath('`C:\\` then ${x}$ then `tail`')).toEqual(['{x}']);
  });

  it('ignores dollar query params in bare URLs', () => {
    expect(extractMath('https://graph.microsoft.com/users?$filter=x&$select=id')).toEqual([]);
    expect(extractMath('见 https://a.b/c?$top=10&$skip=5 后计算 $x$ 的值')).toEqual(['x']);
  });

  it('ignores dollar query params in www/mailto/ftp URLs', () => {
    expect(extractMath('www.example.com?$filter=x&$select=id')).toEqual([]);
    expect(extractMath('mailto:a@b.com?subject=$x$')).toEqual([]);
    expect(extractMath('见 ftp://a.b/f?$top=1&$skip=2 后算 $y$')).toEqual(['y']);
    expect(extractMath('见 www.a.b/?$top=1&$skip=2 后算 $x$')).toEqual(['x']);
  });

  it('ignores dollar query params in schemeless URLs and API paths', () => {
    expect(extractMath('GET /users?$filter=name&$select=id')).toEqual([]);
    expect(extractMath('example.com/api?$top=10&$skip=5')).toEqual([]);
    expect(extractMath('见 api.example.com/v1?$f=1&$s=2 后算 $x$')).toEqual(['x']);
    // Fractions and shell paths are not URLs.
    expect(extractMath('$x/y$ 和 $a/b$')).toEqual(['x/y', 'a/b']);
    expect(extractMath('$PATH/bin:$HOME/bin')).toEqual(['PATH/bin:']);
  });

  it('keeps adjacent shell variables literal', () => {
    expect(extractMath('${HOME}$PATH')).toEqual([]);
    expect(extractMath('${HOME}${PATH}')).toEqual([]);
    expect(extractMath('${FOO:-$BAR}')).toEqual([]);
    expect(extractMath('路径 ${HOME}$PATH 与公式 $x$')).toEqual(['x']);
    expect(extractMath('run ${HOME}$PATH, then compute $x$')).toEqual(['x']);
  });

  it('keeps adjacent lowercase shell expansions literal', () => {
    expect(extractMath('${foo}${bar}')).toEqual([]);
    expect(extractMath('${x:-foo}${y:-bar}')).toEqual([]);
    expect(extractMath('相邻 ${foo}${bar} 与公式 $x$')).toEqual(['x']);
    // …while a standalone ${x}$ stays a formula.
    expect(extractMath('价格 $100（${x}$ 每个）')).toEqual(['{x}']);
  });

  it('does not mistake numeric fractions or short TLDs for bare domains', () => {
    expect(extractMath('$1.2/x$')).toEqual(['1.2/x']);
    expect(extractMath('$3.14/r^2$')).toEqual(['3.14/r^2']);
    expect(extractMath('$a.b/c$')).toEqual(['a.b/c']);
    expect(extractMath('面积 $3.14/r^2$ 与比值 $a.b/c$')).toEqual(['3.14/r^2', 'a.b/c']);
    // Real bare domains keep their protection.
    expect(extractMath('见 sub.example.co.uk/v1?$f=1&$s=2 后算 $x$')).toEqual(['x']);
  });

  it('ignores dollar query params in pathless domains and paren-led paths', () => {
    expect(extractMath('example.com?$top=1&$skip=2')).toEqual([]);
    expect(extractMath('GET(/users?$filter=name&$select=id)')).toEqual([]);
    expect(extractMath('见 example.com?$f=1 后算 $x$')).toEqual(['x']);
  });

  it('recognizes root-relative query URLs after leading punctuation', () => {
    expect(extractMath('公式 $x 未闭合，参见：/api?$filter=name')).toEqual([]);
    expect(extractMath('see $x, ref: /api?$select=id')).toEqual([]);
    expect(extractMath('$x open; see [/api?$top=1] for params')).toEqual([]);
    expect(extractMath('$x 未闭合，引号"/api?$f=1"结尾')).toEqual([]);
    // …while a path segment never starts mid-word.
    expect(extractMath('$a/b?$c$')).toEqual(['a/b?']);
  });

  it('recognizes root-relative query URLs with Unicode path segments', () => {
    expect(extractMath('见 /用户?$filter=name&$select=id 后算 $x$')).toEqual(['x']);
    expect(extractMath('$x 未闭合，见 /api/用户?$filter=name')).toEqual([]);
    expect(extractMath('see $x at /api/用户?q=$y')).toEqual([]);
  });

  it('protects dollar params in local and versioned API URLs', () => {
    expect(extractMath('$x 未闭合，见 127.0.0.1/api?$filter=x&$select=y')).toEqual([]);
    expect(extractMath('$x open, see localhost/api?$top=1')).toEqual([]);
    expect(extractMath('$x 未闭合，见 127.0.0.1:8080/api?$f=1')).toEqual([]);
    expect(extractMath('$x open, see /api/v1.0?$filter=x')).toEqual([]);
    expect(extractMath('$x 未闭合，见 ./api/users?$filter=x')).toEqual([]);
    // …while fractions stay math.
    expect(extractMath('$1.2/x$')).toEqual(['1.2/x']);
    expect(extractMath('$3.14/r^2$')).toEqual(['3.14/r^2']);
  });

  it('ignores dollars in bare URLs — more param styles and link contexts', () => {
    expect(extractMath('见 https://example.com/users?$filter=name&$orderby=age 这个接口')).toEqual([]);
    expect(extractMath('https://a.b/c?$x=1&$y=2')).toEqual([]);
    expect(extractMath('见 [文档](https://a.b/?$filter=x&$select=id)。')).toEqual([]);
    expect(extractMath('open https://a.b/?$top=1 then compute $y$')).toEqual(['y']);
  });

  it('stops URL protection at the actual URL boundary', () => {
    expect(extractMath('[文档](https://example.com)$x$')).toEqual(['x']);
    expect(extractMath('见 https://example.com。计算$x$')).toEqual(['x']);
    expect(extractMath('见 https://example.com，然后计算 $y$')).toEqual(['y']);
    expect(extractMath('see https://example.com, then compute $y$')).toEqual(['y']);
    expect(extractMath('见 https://example.com,然后计算$x$。')).toEqual(['x']);
    expect(extractMath('见 https://example.com;继续 $y$')).toEqual(['y']);
    expect(extractMath('https://a.b/x,y?$f=1&$s=2')).toEqual([]);
    expect(extractMath('[https://example.com](url)$x$')).toEqual(['x']);
    expect(extractMath('[https://a.b/c](url) 后接 $y$')).toEqual(['y']);
    // Brackets and emphasis delimiters end the URL too.
    expect(extractMath('[https://example.com]$x$')).toEqual(['x']);
    expect(extractMath('https://example.com*$x$*')).toEqual(['x']);
    expect(extractMath('https://example.com:$x$')).toEqual(['x']);
    expect(extractMath('https://example.com—$x$')).toEqual(['x']);
    expect(extractMath('https://example.com:8080/api?$f=1&$s=2')).toEqual([]);
    expect(extractMath('见 https://[::1]/api?$f=1&$s=2 后算 $x$')).toEqual(['x']);
    expect(extractMath('`https://a`$x$')).toEqual(['x']);
    expect(extractMath('`https://a.b/c` 后接 $y$')).toEqual(['y']);
  });

  it('never lets a dollar inside a URL close an earlier span', () => {
    expect(extractMath('公式 $x 尚未闭合，参见 https://example.com/users?$filter=name')).toEqual([]);
    expect(extractMath('the price $x see https://a.b/?$select=id')).toEqual([]);
    expect(extractMath('见 https://a.b/c?$top=10&$skip=5 后计算 $x$ 的值')).toEqual(['x']);
  });

  it('scans bare URLs in one forward pass over scheme repeats', () => {
    const text = `${'http://x '.repeat(5000)}end $y$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('y');
  });

  it('scans link targets linearly even with many unclosed fragments', () => {
    const text = `${'](x '.repeat(2000)}tail $y$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('y');
  });

  it('indexes backtick runs in one pass over unmatched run ladders', () => {
    const text = `${Array.from({ length: 2000 }, (_, i) => '`'.repeat((i % 5) + 1)).join('x')}end $y$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('y');
  });

  it('does not pair runs consumed by an outer code span with later text', () => {
    expect(extractMath('`` a ` b `` formula $x [docs](foo?$filter=y) tail `')).toEqual([]);
    expect(extractMath('`` a ` b `` then $x$ end `')).toEqual(['x']);
  });

  it('advances backtick queues past runs consumed by a longer span', () => {
    expect(extractMath('`a ` b `` then `[label](foo`$x$)`')).toEqual(['x']);
    expect(extractMath('`甲 ` 乙 `` 然后 `[标签](foo`$x$)`')).toEqual(['x']);
    // …and a later span still pairs normally afterwards.
    expect(extractMath('`a ` b `` then `[label](foo`$x$)` plus `y` and $z$')).toEqual(['x', 'z']);
  });

  it('does not pair escaped backticks into code spans', () => {
    expect(extractMath('\\` formula $q [docs](foo?$filter=y) \\`')).toEqual([]);
    expect(extractMath('\\` 公式 $q [文档](foo?$filter=y) \\`')).toEqual([]);
    // An escaped backtick does not veto a surrounding span either.
    expect(extractMath('$x \\` y$')).toEqual(['x \\` y']);
    expect(extractMath('公式 $x \\` y$ 成立')).toEqual(['x \\` y']);
    // …while a double backslash leaves the backtick unescaped.
    expect(extractMath('$a \\\\` b ` c$')).toEqual([]);
  });

  it('never lets a dollar inside a relative link target close an earlier span', () => {
    expect(extractMath('公式 $x 未闭合，参见 [文档](/api?$filter=name)')).toEqual([]);
    expect(extractMath('see $x and [docs](/api?$select=id) later')).toEqual([]);
    expect(extractMath('见 [公式 $x$](url) 链接')).toEqual(['x']);
  });

  it('ignores `](` inside code spans when scanning link targets', () => {
    expect(extractMath('Use `](`; the result is $x$.')).toEqual(['x']);
    expect(extractMath('写法 `](target)` 示例，计算 $y$ 得 $z$')).toEqual(['y', 'z']);
    // A real link target still protects its query dollars.
    expect(extractMath('公式 $x 未闭合，参见 [文档](/api?$filter=name)')).toEqual([]);
  });

  it('skips raw HTML ranges when scanning for link labels', () => {
    expect(extractMath('<a title="["> text ](foo$x$)')).toEqual(['x']);
    expect(extractMath('<a title="["> 文本 ](foo$x$)')).toEqual(['x']);
    expect(extractMath('<!-- [ --> 文本 ](foo$x$)')).toEqual(['x']);
    // …while a real link outside HTML still protects its query dollars.
    expect(extractMath('公式 $x 未闭合，参见 [文档](/api?$filter=name)')).toEqual([]);
  });

  it('treats <…> after ]( as a link target, not raw HTML', () => {
    expect(extractMath('formula $x [bad](<oops>) then [good](foo?$filter=y)')).toEqual([]);
    expect(extractMath('公式 $x [坏](<oops>) 然后 [好](foo?$filter=y)')).toEqual([]);
  });

  it('ignores parens inside quoted link titles', () => {
    expect(extractMath('公式 $x 未闭合，见 [docs](/api?$filter=y "title (")')).toEqual([]);
    expect(extractMath("see $x [docs](/api?$filter=y 't (') end")).toEqual([]);
  });

  it('protects link targets with paren-style titles', () => {
    expect(extractMath('$x unfinished [link](url (title=$bad))')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，[链接](url (标题=$bad))')).toEqual([]);
    // …and an unescaped paren inside the title stays unprotected.
    expect(extractMath('见 $x 和 [a](b (c(d))) $y$')).toEqual(['y']);
  });

  it('treats quotes inside a bare link target as plain characters', () => {
    expect(extractMath('formula $x [docs](foo\'bar?$filter=y)')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 [docs](foo"bar?$select=id)')).toEqual([]);
  });

  it('only protects targets after a valid link label', () => {
    expect(extractMath('字符 ](foo $x$) 不是链接')).toEqual(['x']);
    expect(extractMath('a[0] foo ](bar $y$) baz')).toEqual(['y']);
    expect(extractMath('见 [公式 $x$](url) 链接')).toEqual(['x']);
  });

  it('only protects syntactically valid link targets', () => {
    expect(extractMath('[docs](foo $x$ bar)')).toEqual(['x']);
    expect(extractMath('公式 $x 未闭合，见 [docs](/api?$filter=y "title (")')).toEqual([]);
    expect(extractMath('见 [公式 $x$](url) 链接')).toEqual(['x']);
  });

  it('only protects angle-bracket targets that actually close', () => {
    expect(extractMath('[文档](<broken target $x$)')).toEqual(['x']);
    expect(extractMath('公式 $x 未闭合，见 [docs](</api?$filter=y>)')).toEqual([]);
  });

  it('keeps link-target protection across escaped parentheses', () => {
    expect(extractMath('formula $x [docs](/foo\\)bar?$filter=y)')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 [文档](/a\\)b?$select=id)')).toEqual([]);
    expect(extractMath('见 [公式 $x$](url) 链接')).toEqual(['x']);
  });

  it('protects angle-bracket link targets with unbalanced parens', () => {
    expect(extractMath('公式 $x 未闭合，参见 [文档](<foo)bar?$filter=y>)')).toEqual([]);
    expect(extractMath('$x open, see [docs](<a)b?$select=id>)')).toEqual([]);
    // …and brackets inside the angle destination stay literal too.
    expect(extractMath('$x 未闭合，见 [a](<b](c)?$f=1>)')).toEqual([]);
  });

  it('protects angle-bracket link targets with escaped brackets', () => {
    expect(extractMath('$x unfinished [link](</api/\\>?q=$filter>)')).toEqual([]);
    expect(extractMath('$x unfinished [link](</a b\\> ?$f=1>)')).toEqual([]);
    expect(extractMath('$x 未闭合，见 [文档](</a b\\> ?$f=1>)')).toEqual([]);
  });

  it('never lets a dollar inside a raw HTML tag close an earlier span', () => {
    expect(extractMath('formula $x, see <a href="/api?$filter=name">docs</a>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 <a href="/api?$select=id">文档</a>')).toEqual([]);
    expect(extractMath('$x < y$ 且 $a > b$')).toEqual(['x < y', 'a > b']);
    expect(extractMath('If a<b, then $x$>0')).toEqual(['x']);
  });

  it('only protects syntactically valid raw HTML tags', () => {
    expect(extractMath('<a =$x$>')).toEqual(['x']);
    expect(extractMath('</a $x$>')).toEqual(['x']);
    expect(extractMath('formula $x, see <a href="/api?$filter=name">docs</a>')).toEqual([]);
  });

  it('rejects malformed tags without hiding later dollars', () => {
    expect(extractMath('<a / $x$>')).toEqual(['x']);
    expect(extractMath('见 <a / $x$> 与 <a =$y$>')).toEqual(['x', 'y']);
    // …while a syntactically valid unquoted value keeps its protection.
    expect(extractMath('<a b=$x$>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 <a b=$y$> 链接')).toEqual([]);
  });

  it('allows whitespace around = in HTML attributes', () => {
    expect(extractMath('formula $x <a href = "/api?$filter=y">')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 <a href = "/api?$select=id">')).toEqual([]);
    expect(extractMath('<a b= $x$>')).toEqual([]);
    expect(extractMath('see $x <a data-id = 123 href="/api?$top=1">')).toEqual([]);
  });

  it('rejects unquoted attribute values with CommonMark-excluded chars', () => {
    expect(extractMath('<a b==$x$>')).toEqual(['x']);
    expect(extractMath('<a b=c"$x$>')).toEqual(['x']);
    expect(extractMath('见 <a b=<$x$> 与 <a b==$y$>')).toEqual(['x', 'y']);
    // A backtick-led value is rejected too (matcher level: the tokenizer
    // would read the backticks as a code span first).
    expect(matchInlineMath('<a b=`$x$`>', 6)?.content).toBe('x');
    // …while quoted and plain unquoted values keep their protection.
    expect(extractMath('<a b=$x$>')).toEqual([]);
    expect(extractMath("公式 $x 未闭合，见 <a b='$y$'> 链接")).toEqual([]);
  });

  it('requires a letter, _, or : as the first attribute-name char', () => {
    expect(extractMath('<a 1=$x$>')).toEqual(['x']);
    expect(extractMath('<a .name=$x$>')).toEqual(['x']);
    expect(extractMath('见 <a -n=$x$> 与 <a 1=$y$>')).toEqual(['x', 'y']);
    // …while valid names keep their protection.
    expect(extractMath('公式 $x 未闭合，见 <a _d=$y$> 链接')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 <svg xlink:href="?$filter=y">')).toEqual([]);
  });

  it('protects tags with namespaced or dotted attribute names', () => {
    expect(extractMath('公式 $x 未闭合，见 <svg xlink:href="?$filter=y">')).toEqual([]);
    expect(extractMath('see $x <a data.x.y="1" href="/api?$select=id">')).toEqual([]);
  });

  it('never lets a dollar inside a multi-line tag or HTML comment close a span', () => {
    expect(extractMath('formula $x <a\n href="/api?$filter=y">')).toEqual([]);
    expect(extractMath('formula $x <!--$TODO-->')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<!--$占位$-->')).toEqual([]);
  });

  it('never lets a dollar inside other raw HTML constructs close a span', () => {
    expect(extractMath('formula $x <?pi data="$foo/$bar"?>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<![CDATA[$y$]]>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<!ENTITY note "$z$">')).toEqual([]);
  });

  it('protects only declarations with uppercase names', () => {
    expect(extractMath('公式 $x 未闭合，<!ENTITY note "$z$">')).toEqual([]);
    expect(extractMath('<!foo $x$>')).toEqual(['x']);
    expect(extractMath('<!doctype html $x$>')).toEqual(['x']);
    expect(extractMath('见 <!DOCTYPE html> 与 <!foo $x$>')).toEqual(['x']);
  });

  it('never lets a dollar inside an email autolink close a span', () => {
    expect(extractMath('formula $x <foo$bar@example.com>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<foo$bar@example.com>')).toEqual([]);
  });

  it('protects dollars inside URI autolinks of any scheme', () => {
    expect(extractMath('formula $x <ssh://host/path?$filter=y>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<git+ssh://h/p?$f=1>')).toEqual([]);
    expect(extractMath('see $x <vscode://file/path?$l=2>')).toEqual([]);
  });

  it('protects email autolinks with dotless domains', () => {
    expect(extractMath('formula $x <foo$bar@example>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<a$b@localhost>')).toEqual([]);
  });

  it('validates email autolink domain labels', () => {
    expect(extractMath('<$x$@-host>')).toEqual(['x']);
    expect(extractMath('<$x$@foo_>')).toEqual(['x']);
    expect(extractMath('见 <$x$@foo_> 与 <$y$@bar->')).toEqual(['x', 'y']);
    // …while valid domains keep their protection.
    expect(extractMath('formula $x <foo$bar@example.com>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<a$b@mail-server>')).toEqual([]);
  });

  it('never lets a dollar after a quoted `>` inside a tag close a span', () => {
    expect(extractMath('formula $x <a title="a > b" href="/api?$filter=y">')).toEqual([]);
    expect(extractMath("公式 $x 未闭合，见 <a title='含 > 括号' href=\"/api?$select=id\">")).toEqual([]);
  });

  it('keeps scanning for later tags after an unclosed attribute quote', () => {
    expect(extractMath('formula $x <a title="broken> text <b data-q=\'$filter\'>')).toEqual([]);
    expect(extractMath('$x <a title="oops <b data-v=$bad>')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<a title="坏> 文本 <b data-q=\'$f\'>')).toEqual([]);
  });

  it('recovers to the next tag after a quote mismatch', () => {
    expect(extractMath('formula $x <a title="broken> text <b data-q="$filter">')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，<a title="坏> 文本 <b data-q="$f">')).toEqual([]);
  });

  it('keeps protection when ranges nest (tag contains a bare URL)', () => {
    expect(extractMath('formula $x <a href="https://a" data-q="$filter">docs</a> https://b?$z=1')).toEqual([]);
    expect(extractMath('公式 $x 见 [链接](https://a.b/?$f=1 "标题")')).toEqual([]);
  });

  it('keeps URL protection through balanced parentheses', () => {
    expect(extractMath('$x 尚未闭合，参考 https://host/Foo_(bar)?$filter=id')).toEqual([]);
    expect(extractMath('see $x at https://h/a(b)?$y=1 end')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，参见 [文档](/a(b)?$filter=x)')).toEqual([]);
    expect(extractMath('[文档](https://example.com)$x$')).toEqual(['x']);
  });

  it('keeps URL protection through IPv6 hosts and nested parens', () => {
    expect(extractMath('$x 尚未闭合，见 https://[::1]/api?$filter=name&$select=id')).toEqual([]);
    expect(extractMath('$x open, see https://a/(u(v))?$filter=n&$top=2')).toEqual([]);
  });

  it('keeps URL protection through path colons', () => {
    expect(extractMath('$x 未闭合，见 https://api.example.com/items/urn:uuid?$filter=x&$select=y')).toEqual([]);
    expect(extractMath('$x open, see https://a.example.com/p/urn:isbn:123?$top=1')).toEqual([]);
    // …while a prose colon still ends the URL.
    expect(extractMath('https://example.com:$x$')).toEqual(['x']);
    expect(extractMath('见 https://example.com: 计算 $x$')).toEqual(['x']);
  });

  it('stops bare-URL protection at smart quotes', () => {
    expect(extractMath('参见“https://example.com”$x$')).toEqual(['x']);
    expect(extractMath('see “https://example.com” then $y$')).toEqual(['y']);
    expect(extractMath('引文‘https://a.bc/d’后接 $z$')).toEqual(['z']);
  });

  it('stops bare-URL protection at an unmatched TeX closing brace', () => {
    expect(extractMath('$\\text{see https://example.com}$')).toEqual(['\\text{see https://example.com}']);
    expect(extractMath('$\\text{见 https://example.com 文档}$')).toEqual(['\\text{见 https://example.com 文档}']);
    // …while brace-balanced URL path templates keep their protection.
    expect(extractMath('$x 未闭合，见 https://api.example.com/users/{id}?$filter=name')).toEqual([]);
    expect(extractMath('$x open, see https://api.example.com/items/{id}?$select=id')).toEqual([]);
  });

  it('keeps URL protection for uppercase or mixed-case schemes', () => {
    expect(extractMath('HTTPS://a.b/?$filter=x&$select=id')).toEqual([]);
    expect(extractMath('公式 $x 未闭合，见 Https://a.b/?$top=1&$skip=2')).toEqual([]);
  });

  it('keeps URL protection across single quotes in OData strings', () => {
    expect(extractMath("https://a/users?$filter=Name%20eq%20'Alice'&$select=id&$top=5")).toEqual([]);
    expect(extractMath("公式 $x 未闭合，见 https://a/u?$filter=N%20eq%20'张'&$top=1")).toEqual([]);
  });

  it('rejects math wrapping a code span', () => {
    expect(extractMath('$a `code` b$')).toEqual([]);
  });

  it('keeps unterminated dollars literal (streaming mid-state)', () => {
    expect(extractMath('价格是 $100，然后')).toEqual([]);
    expect(extractMath('公式 $x^2 还在输入')).toEqual([]);
  });

  it('rejects a closer followed by a digit even for math-looking content', () => {
    // Documented false negative, same as GitHub/Pandoc.
    expect(extractMath('$x$2')).toEqual([]);
  });

  it('still misparses a bare $A/b:$C/d shell path (documented residual)', () => {
    // Same false positive as GitHub/Pandoc; the fix is to write it as a code
    // span, which the case above covers.
    expect(extractMath('$PATH/bin:$HOME/bin')).toEqual(['PATH/bin:']);
  });
});

// Ported from pandoc's tex_math_dollars (MANUAL.txt, Math.hs, #1909/#6739/#8178).
describe('pandoc parity (tex_math_dollars, in AI-output contexts)', () => {
  it('manual: $20,000 and $30,000 won\'t parse as math', () => {
    expect(extractMath('2023 年营收为 $20,000，2024 年增长到 $30,000。')).toEqual([]);
    expect(extractMath('Revenue was $20,000 in 2023 and grew to $30,000 in 2024.')).toEqual([]);
  });

  it('math.hs: closing $ must not be followed by a digit ("prevent capture of $5")', () => {
    expect(extractMath('把 $5 和 $10 相加得到 $15。')).toEqual([]);
    expect(extractMath('Adding $5 and $10 gives $15.')).toEqual([]);
  });

  it('math.hs: opening $ must not be followed by a space', () => {
    expect(extractMath('总价约为 $ 500，税费约为 $ 50。')).toEqual([]);
    expect(extractMath('The total is about $ 500 and the tax is about $ 50.')).toEqual([]);
  });

  it('math.hs: closing $ must not be preceded by a space', () => {
    expect(extractMath('设变量为 $x 且单价为 $5 时不等式成立')).toEqual([]);
    expect(extractMath('Let $x stay positive when the unit price is $5')).toEqual([]);
  });

  it('manual: backslash-escaped dollars are not delimiters', () => {
    expect(extractMath('转义后的 \\$100 会原样显示')).toEqual([]);
    expect(extractMath('Escape it as \\$100 to keep the literal amount.')).toEqual([]);
  });

  it('#1909: apostrophe right after math', () => {
    expect(extractMath("The value of the $x$'s and the systems' condition.")).toEqual(['x']);
    expect(extractMath('$x$ 的导数如下所示。')).toEqual(['x']);
  });

  it('#6739: $|x|$ inside list items', () => {
    expect(extractMath('- 绝对值记作 $|x|$\n- 相反数记作 $-x$')).toEqual(['|x|', '-x']);
    expect(extractMath('- absolute value $|x|$\n- negation $-x$')).toEqual(['|x|', '-x']);
  });

  it('#8178: $mc^2$', () => {
    expect(extractMath('质能方程可简写为 $mc^2$ 的形式。')).toEqual(['mc^2']);
    expect(extractMath('The energy equation shortens to $mc^2$ here.')).toEqual(['mc^2']);
  });

  it('middle spaces and LaTeX commands in derivation contexts', () => {
    const formula = 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
    expect(extractMath(`求根公式为 $${formula}$，其中 $a \\neq 0$。`)).toEqual([formula, 'a \\neq 0']);
    expect(extractMath(`The roots are $${formula}$ when $a \\neq 0$.`)).toEqual([formula, 'a \\neq 0']);
  });

  it('multi-step derivations with several inline formulas', () => {
    const expected = ['a^2 + b^2 = c^2', 'a = 3', 'b = 4', 'c = 5'];
    expect(extractMath('由勾股定理 $a^2 + b^2 = c^2$，代入 $a = 3$、$b = 4$，可得 $c = 5$。')).toEqual(expected);
    expect(extractMath('From $a^2 + b^2 = c^2$, substituting $a = 3$ and $b = 4$ gives $c = 5$.')).toEqual(expected);
  });

  it('math and currency mixed in one sentence', () => {
    expect(extractMath('当 $x = 5$ 时，总价为 $25。')).toEqual(['x = 5']);
    expect(extractMath('When $x = 5$, the total is $25.')).toEqual(['x = 5']);
  });

  it('dense price comparisons stay fully literal', () => {
    expect(extractMath('这件商品原价 $89.99，打八折后是 $71.99，立省 $18.00。')).toEqual([]);
    expect(extractMath('The list price is $89.99, the sale price is $71.99, and you save $18.00.')).toEqual([]);
  });
});

describe('intentional divergences from pandoc', () => {
  // Pandoc swallows the cascade; our inner-dollar veto rejects it.
  it('\\text{…} containing a dollar is vetoed (pandoc keeps it)', () => {
    // Pandoc keeps `\text{…}` dollars; we veto — accepted trade-off.
    expect(extractMath('$\\text{总价: $5}$')).toEqual(['5}']);
  });
});


// ---------------------------------------------------------------------------

interface FakeToken {
  type: string;
  content: string;
  markup: string;
  raw: string;
  loading: boolean;
}

function fakeState(src: string, pos = 0) {
  const tokens: FakeToken[] = [];
  const state = {
    src,
    pos,
    posMax: src.length,
    push(type: string, _tag: string, _nesting: number): FakeToken {
      const token: FakeToken = { type, content: '', markup: '', raw: '', loading: false };
      tokens.push(token);
      return token;
    },
  };
  return { state, tokens };
}

describe('mathInlineRule', () => {
  it('advances state.pos in silent mode without emitting a token (skipToken contract)', () => {
    // skipToken throws when a silent match leaves pos unchanged.
    const { state, tokens } = fakeState('$x$ 和 $100');
    expect(mathInlineRule(state, true)).toBe(true);
    expect(state.pos).toBe(3);
    expect(tokens).toEqual([]);
  });

  it('emits the markstream-compatible math_inline token', () => {
    const { state, tokens } = fakeState('$x$');
    expect(mathInlineRule(state, false)).toBe(true);
    expect(state.pos).toBe(3);
    expect(tokens).toEqual([
      { type: 'math_inline', content: 'x', markup: '$', raw: '$x$', loading: false },
    ]);
  });

  it('returns false for currency and leaves pos untouched', () => {
    const { state, tokens } = fakeState('$100');
    expect(mathInlineRule(state, false)).toBe(false);
    expect(state.pos).toBe(0);
    expect(tokens).toEqual([]);
  });

  it('returns cheaply at non-dollar positions', () => {
    const { state, tokens } = fakeState('纯文本 no dollars here', 5);
    expect(mathInlineRule(state, true)).toBe(false);
    expect(state.pos).toBe(5);
    expect(tokens).toEqual([]);
  });

  it('matches mid-string in silent mode (link label scan)', () => {
    const { state, tokens } = fakeState('[见 $E=mc^2$](url)', 3);
    expect(mathInlineRule(state, true)).toBe(true);
    expect(state.pos).toBe(11);
    expect(tokens).toEqual([]);
  });

  it('returns false in silent mode for currency and leaves pos untouched', () => {
    const { state, tokens } = fakeState('$100');
    expect(mathInlineRule(state, true)).toBe(false);
    expect(state.pos).toBe(0);
    expect(tokens).toEqual([]);
  });

  it('tracks the previous match end across calls (adjacent formulas)', () => {
    const { state, tokens } = fakeState('$x$$y$');
    expect(mathInlineRule(state, false)).toBe(true);
    expect(state.pos).toBe(3);
    expect(mathInlineRule(state, false)).toBe(true);
    expect(state.pos).toBe(6);
    expect(tokens.map((t) => t.content)).toEqual(['x', 'y']);
  });

  it('emits raw with the full delimited source for mid-string spans', () => {
    const { state, tokens } = fakeState('质量 $E=mc^2$ 能量', 3);
    expect(mathInlineRule(state, false)).toBe(true);
    expect(tokens[0]).toMatchObject({ content: 'E=mc^2', raw: '$E=mc^2$' });
  });
});


describe('createInlineMathMatcher', () => {
  it('handles currency-dense input without rescanning per opener', () => {
    const text = Array.from({ length: 10000 }, (_, i) => `$${i + 1} `).join('');
    const match = createInlineMathMatcher(text);
    const spans: string[] = [];
    for (let pos = 0; pos < text.length; pos++) {
      if (text[pos] !== '$') continue;
      const m = match(pos);
      if (m) spans.push(m.content);
    }
    expect(spans).toEqual([]);
  });

  it('finds the few formulas in currency-dense bilingual text', () => {
    const amounts = Array.from({ length: 2000 }, (_, i) => `价格 $${i + 1} 元 / $${i + 2}`).join('，');
    const text = `设 $x$ 为单价，${amounts}，则 $total = x \\times n$。`;
    const match = createInlineMathMatcher(text);
    const spans: string[] = [];
    let pos = 0;
    let lastEnd = -1;
    while (pos < text.length) {
      if (text[pos] === '$') {
        const m = match(pos, lastEnd);
        if (m) {
          spans.push(m.content);
          pos = m.end;
          lastEnd = m.end;
          continue;
        }
      }
      pos++;
    }
    expect(spans).toEqual(['x', 'total = x \\times n']);
  });

  it('is idempotent across repeated queries', () => {
    const match = createInlineMathMatcher('花了 $100 买了 $x$ 个');
    expect(match(3)).toBeNull();
    expect(match(3)).toBeNull();
    expect(match(11)?.content).toBe('x');
    expect(match(11)?.end).toBe(14);
  });

  it('handles many bare URLs with dollar params without rescanning', () => {
    const urls = Array.from({ length: 5000 }, (_, i) => `https://a.b/u${i}?$x=1`).join(' ');
    const text = `${urls} 算 $y$`;
    const match = createInlineMathMatcher(text);
    const spans: string[] = [];
    let pos = 0;
    let lastEnd = -1;
    while (pos < text.length) {
      if (text[pos] === '$') {
        const m = match(pos, lastEnd);
        if (m) {
          spans.push(m.content);
          pos = m.end;
          lastEnd = m.end;
          continue;
        }
      }
      pos++;
    }
    expect(spans).toEqual(['y']);
  });


  it('does not rescan the tail for every unclosed tag candidate', () => {
    const text = `${'<a x '.repeat(3000)}end $y$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('y');
  });

  it('does not rescan a shared closing bracket for every tag candidate', () => {
    const text = `${'<a '.repeat(16000)}> $x$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('x');
  });

  it('does not rescan the tail for every unclosed HTML comment', () => {
    const text = `${'<!--'.repeat(8000)} $y$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('y');
  });

  it('stops trying PI and CDATA openers once their terminator is gone', () => {
    const text = `${'<?'.repeat(3000)}${'<![CDATA['.repeat(3000)} $y$`;
    const match = createInlineMathMatcher(text);
    expect(match(text.length - 3)?.content).toBe('y');
  });

  it('still protects closed comments before unclosed repeats', () => {
    expect(extractMath(`<!-- $x --> ${'<!--'.repeat(2000)} $y$`)).toEqual(['y']);
    expect(extractMath('公式 $x 未闭合，<!--$占位$--> 后接 $y$')).toEqual(['y']);
  });
});
