export interface BrowserTextRange {
  start: number;
  end: number;
}

export interface BrowserTextSegment {
  text: string;
  match: boolean;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemeBrowserTextBoundary(text: string, index: number, direction: 1 | -1): number {
  if (index <= 0 || index >= text.length) return index;
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(text)) {
    if (segment.index === index) return index;
    if (segment.index > index) return direction === 1 ? segment.index : previous;
    previous = segment.index;
  }
  return direction === 1 ? text.length : previous;
}

const CASELESS_EQUIVALENTS: Record<string, string> = {
  "µ": "μ",
  "ß": "ss",
  "ŉ": "ʼn",
  "ſ": "s",
  "ǰ": "ǰ",
  "ͅ": "ι",
  "ΐ": "ΐ",
  "ΰ": "ΰ",
  "ς": "σ",
  "ϐ": "β",
  "ϑ": "θ",
  "ϕ": "φ",
  "ϖ": "π",
  "ϰ": "κ",
  "ϱ": "ρ",
  "ϵ": "ε",
  "և": "եւ",
  "ᏸ": "Ᏸ",
  "ᏹ": "Ᏹ",
  "ᏺ": "Ᏺ",
  "ᏻ": "Ᏻ",
  "ᏼ": "Ᏼ",
  "ᏽ": "Ᏽ",
  "ᲀ": "в",
  "ᲁ": "д",
  "ᲂ": "о",
  "ᲃ": "с",
  "ᲄ": "т",
  "ᲅ": "т",
  "ᲆ": "ъ",
  "ᲇ": "ѣ",
  "ᲈ": "ꙋ",
  "ẖ": "ẖ",
  "ẗ": "ẗ",
  "ẘ": "ẘ",
  "ẙ": "ẙ",
  "ẚ": "aʾ",
  "ẛ": "ṡ",
  "ὐ": "ὐ",
  "ὒ": "ὒ",
  "ὔ": "ὔ",
  "ὖ": "ὖ",
  "ᾀ": "ἀι",
  "ᾁ": "ἁι",
  "ᾂ": "ἂι",
  "ᾃ": "ἃι",
  "ᾄ": "ἄι",
  "ᾅ": "ἅι",
  "ᾆ": "ἆι",
  "ᾇ": "ἇι",
  "ᾐ": "ἠι",
  "ᾑ": "ἡι",
  "ᾒ": "ἢι",
  "ᾓ": "ἣι",
  "ᾔ": "ἤι",
  "ᾕ": "ἥι",
  "ᾖ": "ἦι",
  "ᾗ": "ἧι",
  "ᾠ": "ὠι",
  "ᾡ": "ὡι",
  "ᾢ": "ὢι",
  "ᾣ": "ὣι",
  "ᾤ": "ὤι",
  "ᾥ": "ὥι",
  "ᾦ": "ὦι",
  "ᾧ": "ὧι",
  "ᾲ": "ὰι",
  "ᾳ": "αι",
  "ᾴ": "άι",
  "ᾶ": "ᾶ",
  "ᾷ": "ᾶι",
  "ι": "ι",
  "ῂ": "ὴι",
  "ῃ": "ηι",
  "ῄ": "ήι",
  "ῆ": "ῆ",
  "ῇ": "ῆι",
  "ῒ": "ῒ",
  "ΐ": "ΐ",
  "ῖ": "ῖ",
  "ῗ": "ῗ",
  "ῢ": "ῢ",
  "ΰ": "ΰ",
  "ῤ": "ῤ",
  "ῦ": "ῦ",
  "ῧ": "ῧ",
  "ῲ": "ὼι",
  "ῳ": "ωι",
  "ῴ": "ώι",
  "ῶ": "ῶ",
  "ῷ": "ῶι",
  "꟝": "ɷ",
  "꟢": "ɼ",
  "꭬": "ꭋ",
  "꭭": "ꭌ",
  "ꭰ": "Ꭰ",
  "ꭱ": "Ꭱ",
  "ꭲ": "Ꭲ",
  "ꭳ": "Ꭳ",
  "ꭴ": "Ꭴ",
  "ꭵ": "Ꭵ",
  "ꭶ": "Ꭶ",
  "ꭷ": "Ꭷ",
  "ꭸ": "Ꭸ",
  "ꭹ": "Ꭹ",
  "ꭺ": "Ꭺ",
  "ꭻ": "Ꭻ",
  "ꭼ": "Ꭼ",
  "ꭽ": "Ꭽ",
  "ꭾ": "Ꭾ",
  "ꭿ": "Ꭿ",
  "ꮀ": "Ꮀ",
  "ꮁ": "Ꮁ",
  "ꮂ": "Ꮂ",
  "ꮃ": "Ꮃ",
  "ꮄ": "Ꮄ",
  "ꮅ": "Ꮅ",
  "ꮆ": "Ꮆ",
  "ꮇ": "Ꮇ",
  "ꮈ": "Ꮈ",
  "ꮉ": "Ꮉ",
  "ꮊ": "Ꮊ",
  "ꮋ": "Ꮋ",
  "ꮌ": "Ꮌ",
  "ꮍ": "Ꮍ",
  "ꮎ": "Ꮎ",
  "ꮏ": "Ꮏ",
  "ꮐ": "Ꮐ",
  "ꮑ": "Ꮑ",
  "ꮒ": "Ꮒ",
  "ꮓ": "Ꮓ",
  "ꮔ": "Ꮔ",
  "ꮕ": "Ꮕ",
  "ꮖ": "Ꮖ",
  "ꮗ": "Ꮗ",
  "ꮘ": "Ꮘ",
  "ꮙ": "Ꮙ",
  "ꮚ": "Ꮚ",
  "ꮛ": "Ꮛ",
  "ꮜ": "Ꮜ",
  "ꮝ": "Ꮝ",
  "ꮞ": "Ꮞ",
  "ꮟ": "Ꮟ",
  "ꮠ": "Ꮠ",
  "ꮡ": "Ꮡ",
  "ꮢ": "Ꮢ",
  "ꮣ": "Ꮣ",
  "ꮤ": "Ꮤ",
  "ꮥ": "Ꮥ",
  "ꮦ": "Ꮦ",
  "ꮧ": "Ꮧ",
  "ꮨ": "Ꮨ",
  "ꮩ": "Ꮩ",
  "ꮪ": "Ꮪ",
  "ꮫ": "Ꮫ",
  "ꮬ": "Ꮬ",
  "ꮭ": "Ꮭ",
  "ꮮ": "Ꮮ",
  "ꮯ": "Ꮯ",
  "ꮰ": "Ꮰ",
  "ꮱ": "Ꮱ",
  "ꮲ": "Ꮲ",
  "ꮳ": "Ꮳ",
  "ꮴ": "Ꮴ",
  "ꮵ": "Ꮵ",
  "ꮶ": "Ꮶ",
  "ꮷ": "Ꮷ",
  "ꮸ": "Ꮸ",
  "ꮹ": "Ꮹ",
  "ꮺ": "Ꮺ",
  "ꮻ": "Ꮻ",
  "ꮼ": "Ꮼ",
  "ꮽ": "Ꮽ",
  "ꮾ": "Ꮾ",
  "ꮿ": "Ꮿ",
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
  "ﬓ": "մն",
  "ﬔ": "մե",
  "ﬕ": "մի",
  "ﬖ": "վն",
  "ﬗ": "մխ",
  "𝽀": "𝽁",
  "𝽈": "𝽉",
  "𝽊": "𝽋",
  "𝽍": "𝽎",
  "𝽑": "𝽒",
  "𝽨": "𝽩",
  "𝽪": "𝽫",
  "𝽬": "𝽭",
  "𝽮": "𝽯",
  "𝽲": "𝽳",
  "𝽴": "𝽵",
  "𝽶": "𝽷",
  "𝽸": "𝽹",
  "𝽺": "𝽻",
  "𝽼": "𝽽",
  "𝽾": "𝽿",
  "𝾕": "ss",

};

function foldBrowserChar(char: string): string {
  const lower = char.toLowerCase();
  return CASELESS_EQUIVALENTS[lower] ?? lower;
}

const NON_ASCII = /[\u0080-\u{10ffff}]/u;

export function foldBrowserText(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase();
  let folded = '';
  for (const char of text) folded += foldBrowserChar(char);
  return folded;
}

function foldWithOffsets(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    const lower = foldBrowserChar(char);
    for (let unit = 0; unit < lower.length; unit++) {
      starts.push(index);
      ends.push(index + char.length);
    }
    folded += lower;
    index += char.length;
  }
  return { folded, starts, ends };
}

export function browserQueryTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(term => term.length > 0))];
}

export function findBrowserTextMatch(text: string, term: string): BrowserTextRange | undefined {
  const { folded, starts, ends } = foldWithOffsets(text);
  const foldedTerm = foldBrowserText(term);
  if (foldedTerm.length === 0) return undefined;
  const index = folded.indexOf(foldedTerm);
  return index < 0 ? undefined : { start: starts[index]!, end: ends[index + foldedTerm.length - 1]! };
}

export function findBrowserTextMatches(text: string, query: string): BrowserTextRange[] {
  const { folded, starts, ends } = foldWithOffsets(text);
  const ranges: BrowserTextRange[] = [];
  for (const term of browserQueryTerms(foldBrowserText(query))) {
    for (let index = folded.indexOf(term); index >= 0; index = folded.indexOf(term, index + 1)) {
      ranges.push({ start: starts[index]!, end: ends[index + term.length - 1]! });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: BrowserTextRange[] = [];
  for (const range of ranges) {
    const snapped = { start: graphemeBrowserTextBoundary(text, range.start, -1), end: graphemeBrowserTextBoundary(text, range.end, 1) };
    const last = merged.at(-1);
    if (last !== undefined && snapped.start <= last.end) last.end = Math.max(last.end, snapped.end);
    else merged.push(snapped);
  }
  return merged;
}

export function findBrowserCommonRange(text: string, query: string): BrowserTextRange | undefined {
  const { folded, starts, ends } = foldWithOffsets(text);
  const foldedQuery = foldBrowserText(query);
  const lengths = Array.from({ length: foldedQuery.length + 1 }, () => 0);
  let bestStart = 0;
  let bestLength = 0;
  for (let index = 0; index < folded.length; index++) {
    for (let other = foldedQuery.length; other > 0; other--) {
      lengths[other] = folded[index]! === foldedQuery[other - 1] ? lengths[other - 1]! + 1 : 0;
      if (lengths[other]! > bestLength) {
        bestLength = lengths[other]!;
        bestStart = index + 1 - bestLength;
      }
    }
  }
  if (bestLength === 0) return undefined;
  const start = starts[bestStart]!;
  const end = ends[bestStart + bestLength - 1]!;
  return { start: graphemeBrowserTextBoundary(text, start, -1), end: graphemeBrowserTextBoundary(text, end, 1) };
}

export function splitBrowserTextHighlights(text: string, ranges: readonly BrowserTextRange[] | undefined): BrowserTextSegment[] {
  const segments: BrowserTextSegment[] = [];
  let cursor = 0;
  for (const { start, end } of ranges ?? []) {
    if (start < cursor || end <= start || end > text.length) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length || segments.length === 0) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
