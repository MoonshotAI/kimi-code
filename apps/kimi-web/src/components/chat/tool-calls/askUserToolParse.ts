// Pure parsers for the AskUserQuestion tool card. Kept separate from the SFC so
// the index-zip / id-decode logic is unit-testable without a DOM.
//
// Wire shape (from agent-core SCHEMAS §6.4):
//   tool.arg      : JSON { questions: [{ question, header, options[{label,description}], multi_select }] }
//                   Input questions carry NO id — order === broker order.
//   tool.output[0]: JSON { answers: Record<qid, string|true>, note? }
//                   qid  = `q_<index>`; value = `opt_<q>_<o>` (single),
//                   `opt_<q>_<o>,opt_<q>_<o>` (multi, comma-joined), free-text
//                   (Other), or `opt_…,<text>` (multi+Other). skipped → omitted.
//                   Dismissed → { answers: {}, note }.

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

export interface AskOutput {
  answers: Record<string, string | true>;
  note: string;
}

export interface Resolved {
  /** Option indices picked for this question. */
  selected: Set<number>;
  /** Free-text "Other" segment, when the answer carried one. */
  otherText: string;
  /** The flattened value was the literal `true` — answered, but no concrete
      option to echo back onto the list. */
  indeterminate: boolean;
}

export function parseAskInput(arg: string): AskQuestion[] {
  if (!arg) return [];
  try {
    const obj = JSON.parse(arg) as Record<string, unknown>;
    const raw = obj['questions'];
    if (!Array.isArray(raw)) return [];
    const out: AskQuestion[] = [];
    for (const q of raw) {
      if (!q || typeof q !== 'object') continue;
      const qr = q as Record<string, unknown>;
      const opts: AskOption[] = Array.isArray(qr['options'])
        ? (qr['options'] as unknown[]).map(o => {
            const or = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
            return {
              label: typeof or['label'] === 'string' ? or['label'] : '',
              description: typeof or['description'] === 'string' ? or['description'] : '',
            };
          })
        : [];
      out.push({
        question: typeof qr['question'] === 'string' ? qr['question'] : '',
        header: typeof qr['header'] === 'string' ? qr['header'] : '',
        options: opts,
        multiSelect: qr['multi_select'] === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseAskOutput(output: string[] | undefined): AskOutput {
  const line = output?.[0];
  if (!line) return { answers: {}, note: '' };
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const answers: Record<string, string | true> = {};
    const raw = obj['answers'];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') answers[k] = v;
        else if (v === true) answers[k] = true;
      }
    }
    return {
      answers,
      note: typeof obj['note'] === 'string' ? obj['note'] : '',
    };
  } catch {
    return { answers: {}, note: '' };
  }
}

const OPT_ID = /^opt_\d+_(\d+)$/;

/** Decode one question's flattened answer into picked option indices plus any
 *  free-text "Other" segment. Option ids carry their own index, so this is
 *  exact rather than a label match; non-`opt_` segments are treated as the
 *  Other text (joined back with `,` in case the free text itself contained one). */
export function resolveAnswer(value: string | true | undefined): Resolved {
  if (value === undefined) return { selected: new Set(), otherText: '', indeterminate: false };
  if (value === true) return { selected: new Set(), otherText: '', indeterminate: true };
  const selected = new Set<number>();
  const others: string[] = [];
  for (const seg of value.split(',')) {
    const m = OPT_ID.exec(seg);
    if (m) selected.add(Number(m[1]));
    else if (seg.length > 0) others.push(seg);
  }
  return { selected, otherText: others.join(','), indeterminate: false };
}
