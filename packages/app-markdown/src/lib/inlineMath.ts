import type { MarkdownIt } from 'markstream-vue';
import { configureTaskListSpacing } from './taskListSpacing';

export interface InlineMathMatch {
  content: string;
  end: number;
}

function isEscapedAt(src: string, index: number): boolean {
  let backslashes = 0;
  let i = index - 1;
  while (i >= 0 && src[i] === '\\') {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

const WHITESPACE_RE = /\s/;
const DECIMAL_DIGIT_RE = /\p{Nd}/u;

function charAtCodePoint(src: string, i: number): string | undefined {
  const cp = src.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function charBefore(src: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const code = src.charCodeAt(i - 1);
  const start = code >= 0xdc00 && code <= 0xdfff && i > 1 ? i - 2 : i - 1;
  const cp = src.codePointAt(start);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE_RE.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && DECIMAL_DIGIT_RE.test(ch);
}

function isCurrencyShaped(src: string, pos: number): boolean {
  const ch = src[pos + 1];
  if (isDigit(charAtCodePoint(src, pos + 1))) return true;
  return (ch === '-' || ch === '+' || ch === '.' || ch === '−' || ch === '＋' || ch === '－') && isDigit(charAtCodePoint(src, pos + 2));
}

function isAsciiUpper(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'A' && ch <= 'Z';
}

const CURRENCY_PREFIX_RE = new RegExp(
  String.raw`^(?:AED|AFN|ALL|AMD|ANG|AOA|ARS|AUD|AWG|AZN|BAM|BBD|BDT|BGN|BHD|BIF|BMD|BND|BOB|BRL|BSD|BTN|BWP|BYN|BZD|CAD|CDF|CHF|CLF|CLP|CNY|COP|CRC|CUC|CUP|CVE|CZK|DJF|DKK|DOP|DZD|EGP|ERN|ETB|EUR|FJD|FKP|GBP|GEL|GHS|GIP|GMD|GNF|GTQ|GYD|HKD|HNL|HRK|HTG|HUF|IDR|ILS|INR|IQD|IRR|ISK|JMD|JOD|JPY|KES|KGS|KHR|KMF|KPW|KRW|KWD|KYD|KZT|LAK|LBP|LKR|LRD|LSL|LYD|MAD|MDL|MGA|MKD|MMK|MNT|MOP|MRU|MUR|MVR|MWK|MXN|MYR|MZN|NAD|NGN|NIO|NOK|NPR|NZD|OMR|PAB|PEN|PGK|PHP|PKR|PLN|PYG|QAR|RON|RSD|RUB|RWF|SAR|SBD|SCR|SDG|SEK|SGD|SHP|SLE|SLL|SOS|SRD|SSP|STN|SVC|SYP|SZL|THB|TJS|TMT|TND|TOP|TRY|TTD|TWD|TZS|UAH|UGX|USD|UYU|UZS|VED|VES|VND|VUV|WST|XAF|XCD|XOF|XPF|YER|ZAR|ZMW|ZWL|HK|US|SG|AU|CA|NZ|NT|TW|RMB|MEX|TT|BZ|EU|UK)$`,
);

function hasCurrencyPrefix(src: string, pos: number): boolean {
  if (!isAsciiUpper(src[pos - 1])) return false;
  let start = pos - 1;
  while (start > 0 && isAsciiUpper(src[start - 1])) start--;
  if (CURRENCY_PREFIX_RE.test(src.slice(start, pos))) return true;
  if (isDigit(charAtCodePoint(src, pos + 1))) return true;
  return pos - start <= 2 && !/[\p{L}\p{Nd}]/u.test(src[start - 1] ?? '') && !/\p{L}/u.test(charAtCodePoint(src, pos + 1) ?? '');
}

function isCompositeCurrency(src: string, j: number): boolean {
  if (!isAsciiUpper(src[j - 1])) return false;
  let start = j - 1;
  while (start > 0 && isAsciiUpper(src[start - 1])) start--;
  if (CURRENCY_PREFIX_RE.test(src.slice(start, j))) return true;
  return j - start <= 2 && !/[\p{L}\p{Nd}]/u.test(src[start - 1] ?? '');
}

const RANGE_CONNECTOR_RE = /^[-–—,，、;；:：~～(（[【/／]$/;

function isSignedAmountCloser(src: string, j: number): boolean {
  const ch = src[j + 1];
  if (ch !== '-' && ch !== '+' && ch !== '.') return false;
  if (!isDigit(charAtCodePoint(src, j + 2))) return false;
  const prev = src[j - 1];
  return prev !== undefined && RANGE_CONNECTOR_RE.test(prev);
}

function isTrailingCurrencySpan(content: string): boolean {
  const CONN = String.raw`[、,，;；:：~～\-–—至到/／\s（）()=*×＝]|和|跟|与|及|或|and|or`;
  let rest = content.replace(new RegExp(String.raw`^(?:${CONN})+`, 'u'), '');
  for (;;) {
    const next = rest
      .replace(new RegExp(String.raw`^\p{L}+(?:${CONN})+`, 'u'), '')
      .replace(/^[\p{L}][\p{L} ]*(?=\p{Nd})/u, '');
    if (next === rest) break;
    rest = next;
  }
  if (!/\p{Nd}/u.test(rest)) return false;
  const amountStart = 1;
  const amountDigits = 2;
  const afterSign = 4;
  const amountUnit = 8;
  const separator = 16;
  const states = new Uint8Array(rest.length + 1);
  states[0] = amountStart;
  for (let i = 0; i < rest.length;) {
    const ch = charAtCodePoint(rest, i)!;
    const next = i + ch.length;
    const state = states[i]!;
    const digit = isDigit(ch);
    const letter = /\p{L}/u.test(ch);
    if ((state & (amountStart | afterSign | separator)) !== 0 && digit) states[next]! |= amountDigits;
    if ((state & (amountStart | separator)) !== 0 && (ch === '-' || ch === '+')) states[next]! |= afterSign;
    if ((state & amountDigits) !== 0 && (digit || ",.'’".includes(ch))) states[next]! |= amountDigits;
    if ((state & (amountDigits | amountUnit)) !== 0 && letter) states[next]! |= amountUnit;
    if ((state & (amountDigits | amountUnit | separator)) !== 0) {
      if (/[、,，;；:：~～\-–—至到/／\s（）()=*×＝和跟与及或]/u.test(ch)) states[next]! |= separator;
      for (const word of ['and', 'or']) {
        if (rest.startsWith(word, i)) states[i + word.length]! |= separator;
      }
    }
    i = next;
  }
  return (states[rest.length]! & (amountDigits | amountUnit)) !== 0;
}

export type InlineMathMatcher = (pos: number, prevMatchEnd?: number) => InlineMathMatch | null;

const NO_CLOSER = -1;
const FLAG_INVISIBLE = 1;
const FLAG_POISON = 2;
const FLAG_VALID_CLOSER = 3;

export function createInlineMathMatcher(src: string): InlineMathMatcher {
  const n = src.length;
  const flags = new Uint8Array(n);
  const nextValidCloser = new Int32Array(n + 1).fill(NO_CLOSER);
  const poisonPrefix = new Int32Array(n + 1);
  const backtickPrefix = new Int32Array(n + 1);
  const urlRanges: Array<readonly [number, number]> = [];
  const codeSpanRanges: Array<readonly [number, number]> = [];
  {
    const runs: Array<[number, number]> = [];
    for (let j = 0; j < n; j++) {
      if (src[j] === '`') {
        if (isEscapedAt(src, j)) continue;
        let end = j + 1;
        while (end < n && src[end] === '`') end++;
        runs.push([j, end]);
        j = end - 1;
      }
    }
    const runQueues = new Map<number, number[]>();
    for (let i = 0; i < runs.length; i++) {
      const len = (runs[i] as [number, number])[1] - (runs[i] as [number, number])[0];
      const queue = runQueues.get(len);
      if (queue) queue.push(i);
      else runQueues.set(len, [i]);
    }
    const pointers = new Map<number, number>();
    let k = 0;
    while (k < runs.length) {
      const [start, end] = runs[k] as [number, number];
      const len = end - start;
      const queue = runQueues.get(len) as number[];
      let ptr = pointers.get(len) ?? 0;
      while (ptr < queue.length && (queue[ptr] as number) <= k) ptr++;
      pointers.set(len, ptr);
      if (ptr < queue.length) {
        codeSpanRanges.push([start, (runs[queue[ptr] as number] as [number, number])[1]]);
        k = (queue[ptr] as number) + 1;
      } else {
        k++;
      }
    }
  }
  let codeCursor = 0;
  const inCodeSpan = (p: number): boolean => {
    while (codeCursor < codeSpanRanges.length && p >= (codeSpanRanges[codeCursor]?.[1] ?? 0)) codeCursor++;
    const span = codeSpanRanges[codeCursor];
    return span !== undefined && p >= span[0];
  };
  const URL_BOUNDARY_CHARS = new Set(" \t\n\r)。，、；：！？\"<>`「」『』【】〔〕（）*—–“”‘’");
  const urlStarts: number[] = [];
  for (const m of src.matchAll(/\b(?:https?:\/\/|ftp:\/\/|mailto:|www\.)/gi)) urlStarts.push(m.index);
  for (const m of src.matchAll(/[\w.-]+/g)) {
    const end = m.index + m[0].length;
    if (src[end] !== '/' && src[end] !== '?' && !(src[end] === ':' && /\d/.test(src[end + 1] ?? ''))) continue;
    const host = m[0].replace(/^\.+/, '');
    if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{2,})$/i.test(host)) {
      urlStarts.push(end - host.length);
    }
  }
  for (const m of src.matchAll(/[\p{L}\p{Nd}._~/-]+/gu)) {
    if (src[m.index + m[0].length] !== '?') continue;
    if (/^(?:\.{1,2})?\/[\p{L}\p{Nd}._-]+(?:\/[\p{L}\p{Nd}._-]*)*$/u.test(m[0])) {
      urlStarts.push(m.index);
    }
  }
  urlStarts.sort((a, b) => a - b);
  let lastUrlEnd = -1;
  for (const start of urlStarts) {
    if (start < lastUrlEnd) continue;
    let j = start;
    let depth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    while (j < n) {
      const c = src[j] as string;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === '[') bracketDepth++;
      else if (c === ']') {
        if (bracketDepth === 0) break;
        bracketDepth--;
      } else if (c === '{') braceDepth++;
      else if (c === '}') {
        if (braceDepth === 0) break;
        braceDepth--;
      } else if (URL_BOUNDARY_CHARS.has(c)) break;
      else if ((c === ',' || c === ';' || c === '!' || c === '?') && !/[A-Za-z0-9$]/.test(src[j + 1] ?? '')) break;
      else if (c === ':' && bracketDepth === 0 && j > start + 7 && !/[\w/?#@~.+&=%-]/.test(src[j + 1] ?? '')) break;
      j++;
    }
    urlRanges.push([start, j]);
    lastUrlEnd = j;
  }

  const htmlRanges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (src[i] !== '<' || src[i + 1] === undefined || !/[a-zA-Z/]/.test(src[i + 1] as string)) continue;
    let j = i + 1;
    const closing = src[j] === '/';
    if (closing) j++;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(src.slice(j));
    if (!nameMatch) continue;
    j += nameMatch[0].length;
    const after = src[j];
    if (after === undefined || !/[\s/>]/.test(after)) continue;
    let k = j;
    let fail = NO_CLOSER;
    let closeEnd = NO_CLOSER;
    while (k < n) {
      const c = src[k] as string;
      if (c === '>') {
        closeEnd = k;
        break;
      }
      if (!closing && c === '/' && src[k + 1] === '>') {
        closeEnd = k + 1;
        break;
      }
      if (!/\s/.test(c)) {
        fail = k;
        break;
      }
      while (k < n && /\s/.test(src[k] as string)) k++;
      const d = src[k];
      if (d === undefined) break;
      if (d === '>') {
        closeEnd = k;
        break;
      }
      if (closing) {
        fail = k;
        break;
      }
      if (d === '/' && src[k + 1] === '>') {
        closeEnd = k + 1;
        break;
      }
      const attrMatch = /^[a-zA-Z_:][\w:.-]*/.exec(src.slice(k));
      if (!attrMatch) {
        fail = k;
        break;
      }
      k += attrMatch[0].length;
      let m = k;
      while (m < n && /\s/.test(src[m] as string)) m++;
      if (src[m] === '=') {
        m++;
        while (m < n && /\s/.test(src[m] as string)) m++;
        const q = src[m];
        if (q === '"' || q === "'") {
          const endQuote = src.indexOf(q, m + 1);
          if (endQuote === -1) {
            fail = m;
            break;
          }
          k = endQuote + 1;
        } else {
          const valMatch = /^[^\s"'=<>`]+/.exec(src.slice(m));
          if (!valMatch) {
            fail = m;
            break;
          }
          k = m + valMatch[0].length;
        }
      }
    }
    if (closeEnd !== NO_CLOSER) {
      htmlRanges.push([i, closeEnd + 1]);
      i = closeEnd;
    } else if (fail !== NO_CLOSER) {
      const nextLt = src.indexOf('<', i + 1);
      i = (nextLt !== -1 && nextLt < fail ? nextLt : fail) - 1;
    } else {
      break;
    }
  }
  let commentLive = true;
  let piLive = true;
  let cdataLive = true;
  let declLive = true;
  for (let i = 0; i < n; i++) {
    if (src[i] !== '<') continue;
    const c1 = src[i + 1];
    let matched = false;
    if (c1 === '?' && piLive) {
      const end = src.indexOf('?>', i + 2);
      if (end === -1) piLive = false;
      else {
        htmlRanges.push([i, end + 2]);
        i = end + 1;
        matched = true;
      }
    } else if (c1 === '!') {
      if (src[i + 2] === '-' && src[i + 3] === '-') {
        if (commentLive) {
          const end = src.indexOf('-->', i + 4);
          if (end === -1) commentLive = false;
          else {
            htmlRanges.push([i, end + 3]);
            i = end + 2;
            matched = true;
          }
        }
      } else if (src.startsWith('[CDATA[', i + 2)) {
        if (cdataLive) {
          const end = src.indexOf(']]>', i + 9);
          if (end === -1) cdataLive = false;
          else {
            htmlRanges.push([i, end + 3]);
            i = end + 2;
            matched = true;
          }
        }
      } else if (declLive && /[A-Z]/.test(src[i + 2] ?? '')) {
        const end = src.indexOf('>', i + 3);
        if (end === -1) declLive = false;
        else {
          htmlRanges.push([i, end + 1]);
          i = end;
          matched = true;
        }
      }
    }
    if (matched) continue;
    if (c1 !== undefined && /[a-zA-Z]/.test(c1)) {
      const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(src.slice(i + 1));
      if (schemeMatch) {
        let k = i + 1 + schemeMatch[0].length;
        while (k < n && src[k] !== '>' && src[k] !== '<' && !/\s/.test(src[k] as string)) k++;
        if (src[k] === '>') {
          htmlRanges.push([i, k + 1]);
          i = k;
          continue;
        }
      }
    }
    if (c1 === undefined || !/[\w.!#$%&'*+/=?^`{|}~-]/.test(c1)) continue;
    let k = i + 1;
    while (k < n && /[\w.!#$%&'*+/=?^`{|}~-]/.test(src[k] as string)) k++;
    if (src[k] !== '@') continue;
    k++;
    const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/;
    let label = DOMAIN_LABEL_RE.exec(src.slice(k));
    if (!label) continue;
    k += label[0].length;
    while (src[k] === '.') {
      label = DOMAIN_LABEL_RE.exec(src.slice(k + 1));
      if (!label) break;
      k += 1 + label[0].length;
    }
    if (src[k] !== '>') continue;
    htmlRanges.push([i, k + 1]);
    i = k;
  }
  htmlRanges.sort((a, b) => a[0] - b[0]);
  const mergedHtml: Array<[number, number]> = [];
  for (const [start, end] of htmlRanges) {
    const last = mergedHtml[mergedHtml.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else mergedHtml.push([start, end]);
  }
  urlRanges.push(...mergedHtml);
  let htmlCursor = 0;
  const inRawHtml = (p: number): boolean => {
    while (htmlCursor < mergedHtml.length && p >= (mergedHtml[htmlCursor]?.[1] ?? 0)) htmlCursor++;
    const range = mergedHtml[htmlCursor];
    return range !== undefined && p >= range[0];
  };
  const parenStack: number[] = [];
  let titleQuote: string | null = null;
  let openBrackets = 0;
  let angleTarget = false;
  for (let j = 0; j < n; j++) {
    if (src[j] === '\\') {
      j++;
    } else if (angleTarget) {
      if (src[j] === '>') angleTarget = false;
    } else if (inCodeSpan(j) || inRawHtml(j)) {} else if (titleQuote !== null) {
      if (src[j] === titleQuote) titleQuote = null;
    } else if (parenStack.length > 0 && (src[j] === '"' || src[j] === "'") && (j > 0 && /\s/.test(src[j - 1] as string))) {
      titleQuote = src[j] as string;
    } else if (src[j] === '[') {
      openBrackets++;
    } else if (src[j] === ']') {
      if (openBrackets > 0 && src[j + 1] === '(') {
        parenStack.push(j);
        angleTarget = src[j + 2] === '<';
        j++;
      }
      openBrackets = Math.max(0, openBrackets - 1);
    } else if (src[j] === '(' && parenStack.length > 0) {
      parenStack.push(-1);
    } else if (src[j] === ')' && parenStack.length > 0) {
      const mark = parenStack.pop();
      if (mark !== undefined && mark >= 0) {
        const inner = src.slice(mark + 2, j);
        const wsMatch = /\s/.exec(inner);
        if (
          wsMatch === null ||
          (inner.startsWith('<') && /^<(?:\\[<>]|[^<>])*>$/.test(inner)) ||
          /^[^\s]*\s+("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\(([^()\\]|\\.)*\))$/.test(inner)
        ) {
          urlRanges.push([mark, j + 1]);
        }
      }
    }
  }
  urlRanges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of urlRanges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const inBareUrl = (p: number): boolean => {
    let lo = 0;
    let hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = merged[mid];
      if (range === undefined) return false;
      if (p < range[0]) hi = mid - 1;
      else if (p >= range[1]) lo = mid + 1;
      else return true;
    }
    return false;
  };

  const templateShield = new Uint8Array(n);
  {
    let segStart = -1;
    let bareDollar = false;
    let sawPlaceholder = false;
    let braceDepth = 0;
    for (let j = 0; j <= n; j++) {
      const atBacktick = j < n && src[j] === '`';
      if (j === n || atBacktick) {
        if (atBacktick && segStart !== -1 && sawPlaceholder && !bareDollar && braceDepth === 0) {
          for (let k = segStart + 1; k < j; k++) templateShield[k] = 1;
        }
        segStart = j;
        bareDollar = false;
        sawPlaceholder = false;
        braceDepth = 0;
        continue;
      }
      if (segStart === -1) continue;
      const c = src[j] as string;
      if (c === '$') {
        if (isEscapedAt(src, j)) {} else if (src[j + 1] === '{') {
          sawPlaceholder = true;
          braceDepth++;
          j++;
        } else if (braceDepth === 0) {
          bareDollar = true;
        }
      } else if (braceDepth > 0) {
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
      }
    }
  }
  for (let j = 0; j < n; j++) {
    backtickPrefix[j + 1] = (backtickPrefix[j] ?? 0) + (src[j] === '`' && !isEscapedAt(src, j) ? 1 : 0);
    if (src[j] === '$') {
      if (isEscapedAt(src, j) || inBareUrl(j) || templateShield[j] === 1) {
        flags[j] = FLAG_INVISIBLE;
      } else if (isWhitespace(src[j - 1]) || isDigit(charAtCodePoint(src, j + 1)) || isSignedAmountCloser(src, j)) {
        flags[j] = FLAG_POISON;
      } else {
        flags[j] = FLAG_VALID_CLOSER;
      }
    }
    poisonPrefix[j + 1] = (poisonPrefix[j] ?? 0) + (flags[j] === FLAG_POISON ? 1 : 0);
  }
  let next = NO_CLOSER;
  for (let j = n - 1; j >= 0; j--) {
    if (flags[j] === FLAG_VALID_CLOSER) next = j;
    nextValidCloser[j] = next;
  }

  const FORMULA_START_RE = /^[\p{L}\p{Nd}\\|{([+.¬°-±×÷′-″←-⇿∀-⋿^_<>=-]$/u;
  const PROSE_END_RE = /[^\p{L}\p{Nd}\s]$/u;
  const INNER_PROSE_RE = /[^\s\u0020-\u007E\u0370-\u03FF\u{1D400}-\u{1D7FF}\p{Nd}¬°-±×÷′-″←-⇿∀-⋿]/u;
  const ASCII_PROSE_RE = /(?:^|\s)[a-z]{2,}/;
  const isConfirmedOpener = (dollar: number, content: string): boolean => {
    const ch = charAtCodePoint(src, dollar + 1);
    if (ch === undefined || !FORMULA_START_RE.test(ch)) return false;
    const inner = nextValidCloser[dollar + 1] ?? NO_CLOSER;
    if (inner !== NO_CLOSER) {
      const innerSpan = src.slice(dollar + 1, inner);
      const singleChar = innerSpan.length === ((innerSpan.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
      const prose = !singleChar && INNER_PROSE_RE.test(innerSpan);
      if (prose || /[,;:!?]$/.test(innerSpan) || /^[a-z]{2,}$/.test(innerSpan)) return false;
      return (
        (poisonPrefix[inner] ?? 0) - (poisonPrefix[dollar + 1] ?? 0) === 0 &&
        (backtickPrefix[inner] ?? 0) - (backtickPrefix[dollar + 1] ?? 0) === 0
      );
    }
    return PROSE_END_RE.test(content) || INNER_PROSE_RE.test(content) || ASCII_PROSE_RE.test(content);
  };

  let nextParenCloser: Int32Array | null = null;
  const matchParen = (pos: number): InlineMathMatch | null => {
    if (src[pos + 1] !== '(' || isEscapedAt(src, pos)) return null;
    if (nextParenCloser === null) {
      nextParenCloser = new Int32Array(n + 1).fill(NO_CLOSER);
      let closerAt = NO_CLOSER;
      for (let j = n - 2; j >= 0; j--) {
        if (src[j] === '\\' && src[j + 1] === ')' && !isEscapedAt(src, j)) closerAt = j;
        nextParenCloser[j] = closerAt;
      }
    }
    const closer = nextParenCloser[pos + 2] ?? NO_CLOSER;
    if (closer === NO_CLOSER) return null;
    if ((backtickPrefix[closer] ?? 0) - (backtickPrefix[pos + 2] ?? 0) > 0) return null;
    const content = src.slice(pos + 2, closer).trim();
    if (content === '') return null;
    return { content, end: closer + 2 };
  };

  return (pos: number, prevMatchEnd = -1): InlineMathMatch | null => {
    if (src[pos] === '\\') return matchParen(pos);
    if (src[pos] !== '$') return null;
    if (flags[pos] === FLAG_INVISIBLE) return null;
    if (src[pos + 1] === '$') return null;
    if (src[pos - 1] === '$' && prevMatchEnd !== pos) return null;
    if (hasCurrencyPrefix(src, pos)) return null;
    if (pos + 1 >= n || isWhitespace(src[pos + 1])) return null;
    const closer = nextValidCloser[pos + 1] ?? NO_CLOSER;
    if (closer === NO_CLOSER) return null;
    if ((poisonPrefix[closer] ?? 0) - (poisonPrefix[pos + 1] ?? 0) > 0) return null;
    if ((backtickPrefix[closer] ?? 0) - (backtickPrefix[pos + 1] ?? 0) > 0) return null;
    const content = src.slice(pos + 1, closer);
    if (/^\{[A-Z_][A-Z0-9_]*(?:\}$|[:-])/.test(content)) return null;
    if (src[closer + 1] === '{' && /^\{[A-Za-z_][A-Za-z0-9_]*(?:[:-][^{}]*)?\}$/.test(content)) return null;
    if (isDigit(charBefore(src, pos)) && isTrailingCurrencySpan(content)) return null;
    if (isCurrencyShaped(src, pos)) {
      if (isConfirmedOpener(closer, content) || isCompositeCurrency(src, closer)) return null;
      if (/\s/.test(content) && /\p{Nd}$/u.test(content) && !/[+\-*/^=_<>|\\¬°-±×÷′-″←-⇿∀-⋿]/.test(content)) {
        return null;
      }
      if (src[closer + 1] === '$' && !/\p{L}/u.test(content) && /[^\p{L}\p{Nd}\s]$/u.test(content)) {
        return null;
      }
    }
    return { content, end: closer + 1 };
  };
}

export function matchInlineMath(
  src: string,
  pos: number,
  prevMatchEnd?: number,
): InlineMathMatch | null {
  return createInlineMathMatcher(src)(pos, prevMatchEnd);
}

interface InlineMathRuleState {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): {
    content: string;
    markup: string;
    raw: string;
    loading: boolean;
  };
}

const matcherCache = new WeakMap<
  InlineMathRuleState,
  { src: string; match: InlineMathMatcher; lastEnd: number }
>();

export function mathInlineRule(state: InlineMathRuleState, silent: boolean): boolean {
  const opener = state.src[state.pos];
  if (opener !== '$' && (opener !== '\\' || state.src[state.pos + 1] !== '(')) return false;
  let entry = matcherCache.get(state);
  if (!entry || entry.src !== state.src) {
    entry = { src: state.src, match: createInlineMathMatcher(state.src), lastEnd: -1 };
    matcherCache.set(state, entry);
  }
  const match = entry.match(state.pos, entry.lastEnd);
  if (!match || match.end > state.posMax) return false;
  entry.lastEnd = match.end;
  if (silent) {
    state.pos = match.end;
    return true;
  }
  const token = state.push('math_inline', 'math', 0);
  token.content = match.content;
  token.markup = opener === '$' ? '$' : '\\(\\)';
  token.raw = state.src.slice(state.pos, match.end);
  token.loading = false;
  state.pos = match.end;
  return true;
}

export function configureMarkdownIt(md: MarkdownIt): MarkdownIt {
  configureTaskListSpacing(md);
  md.set({ typographer: false });
  md.inline.ruler.at('math', mathInlineRule);
  return md;
}
