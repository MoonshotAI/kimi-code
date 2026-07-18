import en from './apps/kimi-code/src/i18n/locales/en';
import zh from './apps/kimi-code/src/i18n/locales/zh';

type V = string | {[k: string]: V};
function leaves(o: V, p = ''): string[] {
  const r: string[] = [];
  for (const [k, v] of Object.entries(o as any)) {
    const fp = p ? p + '.' + k : k;
    if (typeof v === 'object' && v !== null) r.push(...leaves(v, fp));
    else r.push(fp);
  }
  return r;
}

const enK = leaves(en);
const zhK = leaves(zh);
const enSet = new Set(enK);
const zhSet = new Set(zhK);
const m1 = enK.filter(k => !zhSet.has(k));
const m2 = zhK.filter(k => !enSet.has(k));

console.log('en keys:', enK.length, 'zh keys:', zhK.length);
if (m1.length) console.log('Missing in zh:', m1.join(', '));
if (m2.length) console.log('Missing in en:', m2.join(', '));
if (!m1.length && !m2.length) console.log('All keys match!');