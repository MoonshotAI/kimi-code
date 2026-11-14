export const ARTEX_STAGNATION_MIN_REPEATS = 3;

export interface StagnationDoneIntent {
  readonly id: number;
  readonly summary: string;
}

export interface StagnationFinding {
  readonly id: number;
}

export interface StagnationDirection {
  readonly direction: string;
  readonly repeats: number;
  readonly since: number;
}

export function normalizeDirection(summary: string): string {
  const collapsed = summary.trim().split(/\s+/).join(' ').toLowerCase();
  let out = '';
  let digit = false;
  for (const ch of collapsed) {
    if (ch >= '0' && ch <= '9') {
      if (!digit) out += '#';
      digit = true;
      continue;
    }
    digit = false;
    out += ch;
  }
  return out;
}

interface DirectionAccumulator {
  firstId: number;
  repeats: number;
  summary: string;
}

export function detectStagnation(
  done: readonly StagnationDoneIntent[],
  findings: readonly StagnationFinding[],
): StagnationDirection[] {
  const dirs = new Map<string, DirectionAccumulator>();
  const order: string[] = [];
  for (const node of done) {
    const summary = node.summary;
    if (summary.trim() === '') continue;
    const fp = normalizeDirection(summary);
    if (fp === '') continue;
    let acc = dirs.get(fp);
    if (acc === undefined) {
      acc = { firstId: node.id, repeats: 0, summary };
      dirs.set(fp, acc);
      order.push(fp);
    }
    if (node.id < acc.firstId) {
      acc.firstId = node.id;
      acc.summary = summary;
    }
    acc.repeats += 1;
  }
  const out: StagnationDirection[] = [];
  for (const fp of order) {
    const acc = dirs.get(fp)!;
    if (acc.repeats < ARTEX_STAGNATION_MIN_REPEATS) continue;
    let produced = false;
    for (const finding of findings) {
      if (finding.id > acc.firstId) {
        produced = true;
        break;
      }
    }
    if (produced) continue;
    out.push({ direction: acc.summary, repeats: acc.repeats, since: acc.firstId });
    if (out.length >= 3) break;
  }
  return out;
}
